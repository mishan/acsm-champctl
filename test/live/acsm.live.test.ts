/**
 * Live tests against the Docker harness (docker/README.md).
 *
 *   cd docker && docker compose up -d
 *   set -a && . docker/.env && set +a
 *   npm run test:live
 *
 * These are the assertions that turn the plan's "[verify]" markers into
 * something CI can answer. Each one names the plan section it settles.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { HttpAcsmReader } from "../../src/acsm/client.js"
import { IMPORT_HOUSEKEEPING, diff, formatChanges } from "../../src/acsm/diff.js"
import { count, findFormByAction, getAll, setAt, setOne } from "../../src/acsm/form.js"
import type { AcsmSession } from "../../src/acsm/session.js"
import type { Championship } from "../../src/acsm/types.js"
import { events, slots } from "../../src/acsm/view.js"
import {
  eventEditPath,
  eventSubmitPath,
  exportPath,
  importChampionship,
} from "../../src/acsm/write.js"
import { check } from "../../src/gridmom/index.js"
import { testProfile } from "../support/build.js"
import {
  LIVE,
  SEED,
  SEED_DUPLICATE_PITBOXES,
  deleteChampionship,
  liveConfig,
  liveSession,
  loadFixture,
} from "./harness.js"

describe.skipIf(!LIVE)("ACSM harness", () => {
  let session: AcsmSession
  const created: string[] = []

  beforeAll(async () => {
    session = await liveSession()
  }, 60_000)

  afterAll(async () => {
    for (const id of created) await deleteChampionship(session, id)
  })

  const importSeed = async (fixture = SEED): Promise<{ id: string; sent: Championship }> => {
    const source = await loadFixture(fixture)
    const { championshipId, sent } = await importChampionship(session, source)
    expect(championshipId, "import should redirect to the new championship").toBeTruthy()
    created.push(championshipId!)
    return { id: championshipId!, sent }
  }

  it("answers /healthcheck.json without credentials", async () => {
    const reader = new HttpAcsmReader({ baseUrl: liveConfig()!.baseUrl, rateLimit: false })
    await expect(reader.healthcheck()).resolves.toBeDefined()
  })

  it("serves the championship export to a logged-in session", async () => {
    const { id } = await importSeed()
    const exported = await session.getJson<Championship>(exportPath(id))
    expect(exported.ID).toBe(id)
    expect(events(exported)).toHaveLength(2)
  })

  // -------------------------------------------------------------- plan §5.4
  describe("round trip", () => {
    it("returns what was sent, modulo housekeeping", async () => {
      const { id, sent } = await importSeed()
      const returned = await session.getJson<Championship>(exportPath(id))
      const changes = diff(sent, returned, { ignore: IMPORT_HOUSEKEEPING })

      // What this test is for is a value ACSM *rewrote* — a field sent as one
      // thing and returned as another, which is how a setting gets silently
      // changed underneath a league (plan §5.4). Fields the build adds with
      // zero values, or drops because its struct has no such field, are schema
      // drift between the fixture and the manager, not that.
      //
      // Asserting on all three together made this test unrunnable anywhere but
      // the exact build the fixture was captured from: against 2.4.15 the
      // synthetic seed produces 514 differences, of which 512 are 2.4.15
      // knowing about CSPCarFlags, VIP, IsPlaceHolder and friends. Drowning the
      // two that matter in 512 that don't is how a real rewrite goes unnoticed.
      const drift = changes.filter((c) => c.kind !== "changed")
      if (drift.length > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `Round-trip schema drift on this build (${drift.length} fields added or dropped):\n` +
            formatChanges(drift.slice(0, 12)),
        )
      }

      // Go re-serialises a timestamp without the trailing zero in its
      // fractional seconds — "…57.790Z" comes back as "…57.79Z" — so a
      // string comparison reports a change about one run in ten, whenever the
      // millisecond happens to end in zero. Same instant, different spelling,
      // and a test that fails one time in ten is a test people learn to
      // re-run. Compared as instants; anything that isn't a valid date on both
      // sides stays a change.
      const sameInstant = (c: { before?: unknown; after?: unknown }): boolean => {
        if (typeof c.before !== "string" || typeof c.after !== "string") return false
        const a = Date.parse(c.before)
        const b = Date.parse(c.after)
        return Number.isFinite(a) && Number.isFinite(b) && a === b
      }

      const rewritten = changes.filter((c) => c.kind === "changed" && !sameInstant(c))
      if (rewritten.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`Round-trip differences:\n${formatChanges(rewritten)}`)
      }
      // Not asserted empty: the plan expects PracticeEntryListType to be
      // rewritten 2 -> 1 and that must stay visible until it's understood.
      const unexpected = rewritten.filter((c) => c.path !== "PracticeEntryListType")
      expect(unexpected, formatChanges(unexpected)).toEqual([])
    })

    it("preserves UUIDs exactly, which is why fresh IDs are mandatory", async () => {
      const { id, sent } = await importSeed()
      expect(id).toBe(sent.ID)
    })
  })

  // -------------------------------------------------------------- plan §3.2
  describe("event edit form", () => {
    it("renders every EntryList key the same number of times", async () => {
      const { id } = await importSeed()
      const exported = await session.getJson<Championship>(exportPath(id))
      const eventId = events(exported)[0]!.ID!

      const form = await session.getForm(eventEditPath(id, eventId))
      const entrants = count(form.fields, "EntryList.Name")
      expect(entrants).toBeGreaterThan(0)

      for (const key of ["EntryList.GUID", "EntryList.Car", "EntryList.Skin"]) {
        expect(count(form.fields, key), `${key} must be a parallel array`).toBe(entrants)
      }
    })

    /**
     * The headline unknown. If EntrantID isn't rendered, ACSM sets PitBox to
     * the list index on save and BATL's assignments get renumbered — see
     * docs/acsm-write-path.md §2. Recorded either way rather than asserted,
     * because both answers are legitimate and version-dependent.
     */
    it("records whether EntryList.EntrantID is rendered", async () => {
      const { id } = await importSeed()
      const exported = await session.getJson<Championship>(exportPath(id))
      const eventId = events(exported)[0]!.ID!
      const form = await session.getForm(eventEditPath(id, eventId))

      const rendered = count(form.fields, "EntryList.EntrantID")
      const entrants = count(form.fields, "EntryList.Name")
      // eslint-disable-next-line no-console
      console.log(
        rendered > 0
          ? `EntryList.EntrantID rendered ${rendered}/${entrants} — pit boxes round-trip.`
          : `EntryList.EntrantID NOT rendered — saving this form renumbers pit boxes 0..${entrants - 1}.`,
      )
      expect(rendered === 0 || rendered === entrants).toBe(true)
    })

    it("keeps the entry list intact across a read-modify-write", async () => {
      // The property the whole write path rests on: change one field, and
      // nothing else moves.
      const { id } = await importSeed()
      const before = await session.getJson<Championship>(exportPath(id))
      const eventId = events(before)[0]!.ID!
      const entrantsBefore = slots(events(before)[0]!.EntryList).length

      const form = await session.getForm(eventEditPath(id, eventId))
      const fields = [...form.fields]
      setOne(fields, "Editing", eventId)
      setOne(fields, "action", "saveChampionship")
      setOne(fields, "Sessions.Race.Laps", "18")

      await session.postForm(eventSubmitPath(id), fields)

      const after = await session.getJson<Championship>(exportPath(id))
      const entrantsAfter = slots(events(after)[0]!.EntryList).length
      expect(entrantsAfter, "a form save must not delete entrants").toBe(entrantsBefore)
    })

    it("writes back a changed pit box when EntrantID is available", async () => {
      const { id } = await importSeed()
      const exported = await session.getJson<Championship>(exportPath(id))
      const eventId = events(exported)[0]!.ID!
      const form = await session.getForm(eventEditPath(id, eventId))

      if (count(form.fields, "EntryList.EntrantID") === 0) {
        // eslint-disable-next-line no-console
        console.log("Skipping: this build doesn't render EntryList.EntrantID.")
        return
      }

      const fields = [...form.fields]
      setOne(fields, "Editing", eventId)
      setOne(fields, "action", "saveChampionship")

      // Swap two of the rendered values rather than inventing a number.
      //
      // This asked for pit box 25 on a six-entrant championship and expected it
      // back. 2.4.15 does not honour an out-of-range box — measured — so the
      // test failed while the mechanism it was written to check works fine. A
      // swap stays inside whatever range this build allows, which means a
      // failure here is about EntrantID not being honoured rather than about
      // the number 25.
      const before = getAll(fields, "EntryList.EntrantID")
      expect(before.length, "need two entrants to swap").toBeGreaterThanOrEqual(2)
      setAt(fields, "EntryList.EntrantID", 0, before[1]!)
      setAt(fields, "EntryList.EntrantID", 1, before[0]!)

      const namesInFormOrder = getAll(fields, "EntryList.Name")
      await session.postForm(eventSubmitPath(id), fields)

      const after = await session.getJson<Championship>(exportPath(id))
      const boxByName = new Map(
        slots(events(after)[0]!.EntryList).map((s) => [s.entrant.Name, s.entrant.PitBox]),
      )
      expect(boxByName.get(namesInFormOrder[0]!)).toBe(Number(before[1]))
      expect(boxByName.get(namesInFormOrder[1]!)).toBe(Number(before[0]))
    })
  })

  // -------------------------------------------------------------- plan §6.1
  describe("duplicate pit boxes", () => {
    /**
     * `AddInPitBox` overwrites, so if import routes through it, two entrants
     * sharing a pit box means one is silently deleted. That decides how urgent
     * gridmom's ERROR is.
     */
    it("records whether a duplicate pit box loses an entrant", async () => {
      const { id, sent } = await importSeed(SEED_DUPLICATE_PITBOXES)
      const returned = await session.getJson<Championship>(exportPath(id))

      const sentCount = slots(events(sent)[0]!.EntryList).length
      const returnedCount = slots(events(returned)[0]!.EntryList).length

      // eslint-disable-next-line no-console
      console.log(
        returnedCount < sentCount
          ? `Duplicate pit boxes DELETE entrants: sent ${sentCount}, got back ${returnedCount}.`
          : `All ${returnedCount} entrants survived; import doesn't go through AddInPitBox.`,
      )
      expect(returnedCount).toBeLessThanOrEqual(sentCount)
    })

    it("gridmom flags the fixture before it is ever imported", async () => {
      const source = await loadFixture(SEED_DUPLICATE_PITBOXES)
      const report = check(source, testProfile(), { now: new Date() })
      expect(report.findings.map((f) => f.code)).toContain("entry.duplicate-pit-box")
      expect(report.ok).toBe(false)
    })
  })

  // -------------------------------------------------------------- plan §3.2
  describe("safety rails", () => {
    it("refuses to import over a championship that has results", async () => {
      const source = await loadFixture(SEED)
      const withResults: Championship = {
        ...source,
        Events: (source.Events ?? []).map((ev, i) =>
          i === 0 ? { ...ev, StartedTime: "2027-03-03T19:05:00-08:00" } : ev,
        ),
      }
      await expect(importChampionship(session, withResults)).rejects.toThrow(/already has results/)
    })

    it("refuses to POST a ragged entry list", async () => {
      const { id } = await importSeed()
      const exported = await session.getJson<Championship>(exportPath(id))
      const eventId = events(exported)[0]!.ID!
      const form = await session.getForm(eventEditPath(id, eventId))

      const fields = [...form.fields]
      const i = fields.findIndex((f) => f.name === "EntryList.GUID")
      // splice(-1, 1) drops the *last* field, which would still be a ragged
      // payload and would still be refused — so the test would pass while
      // testing something other than what it says.
      expect(i, "the event form should render EntryList.GUID").toBeGreaterThanOrEqual(0)
      fields.splice(i, 1)

      await expect(session.postForm(eventSubmitPath(id), fields)).rejects.toThrow(/don't line up/)
    })
  })

  // -------------------------------------------------------------- plan §3.1
  describe("premium-only endpoints", () => {
    it("reports whether this build has the list endpoint", async () => {
      const reader = new HttpAcsmReader({ baseUrl: liveConfig()!.baseUrl, rateLimit: false })
      try {
        const list = await reader.listChampionships()
        // eslint-disable-next-line no-console
        console.log(`/api/championships/list.json present — ${list.length} championships.`)
        expect(Array.isArray(list)).toBe(true)
      } catch (e) {
        // eslint-disable-next-line no-console
        console.log(
          `/api/championships/list.json unavailable on this build: ${
            e instanceof Error ? e.message : String(e)
          }`,
        )
      }
    })
  })

  /**
   * Both shapes are legitimate, so this asserts they *agree* rather than
   * asserting one of them: 1.7.9 renders a `<textarea name="import">` and posts
   * urlencoded, 2.4.x a file input and posts multipart. Pinning multipart made
   * this the one test in the file that could not pass on the public build, and
   * it would have been pinning the wrong answer for the majority of leagues.
   *
   * The pairing is what matters — a file input on a urlencoded form, or a
   * textarea on a multipart one, is a page champctl would send the wrong body
   * to. `detectImportMechanism` reads the same page to decide, and this is the
   * assertion that its two answers stay the only two.
   */
  it("agrees with itself about how this build takes an import", async () => {
    const html = await session.getText("/championship/import")
    // By action, not by position. `parseForm` takes the *first* form on the
    // page, and on every ACSM page that is the navbar search form — docs §9,
    // and test/form.test.ts pins it. So this asserted the search form's enctype
    // and would have gone on passing if the import form vanished entirely.
    const form = findFormByAction(html, "/championship/import", {
      pageUrl: session.url("/championship/import"),
    })
    expect(form, "import page should have a form posting to /championship/import").toBeTruthy()

    const fileInput = /<input[^>]*type=["']file["'][^>]*>/i.exec(html)
    const textarea = /<textarea[^>]*name=["']([^"']+)["'][^>]*>/i.exec(html)

    if (fileInput) {
      expect(form?.enctype, "a file part needs a multipart form").toBe("multipart/form-data")
      // eslint-disable-next-line no-console
      console.log(`Import: file field ${/name=["']([^"']+)["']/i.exec(fileInput[0])?.[1]}`)
    } else {
      expect(textarea, "a build with no file input must paste into a textarea").toBeTruthy()
      expect(form?.enctype, "a textarea posts urlencoded").not.toBe("multipart/form-data")
      // eslint-disable-next-line no-console
      console.log(`Import: textarea ${textarea?.[1]}`)
    }
  })
})
