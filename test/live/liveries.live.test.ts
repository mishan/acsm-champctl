/**
 * A livery save against the Docker harness, on a championship with more than
 * one spectator car.
 *
 *   npm run harness:up
 *   set -a && . docker/.env && set +a
 *   npm run test:live
 *
 * The fake ACSM in liveries-apply.test.ts reads the payload the way 2.4.15 was
 * measured to; this is that measurement, repeated on every run.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  CHAMPIONSHIP_REQUIRED_ENTRY_LIST_FIELDS,
  findChampionshipForm,
  SPECTATOR_MARKER,
} from "../../src/acsm/championship-form.js"
import { setOne } from "../../src/acsm/form.js"
import { CHAMPIONSHIP_SUBMIT_PATH, championshipEditPath } from "../../src/acsm/paths.js"
import type { AcsmSession } from "../../src/acsm/session.js"
import type { Championship, Entrant } from "../../src/acsm/types.js"
import { importChampionship } from "../../src/acsm/write.js"
import { applyLiveries, championshipDrift } from "../../src/liveries/apply.js"
import { planLiveries } from "../../src/liveries/plan.js"
import { deleteChampionship, LIVE, liveSession, loadFixture, SEED } from "./harness.js"

// A Kunos car, so every harness has it; the seed's own car is a mod.
const CAR = "abarth500"

async function importInto(
  session: AcsmSession,
  championship: Championship,
  created: string[],
): Promise<string> {
  const { championshipId } = await importChampionship(session, championship)
  if (!championshipId) throw new Error("the import didn't redirect to a new championship")
  created.push(championshipId)
  return championshipId
}

async function saveUnchanged(session: AcsmSession, id: string): Promise<void> {
  const path = championshipEditPath(id)
  const form = findChampionshipForm(await session.getText(path), session.url(path))
  setOne(form.fields, "action", "saveChampionship")
  await session.postForm(CHAMPIONSHIP_SUBMIT_PATH, form.fields, {
    requiredEntryListFields: CHAMPIONSHIP_REQUIRED_ENTRY_LIST_FIELDS,
    entryListMarkers: [SPECTATOR_MARKER],
  })
}

describe.skipIf(!LIVE)("livery saves against a real ACSM", () => {
  let session: AcsmSession | undefined
  const created: string[] = []

  beforeAll(async () => {
    session = await liveSession()
  }, 60_000)

  afterAll(async () => {
    if (!session) return
    for (const id of created) await deleteChampionship(session, id)
  })

  it.each([1, 2, 3])(
    "assigns a skin with %i spectator cars and changes nothing else",
    async (spectators) => {
      const live = session!
      const seed = JSON.parse(
        JSON.stringify(await loadFixture(SEED)).replaceAll('"rss_formula_hybrid_2021"', `"${CAR}"`),
      ) as Championship
      const cls = seed.Classes![0]!
      seed.SpectatorCarEnabled = true
      seed.SpectatorCars = Array.from({ length: spectators }, (_, i) => ({
        ...Object.values(cls.Entrants!)[0]!,
        Name: `Spectator ${i}`,
        GUID: `9000000000000000${i}`,
        InternalUUID: `00000000-0000-4000-8000-00000000020${i}`,
        ConnectAsSpectator: true,
      })) as Entrant[]

      // The seed isn't in the shape a save leaves a championship in, so one
      // unchanged save first, as a browser would make; then the spectator cars
      // numbered and raced the way BATL's October export had them, so the
      // livery save's renumbering is exercised rather than already done.
      const first = await importInto(live, seed, created)
      await saveUnchanged(live, first)
      const primed = await live.getJson<Championship>(`/championship/${first}/export`)
      primed.SpectatorCars = primed.SpectatorCars!.map((c, i) => ({
        ...c,
        PitBox: 23 + i,
        RaceNumber: 420,
      }))
      const id = await importInto(live, primed, created)
      const before = await live.getJson<Championship>(`/championship/${id}/export`)
      const driver = Object.values(before.Classes![0]!.Entrants!).find((e) => e.Name)!.Name!

      const plan = planLiveries(before, id, {
        liveries: [
          {
            carModel: CAR,
            driverName: driver,
            skinFolder: "champctl_live_skin",
            files: [{ name: "ui_skin.json", bytes: new TextEncoder().encode("{}") }],
            totalBytes: 2,
          },
        ],
        totalBytes: 2,
      })
      await applyLiveries(live, plan)

      const after = await live.getJson<Championship>(`/championship/${id}/export`)
      // In any order: a save can store them in another one (docs/acsm-champ-form.md §4.7).
      const byGuid = (c: Championship, f: (car: Entrant, i: number) => unknown[]) =>
        (c.SpectatorCars ?? []).map(f).sort((a, b) => String(a[1]).localeCompare(String(b[1])))
      expect(byGuid(after, (c) => [c.Name, c.GUID, c.PitBox, c.RaceNumber])).toEqual(
        byGuid(before, (c, i) => [c.Name, c.GUID, i, 0]),
      )
      expect(after.SpectatorCars).toHaveLength(spectators)
      expect(championshipDrift(before, after, new Map([[driver, "champctl_live_skin"]]))).toEqual(
        [],
      )
    },
    60_000,
  )
})
