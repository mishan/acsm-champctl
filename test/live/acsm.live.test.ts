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
import { count, getAll, parseForm, setAt, setOne } from "../../src/acsm/form.js"
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

      // Not asserted empty: the plan expects PracticeEntryListType to be
      // rewritten 2 -> 1 and that must stay visible until it's understood.
      // Print it so a failure explains itself.
      if (changes.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`Round-trip differences:\n${formatChanges(changes)}`)
      }
      const unexpected = changes.filter((c) => c.path !== "PracticeEntryListType")
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
      const boxes = getAll(fields, "EntryList.EntrantID")
      const target = boxes.length - 1
      setAt(fields, "EntryList.EntrantID", target, "25")

      await session.postForm(eventSubmitPath(id), fields)

      const after = await session.getJson<Championship>(exportPath(id))
      const pitBoxes = slots(events(after)[0]!.EntryList).map((s) => s.entrant.PitBox)
      expect(pitBoxes).toContain(25)
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

  it("parses the import page's file field", async () => {
    const html = await session.getText("/championship/import")
    const form = parseForm(html)
    expect(form.enctype).toBe("multipart/form-data")
    const fileInput = /<input[^>]*type=["']file["'][^>]*>/i.exec(html)
    expect(fileInput, "import page should have a file input").toBeTruthy()
    // eslint-disable-next-line no-console
    console.log(`Import file field: ${/name=["']([^"']+)["']/i.exec(fileInput![0])?.[1]}`)
  })
})
