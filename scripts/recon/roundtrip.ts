/**
 * Round-trip recon — plan §5.4, automated.
 *
 *   npm run recon:roundtrip [-- --file path/to/export.json]
 *
 * Imports a championship, exports it straight back, and diffs. Anything that
 * isn't ACSM housekeeping is either an emitter bug or a schema change, and both
 * are worth knowing about before a Wednesday.
 *
 * Also runs the duplicate-pit-box experiment: `AddInPitBox` overwrites, so if
 * import goes through it, two entrants sharing a pit box means one is silently
 * deleted. That answers how urgent gridmom's ERROR really is.
 */

import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { IMPORT_HOUSEKEEPING, diff, formatChanges } from "../../src/acsm/diff.js"
import type { Championship } from "../../src/acsm/types.js"
import { events, slots } from "../../src/acsm/view.js"
import { exportPath, importChampionship } from "../../src/acsm/write.js"
import { connect, log, runRecon, writeArtefact } from "./env.js"

const DEFAULT_FIXTURE = "fixtures/synthetic/recon-seed.json"

function fileArg(): string {
  const i = process.argv.indexOf("--file")
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : DEFAULT_FIXTURE
}

async function main(): Promise<void> {
  const session = await connect()
  const path = resolve(process.cwd(), fileArg())
  const source = JSON.parse(await readFile(path, "utf8")) as Championship
  log(`Importing ${path}`)

  const { championshipId, sent } = await importChampionship(session, source)
  if (!championshipId) throw new Error("Import didn't redirect to a championship")
  log(`Imported as ${championshipId}`)

  const returned = await session.getJson<Championship>(exportPath(championshipId))

  // ------------------------------------------------------------------ diff
  const all = diff(sent, returned)
  const substantive = diff(sent, returned, { ignore: IMPORT_HOUSEKEEPING })

  log("")
  log(`Round trip: ${all.length} differences, ${substantive.length} after ignoring housekeeping.`)
  log("")
  log(formatChanges(substantive))

  // --------------------------------------------------- UUID preservation
  const idsPreserved = sent.ID === returned.ID
  log("")
  log(
    idsPreserved
      ? `Championship UUID preserved exactly — the never-import-over-a-live-ID rule is load-bearing.`
      : `Championship UUID was rewritten by ACSM (${sent.ID} → ${returned.ID}).`,
  )

  // ------------------------------------------------ duplicate pit boxes
  const pitBoxReport = comparePitBoxes(sent, returned)
  if (pitBoxReport.sentDuplicates.length > 0) {
    log("")
    log(`Sent duplicate pit boxes at ${pitBoxReport.sentDuplicates.join(", ")}.`)
    log(
      pitBoxReport.entrantsLost > 0
        ? `  !! ${pitBoxReport.entrantsLost} entrant(s) did not survive the import. ` +
            `Duplicate pit boxes DELETE people — gridmom should say so.`
        : `  All entrants survived, so import does not go through AddInPitBox.`,
    )
  }

  await writeArtefact("roundtrip.json", {
    capturedAt: new Date().toISOString(),
    source: path,
    championshipId,
    idsPreserved,
    differences: all,
    substantiveDifferences: substantive,
    pitBoxes: pitBoxReport,
  })

  log("")
  log(`Wrote fixtures/recon/roundtrip.json`)
  log(`Clean up with: docker compose down -v (in docker/)`)
}

function comparePitBoxes(sent: Championship, returned: Championship) {
  const boxesOf = (c: Championship): number[] =>
    slots(events(c)[0]?.EntryList).map((s) => s.entrant.PitBox ?? -1)

  const before = boxesOf(sent)
  const after = boxesOf(returned)

  const seen = new Set<number>()
  const duplicates = new Set<number>()
  for (const b of before) {
    if (seen.has(b)) duplicates.add(b)
    seen.add(b)
  }

  return {
    sentCount: before.length,
    returnedCount: after.length,
    entrantsLost: Math.max(0, before.length - after.length),
    sentDuplicates: [...duplicates].sort((a, b) => a - b),
    sentPitBoxes: before,
    returnedPitBoxes: after,
  }
}

await runRecon("recon:roundtrip", main)
