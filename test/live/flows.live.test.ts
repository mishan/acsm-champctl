/**
 * The phase 3 and phase 4 flows, end to end against the Docker harness.
 *
 *   npm run harness:up
 *   set -a && . docker/.env && set +a
 *   npm run test:live
 *
 * `acsm.live.test.ts` covers the write-path *primitives* — form parsing,
 * read-modify-write, ragged refusal, import safety. This file covers the two
 * flows built on top of them, which until now had 300-odd unit tests against a
 * scripted `fetch` and had never touched a real ACSM.
 *
 * The three things worth proving here are the ones a scripted fetch cannot:
 * that a real form round-trips through `applyFinalize` and the values actually
 * land, that the schedule really is a second endpoint, and that the
 * stale-entry-list guard fires against a list changed by someone else.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { getAll, parseForm, setAt } from "../../src/acsm/form.js"
import type { AcsmSession } from "../../src/acsm/session.js"
import type { Championship } from "../../src/acsm/types.js"
import { events, session as sessionConfig } from "../../src/acsm/view.js"
import { eventEditPath, eventSubmitPath, importChampionship } from "../../src/acsm/write.js"
import { emitMonth } from "../../src/emit/month.js"
import { applyFinalize, EntryListChangedError } from "../../src/finalize/apply.js"
import { readFormat, type RaceFormat } from "../../src/finalize/format.js"
import { planFinalize } from "../../src/finalize/plan.js"
import { testProfile } from "../support/build.js"
import { LIVE, SEED, deleteChampionship, liveSession, loadFixture } from "./harness.js"

const PROFILE = testProfile()

describe.skipIf(!LIVE)("champctl flows against a real ACSM", () => {
  // Optional, because vitest still runs afterAll when beforeAll throws. Typed
  // as always-present, the cleanup loop would then fail on an undefined
  // session and bury the real error — the one that says why the harness
  // wasn't reachable — under a TypeError from the teardown.
  let session: AcsmSession | undefined
  const created: string[] = []

  beforeAll(async () => {
    session = await liveSession()
  }, 60_000)

  afterAll(async () => {
    if (!session) return
    // These are championships this file created on a throwaway container, so
    // a failure to delete one must not stop the others being cleaned up.
    for (const id of created) {
      try {
        await deleteChampionship(live(), id)
      } catch (e) {
        console.warn(`could not delete ${id}: ${e instanceof Error ? e.message : e}`)
      }
    }
  })

  /** The session, once beforeAll has run. Narrows the optional for the tests. */
  const live = (): AcsmSession => {
    if (!session) throw new Error("no live session; beforeAll did not complete")
    return session
  }

  const importFixture = async (source: Championship): Promise<{ id: string; export: Championship }> => {
    const { championshipId } = await importChampionship(live(), source)
    expect(championshipId, "import should redirect to the new championship").toBeTruthy()
    created.push(championshipId as string)
    const exported = await live().getJson<Championship>(
      `/championship/${championshipId}/export`,
    )
    return { id: championshipId as string, export: exported }
  }

  const seeded = async () => importFixture(await loadFixture(SEED))

  // -------------------------------------------------------------------------
  // Finalize (plan §5.2)
  // -------------------------------------------------------------------------

  describe("finalize", () => {
    const wanted: RaceFormat = {
      length: { kind: "laps", laps: 17 },
      reversedGridPositions: 4,
      mandatoryPit: true,
      extraLap: false,
    }

    it("lands the format it previewed", async () => {
      const { id, export: champ } = await seeded()
      const eventId = events(champ)[0]?.ID as string

      const plan = await planFinalize(live(), {
        championship: champ,
        championshipId: id,
        eventId,
        format: wanted,
        profile: PROFILE,
      })
      expect(plan.formChanges.length, "the seed should differ from what we asked for").toBeGreaterThan(0)

      await applyFinalize(live(), plan, { acknowledgeWarnings: true })

      // Read it back from ACSM rather than trusting the POST's redirect.
      const after = await live().getJson<Championship>(`/championship/${id}/export`)
      const ev = events(after)[0]
      expect(readFormat(ev!)).toEqual(wanted)
    }, 60_000)

    it("writes the race length where ACSM actually reads it", async () => {
      // The form says Race.Laps; the export says Sessions.RACE.Laps. This is
      // the seam a scripted fetch can't check.
      const { id, export: champ } = await seeded()
      const eventId = events(champ)[0]?.ID as string

      const plan = await planFinalize(live(), {
        championship: champ,
        championshipId: id,
        eventId,
        format: { ...wanted, length: { kind: "laps", laps: 13 } },
        profile: PROFILE,
      })
      await applyFinalize(live(), plan, { acknowledgeWarnings: true })

      const after = await live().getJson<Championship>(`/championship/${id}/export`)
      const race = sessionConfig(events(after)[0]!, "Race")
      expect(race?.Laps).toBe(13)
      // And the other half of the decision was zeroed.
      expect(race?.Time ?? 0).toBe(0)
    }, 60_000)

    it("leaves the entry list exactly as it found it", async () => {
      // The whole reason the write round-trips the form. A save that quietly
      // reshuffles or drops entrants is the failure mode that matters.
      const { id, export: champ } = await seeded()
      const eventId = events(champ)[0]?.ID as string
      const before = events(champ)[0]?.EntryList

      const plan = await planFinalize(live(), {
        championship: champ,
        championshipId: id,
        eventId,
        format: wanted,
        profile: PROFILE,
      })
      await applyFinalize(live(), plan, { acknowledgeWarnings: true })

      const after = await live().getJson<Championship>(`/championship/${id}/export`)
      expect(events(after)[0]?.EntryList).toEqual(before)
    }, 60_000)

    it("refuses the write when the entry list changed underneath it", async () => {
      // Plan §5.3, and the sharpest edge in the tool. Someone approves a
      // sign-up in ACSM while a preview is open; the save would silently
      // delete them.
      const { id, export: champ } = await seeded()
      const eventId = events(champ)[0]?.ID as string

      const plan = await planFinalize(live(), {
        championship: champ,
        championshipId: id,
        eventId,
        format: wanted,
        profile: PROFILE,
      })

      // Now change the entry list behind the plan's back, exactly as another
      // admin would: fetch the same form, rename an entrant, post it.
      const path = eventEditPath(id, eventId)
      const form = parseForm(await live().getText(path), { pageUrl: live().url(path) })
      const meddled = [...form.fields]
      setAt(meddled, "EntryList.Name", 0, "Someone Else")
      await live().postForm(eventSubmitPath(id), meddled)

      await expect(applyFinalize(live(), plan, { acknowledgeWarnings: true })).rejects.toBeInstanceOf(
        EntryListChangedError,
      )

      // And nothing was written: the meddled name is still there, unchanged.
      const after = await live().getJson<Championship>(`/championship/${id}/export`)
      const names = getAll(
        parseForm(await live().getText(path), { pageUrl: live().url(path) }).fields,
        "EntryList.Name",
      )
      expect(names[0]).toBe("Someone Else")
      expect(readFormat(events(after)[0]!)).not.toEqual(wanted)
    }, 60_000)

    it("moves quali through the schedule endpoint, a second request", async () => {
      // The event submit form does not carry Scheduled (plan §5.2), so this
      // proves the separate POST works rather than silently doing nothing.
      const { id, export: champ } = await seeded()
      const eventId = events(champ)[0]?.ID as string

      const plan = await planFinalize(live(), {
        championship: champ,
        championshipId: id,
        eventId,
        format: readFormat(events(champ)[0]!),
        qualiStart: { date: "2027-03-10", time: "20:00" },
        profile: PROFILE,
      })
      expect(plan.schedule, "asking for a new quali time should plan a schedule save").toBeTruthy()

      const result = await applyFinalize(live(), plan, { acknowledgeWarnings: true })
      expect(result.scheduleSaved).toBe(true)

      const after = await live().getJson<Championship>(`/championship/${id}/export`)
      const scheduled = events(after)[0]?.Scheduled ?? ""
      // Scheduled is practice start: 20:00 quali minus 60 minutes of practice.
      expect(scheduled).toContain("2027-03-10")
      expect(new Date(scheduled).getUTCHours()).toBe(
        new Date("2027-03-10T19:00:00-07:00").getUTCHours(),
      )
    }, 60_000)
  })

  // -------------------------------------------------------------------------
  // Emit (plan §4.1, §5.1)
  // -------------------------------------------------------------------------

  describe("month emitter", () => {
    it("produces a championship ACSM accepts, and it comes back intact", async () => {
      // The first end-to-end proof that the emitter's output is importable.
      const template = await loadFixture(SEED)
      const { championship: month, grid } = emitMonth({
        template,
        profile: PROFILE,
        spec: {
          name: `champctl live ${Date.now()}`,
          cars: ["rss_formula_hybrid_2021"],
          rounds: [{ track: "spa" }, { track: "suzuka" }],
          startDate: "2027-03-03",
          entryListSlots: 6,
        },
      })

      const { export: exported } = await importFixture(month)

      expect(exported.Name).toBe(month.Name)
      expect(events(exported)).toHaveLength(2)
      expect(events(exported).map((e) => e.RaceSetup?.Track)).toEqual(["spa", "suzuka"])
      // No pit table configured here, so the cap is unknown rather than wrong.
      expect(grid.maxClients).toBe(0)

      // The entry list survived at the sentinel model, which is what lets
      // sign-ups resolve it later (plan §4.4).
      const first = events(exported)[0]
      const models = Object.values(first?.EntryList ?? {}).map((e) => e.Model)
      expect(models).toHaveLength(6)
      expect(new Set(models)).toEqual(new Set(["any_car_model"]))
    }, 60_000)

    it("emits a month with no results, so the import safety rails stay quiet", async () => {
      const template = await loadFixture(SEED)
      const { championship: month } = emitMonth({
        template,
        profile: PROFILE,
        spec: {
          name: `champctl live noresults ${Date.now()}`,
          cars: ["rss_formula_hybrid_2021"],
          rounds: [{ track: "spa" }],
          startDate: "2027-03-03",
          entryListSlots: 2,
        },
      })

      const { export: exported } = await importFixture(month)
      for (const ev of events(exported)) {
        expect(ev.StartedTime ?? "0001-01-01T00:00:00Z").toBe("0001-01-01T00:00:00Z")
      }
    }, 60_000)
  })
})
