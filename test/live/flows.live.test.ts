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

import { DateTime } from "luxon"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { layoutsFrom } from "../../src/acsm/content.js"
import { offeredTracks } from "../../src/acsm/event-form.js"
import { getAll, parseForm, setAt } from "../../src/acsm/form.js"
import type { AcsmSession } from "../../src/acsm/session.js"
import type { Championship } from "../../src/acsm/types.js"
import { events, session as sessionConfig } from "../../src/acsm/view.js"
import { eventEditPath, eventSubmitPath, importChampionship } from "../../src/acsm/write.js"
import { emitChampionship } from "../../src/emit/championship.js"
import { applyFinalize, EntryListChangedError } from "../../src/finalize/apply.js"
import { readFormat, sameFormat, type RaceFormat } from "../../src/finalize/format.js"
import { planFinalize } from "../../src/finalize/plan.js"
import { practiceMinutesFor } from "../../src/finalize/schedule.js"
import { testProfile } from "../support/build.js"
import {
  assertWouldChange,
  deleteChampionship,
  LIVE,
  liveSession,
  loadFixture,
  SEED,
  seedFormat,
} from "./harness.js"

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

  /**
   * Somewhere else on *this* server to move a round to.
   *
   * Read off the event form rather than named in the test, and that is the
   * whole point: a harness is whatever content somebody installed on it, so a
   * hardcoded `ks_silverstone` is a test that passes on one machine and fails
   * on the next. It did exactly that.
   *
   * Prefers a track with layouts, because `TrackLayout` is the field this
   * feature exists to write and a single-layout track exercises only half of
   * it. Falls back to any other installed track when the server has none —
   * still a real move, still a real write.
   */
  const somewhereElse = async (
    championshipId: string,
    eventId: string,
    from: string,
  ): Promise<{ track: string; layout: string }> => {
    const html = await live().getText(eventEditPath(championshipId, eventId))
    const layouts = layoutsFrom(html) ?? {}
    const offered = [...offeredTracks(html)].filter((t) => t !== from).sort()

    const withLayouts = offered.find((t) => (layouts[t]?.length ?? 0) > 0)
    if (withLayouts) return { track: withLayouts, layout: layouts[withLayouts]?.[0] ?? "" }

    const plain = offered[0]
    if (!plain) {
      throw new Error(
        `This manager offers no track other than ${from}, so there is nowhere to move a round ` +
          `to. That is a harness with no content installed, not a failure of the code under test.`,
      )
    }
    return { track: plain, layout: "" }
  }

  /** A track name this server certainly does not have. */
  const nowhere = async (championshipId: string, eventId: string): Promise<string> => {
    const offered = offeredTracks(await live().getText(eventEditPath(championshipId, eventId)))
    for (let i = 0; ; i++) {
      const name = `champctl_no_such_track_${i}`
      if (!offered.has(name)) return name
    }
  }

  const importFixture = async (
    source: Championship,
  ): Promise<{ id: string; export: Championship }> => {
    const { championshipId } = await importChampionship(live(), source)

    // Registered for teardown *before* the check, not after. If the redirect
    // doesn't parse — exactly what the check is here to catch — the
    // championship still exists on the server, and registering afterwards left
    // the one case worth cleaning up as the one that leaked.
    if (championshipId) created.push(championshipId)
    if (!championshipId) {
      throw new Error(
        "Import did not redirect to a new championship, so there is no id to work with. " +
          "It may still have been created — check the container.",
      )
    }

    const exported = await live().getJson<Championship>(`/championship/${championshipId}/export`)
    return { id: championshipId, export: exported }
  }

  /**
   * The first event's id, or a failure that says the fixture is at fault.
   *
   * `as string` here turned a bad seed into `undefined` flowing into a URL, and
   * a confusing 404 several lines later instead of "the fixture has no event".
   */
  const firstEventId = (champ: Championship): string => {
    const id = events(champ)[0]?.ID
    if (!id) {
      throw new Error(
        "The seed export has no first event with an ID, so this test has nothing to drive. " +
          "The fixture is wrong, not the code under test.",
      )
    }
    return id
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

    /**
     * The format above has to differ from what the seed already races, or
     * every apply below returns early and the assertions that follow pass for
     * the absence of the write they exist to check. 17 differs today; this is
     * here so that an edit to the fixture says so rather than quietly turning
     * these into tests of nothing.
     */
    it("asks for a format the seed does not already have", async () => {
      expect(sameFormat(await seedFormat(), wanted)).toBe(false)
    })

    it("lands the format it previewed", async () => {
      const { id, export: champ } = await seeded()
      const eventId = firstEventId(champ)

      const plan = await planFinalize(live(), {
        championship: champ,
        championshipId: id,
        eventId,
        format: wanted,
        profile: PROFILE,
      })
      expect(
        plan.formChanges.length,
        "the seed should differ from what we asked for",
      ).toBeGreaterThan(0)

      assertWouldChange(plan, "the finalize under test")
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
      const eventId = firstEventId(champ)

      const plan = await planFinalize(live(), {
        championship: champ,
        championshipId: id,
        eventId,
        format: { ...wanted, length: { kind: "laps", laps: 13 } },
        profile: PROFILE,
      })
      assertWouldChange(plan, "the finalize under test")
      await applyFinalize(live(), plan, { acknowledgeWarnings: true })

      const after = await live().getJson<Championship>(`/championship/${id}/export`)
      const race = sessionConfig(events(after)[0]!, "Race")
      expect(race?.Laps).toBe(13)
      // And the other half of the decision was zeroed.
      expect(race?.Time ?? 0).toBe(0)
    }, 60_000)

    /**
     * The sharpest failure this suite has caught, and the reason it exists.
     *
     * ACSM rewrites every checkbox to an explicit "1"/"0" in a submit handler,
     * so its Go side reads the browser's "on" as false. champctl echoed the
     * form back the way a browser would, `Race.Enabled=on` came back false, and
     * a single finalize took the event from three sessions to none — while
     * `applyFinalize` reported `eventSaved: true`. Nothing in 300-odd unit
     * tests against a scripted fetch could see it.
     *
     * Asserts the sessions and their contents, not just the count: dropping the
     * practice length while keeping the key would be the same class of bug.
     */
    it("keeps every session, rather than turning them off by echoing 'on'", async () => {
      const { id, export: champ } = await seeded()
      const eventId = firstEventId(champ)
      const before = events(champ)[0]!

      const plan = await planFinalize(live(), {
        championship: champ,
        championshipId: id,
        eventId,
        format: wanted,
        profile: PROFILE,
      })
      assertWouldChange(plan, "the finalize under test")
      await applyFinalize(live(), plan, { acknowledgeWarnings: true })

      const after = events(await live().getJson<Championship>(`/championship/${id}/export`))[0]!

      expect(
        Object.keys(after.RaceSetup?.Sessions ?? {}).sort(),
        "a finalize must not drop sessions",
      ).toEqual(Object.keys(before.RaceSetup?.Sessions ?? {}).sort())

      // The lengths champctl was not asked to change survive untouched.
      expect(sessionConfig(after, "Practice")?.Time).toBe(sessionConfig(before, "Practice")?.Time)
      expect(sessionConfig(after, "Qualifying")?.Time).toBe(
        sessionConfig(before, "Qualifying")?.Time,
      )
    }, 60_000)

    /**
     * The assertion this suite exists for, and the one it was missing.
     *
     * ACSM renders `TrackLayout` as a select of every track's layouts with
     * nothing marked `selected`, so a browser-correct round-trip posts the
     * first option — a layout belonging to some other track. Every finalize
     * champctl ran moved the round's layout, and no scripted-fetch test could
     * have seen it: the fixture rendered a select that submits `""` under any
     * reading. Only a real manager's HTML has the shape that breaks.
     */
    it("leaves the track and layout exactly as they were", async () => {
      const { id, export: champ } = await seeded()
      const eventId = firstEventId(champ)
      const before = events(champ)[0]!.RaceSetup

      const plan = await planFinalize(live(), {
        championship: champ,
        championshipId: id,
        eventId,
        format: wanted,
        profile: PROFILE,
      })
      assertWouldChange(plan, "the finalize under test")
      await applyFinalize(live(), plan, { acknowledgeWarnings: true })

      const after = events(await live().getJson<Championship>(`/championship/${id}/export`))[0]!
      expect(after.RaceSetup?.Track, "a finalize is about laps").toBe(before?.Track)
      expect(after.RaceSetup?.TrackLayout, "a finalize is about laps").toBe(before?.TrackLayout)
    }, 60_000)

    /**
     * The repair, end to end, on a real manager.
     *
     * This is the state BATL is in on rounds champctl has already touched:
     * a layout belonging to another track, which ACSM stores without complaint
     * and cannot render. Nothing but writing `TrackLayout` fixes it, and until
     * now nothing could write it.
     */
    it("moves a round to another track and layout", async () => {
      const { id, export: champ } = await seeded()
      const eventId = firstEventId(champ)

      const target = await somewhereElse(
        id,
        eventId,
        (events(champ)[0]?.RaceSetup?.Track ?? "").trim(),
      )

      const plan = await planFinalize(live(), {
        championship: champ,
        championshipId: id,
        eventId,
        format: await seedFormat(),
        profile: PROFILE,
        venue: target,
      })
      expect(plan.venue?.to).toEqual(target)
      await applyFinalize(live(), plan, { acknowledgeWarnings: true })

      const after = events(await live().getJson<Championship>(`/championship/${id}/export`))[0]!
      expect(after.RaceSetup?.Track).toBe(target.track)
      expect(after.RaceSetup?.TrackLayout, "the layout ACSM stored").toBe(target.layout)
    }, 60_000)

    /**
     * A track this server doesn't have. ACSM's form cannot express it, so
     * every payload champctl could send lands somewhere else — refusing is the
     * only answer that doesn't move a race without being asked.
     */
    it("refuses to move a round to a track that isn't installed", async () => {
      const { id, export: champ } = await seeded()
      const eventId = firstEventId(champ)
      const err = await planFinalize(live(), {
        championship: champ,
        championshipId: id,
        eventId,
        format: await seedFormat(),
        profile: PROFILE,
        // Checked against the form rather than assumed: a name this test picks
        // out of the air could be a mod track somebody has installed, and then
        // this would pass for the wrong reason.
        venue: { track: await nowhere(id, eventId), layout: "" },
      }).catch((e: unknown) => e)

      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toMatch(/isn't installed/)
    }, 60_000)

    it("keeps every entrant, with their own car and skin", async () => {
      // The whole reason the write round-trips the form. A save that quietly
      // drops entrants, or hands one person another's car, is the failure mode
      // that matters.
      //
      // Compared as a set keyed by GUID, and without PitBox. Both builds render
      // the entrants in a different order on every request and renumber pit
      // boxes by render position, so a deep-equal on the whole EntryList was
      // asserting two things ACSM does not offer and BATL does not rely on —
      // and it failed for those rather than for anything about entrants. See
      // docs/acsm-2.4.15.md §5.
      const { id, export: champ } = await seeded()
      const eventId = firstEventId(champ)
      const identity = (list: Record<string, Record<string, unknown>> | undefined) =>
        Object.values(list ?? {})
          .map((e) => ({ GUID: e["GUID"], Name: e["Name"], Model: e["Model"], Skin: e["Skin"] }))
          .sort((a, b) => String(a.GUID).localeCompare(String(b.GUID)))
      const before = identity(events(champ)[0]?.EntryList)

      const plan = await planFinalize(live(), {
        championship: champ,
        championshipId: id,
        eventId,
        format: wanted,
        profile: PROFILE,
      })
      assertWouldChange(plan, "the finalize under test")
      await applyFinalize(live(), plan, { acknowledgeWarnings: true })

      const after = await live().getJson<Championship>(`/championship/${id}/export`)
      expect(identity(events(after)[0]?.EntryList)).toEqual(before)
    }, 60_000)

    it("refuses the write when the entry list changed underneath it", async () => {
      // Plan §5.3, and the sharpest edge in the tool. Someone approves a
      // sign-up in ACSM while a preview is open; the save would silently
      // delete them.
      const { id, export: champ } = await seeded()
      const eventId = firstEventId(champ)

      const plan = await planFinalize(live(), {
        championship: champ,
        championshipId: id,
        eventId,
        format: wanted,
        profile: PROFILE,
      })

      // Now change the entry list behind the plan's back, exactly as another
      // admin would: fetch the same form, change an entrant, post it.
      //
      // Ballast rather than Name. The championship event form renders Name,
      // Team and GUID readonly and ACSM ignores them on save, so renaming an
      // entrant here changed nothing at all — the guard then correctly did not
      // fire, and this test failed for the meddling not working rather than for
      // the guard being wrong. Ballast is per-entrant, writable, and in the
      // fingerprint.
      const path = eventEditPath(id, eventId)
      const form = parseForm(await live().getText(path), { pageUrl: live().url(path) })
      const meddled = [...form.fields]
      setAt(meddled, "EntryList.Ballast", 0, "42")
      const meddledGuid = getAll(meddled, "EntryList.GUID")[0]!
      await live().postForm(eventSubmitPath(id), meddled)

      // Confirm the meddling actually took, so a no-op cannot pass as a pass.
      const meddledNow = await live().getJson<Championship>(`/championship/${id}/export`)
      const ballastOf = (c: Championship, guid: string) =>
        Object.values(events(c)[0]?.EntryList ?? {}).find((e) => e.GUID === guid)?.Ballast
      expect(ballastOf(meddledNow, meddledGuid), "the meddling must have landed").toBe(42)

      await expect(
        applyFinalize(live(), plan, { acknowledgeWarnings: true }),
      ).rejects.toBeInstanceOf(EntryListChangedError)

      // And nothing was written: the meddled value is still there, unchanged.
      const after = await live().getJson<Championship>(`/championship/${id}/export`)
      expect(ballastOf(after, meddledGuid)).toBe(42)
      expect(readFormat(events(after)[0]!)).not.toEqual(wanted)
    }, 60_000)

    it("moves quali through the schedule endpoint, a second request", async () => {
      // The event submit form does not carry Scheduled (plan §5.2), so this
      // proves the separate POST works rather than silently doing nothing.
      const { id, export: champ } = await seeded()
      const eventId = firstEventId(champ)

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

      // Scheduled is practice start: 20:00 quali minus the practice length.
      // The expected instant is derived in the league's zone rather than
      // written as a fixed offset. Hard-coding -07:00 was wrong twice over: US
      // DST starts on 14 March in 2027, so this date is PST (-08:00) and the
      // assertion was an hour out — and a test for zone-based scheduling that
      // hard-codes an offset cannot fail for the reason it exists.
      const expected = DateTime.fromISO("2027-03-10T20:00", {
        zone: PROFILE.schedule.timezone,
      }).minus({ minutes: practiceMinutesFor(events(champ)[0]!, PROFILE.schedule.practiceMinutes) })
      expect(expected.isValid).toBe(true)
      expect(scheduled).toContain("2027-03-10")
      expect(DateTime.fromISO(scheduled).toMillis()).toBe(expected.toMillis())
    }, 60_000)
  })

  // -------------------------------------------------------------------------
  // Emit (plan §4.1, §5.1)
  // -------------------------------------------------------------------------

  describe("championship emitter", () => {
    it("produces a championship ACSM accepts, and it comes back intact", async () => {
      // The first end-to-end proof that the emitter's output is importable.
      const template = await loadFixture(SEED)
      const { championship: emitted, grid } = emitChampionship({
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

      const { export: exported } = await importFixture(emitted)

      expect(exported.Name).toBe(emitted.Name)
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

    it("emits a championship with no results, so the import safety rails stay quiet", async () => {
      const template = await loadFixture(SEED)
      const { championship: emitted } = emitChampionship({
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

      const { export: exported } = await importFixture(emitted)
      for (const ev of events(exported)) {
        expect(ev.StartedTime ?? "0001-01-01T00:00:00Z").toBe("0001-01-01T00:00:00Z")
      }
    }, 60_000)
  })
})
