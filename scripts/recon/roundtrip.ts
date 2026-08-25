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

import { IMPORT_HOUSEKEEPING, type Change, diff, formatChanges } from "../../src/acsm/diff.js"
import type { Championship } from "../../src/acsm/types.js"
import { events, sessionKeysUsed, slots } from "../../src/acsm/view.js"
import { exportPath, importChampionship } from "../../src/acsm/write.js"
import {
  connect,
  log,
  runRecon,
  seedChampionship,
  stableUrl,
  writeArtefact,
} from "./env.js"

const DEFAULT_FIXTURE = "fixtures/synthetic/recon-seed.json"

/**
 * Path given to `--file`, or undefined when the flag wasn't used.
 *
 * Throws rather than falling back when the flag is present but has no usable
 * value. Quietly substituting the default would mean diffing a different
 * championship than the one asked for, and the output looks perfectly normal.
 */
function fileArg(): string | undefined {
  const i = process.argv.indexOf("--file")
  if (i === -1) return undefined

  const value = process.argv[i + 1]
  if (!value || value.startsWith("-")) {
    throw new Error(
      `--file needs a path. Got ${value ? `the next flag, ${value}` : "nothing after it"}. ` +
        `Omit --file entirely to copy a championship from the server instead.`,
    )
  }
  return value
}

async function main(): Promise<void> {
  // Parsed before connecting, so a malformed flag is reported straight away
  // rather than after a login round trip.
  const explicitFile = fileArg()

  const session = await connect()

  // An explicit --file wins; otherwise copy something already on the server.
  // A real export is the right shape for this build by definition, which a
  // hand-written fixture can only approximate — see seedChampionship.
  const { championship: source, source: seedSource } = explicitFile
    ? {
        championship: JSON.parse(
          await readFile(resolve(process.cwd(), explicitFile), "utf8"),
        ) as Championship,
        source: explicitFile,
      }
    : await seedChampionship(session, DEFAULT_FIXTURE, "champctl round trip — safe to delete")

  log(`Importing ${seedSource}`)
  const keys = sessionKeysUsed(source)
  if (keys.length > 0) log(`Session keys in this build: ${keys.join(", ")}`)

  const { championshipId, sent } = await importChampionship(session, source)
  if (!championshipId) throw new Error("Import didn’t return a championship id")
  log(`Imported as ${championshipId}`)

  const returned = await session.getJson<Championship>(exportPath(championshipId))

  // ------------------------------------------------------------------ diff
  // Most of ACSM's struct is `json:",omitempty"`, so a zero value that comes
  // back absent survived — Go just didn't serialise it. Comparing timestamps
  // as instants covers Go trimming trailing zeros off fractional seconds.
  // What's left after both is genuinely worth looking at.
  const all = diff(sent, returned)
  const substantive = diff(sent, returned, {
    ignore: IMPORT_HOUSEKEEPING,
    omitEmpty: true,
    timestampsAsInstants: true,
  })

  log("")
  log(`Round trip: ${all.length} raw differences, ${substantive.length} substantive.`)
  log("")
  log(formatChanges(substantive))
  if (substantive.length > 0) {
    log("")
    log("A field sent with a non-zero value and returned absent means this build's")
    log("Championship struct has no such field — it was dropped on unmarshal.")
  }

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
    // Masked: the ids are new every run, and a throwaway container's id is
    // meaningless a day later. The console prints them at run time.
    source: stableUrl(seedSource),
    championshipId: stableUrl(championshipId),
    idsPreserved,
    differences: redact(all),
    substantiveDifferences: redact(substantive),
    pitBoxes: pitBoxReport,
  })

  log("")
  log(`Wrote fixtures/recon/roundtrip.json`)
  log(`Clean up with: docker compose down -v (in docker/)`)
}

/**
 * Strips values from diffs that touch personal data before they're committed.
 *
 * These artefacts are meant to be checked in — the diff on the next ACSM
 * upgrade is the point. But entry lists and sign-up responses carry names,
 * Steam GUIDs, emails and free-text answers (plan §5.3), and a diff records
 * both the before and after value. The path is what's interesting for schema
 * drift; the value is not.
 */
const SENSITIVE_PATH = /(^|\.)(EntryList|Entrants|SignUpForm|SpectatorCar)(\.|\[|$)/

function redact(changes: readonly Change[]): Change[] {
  return changes.map((c) => {
    if (!SENSITIVE_PATH.test(c.path)) return c
    const out: Change = { path: c.path, kind: c.kind }
    if ("before" in c) out.before = "<redacted>"
    if ("after" in c) out.after = "<redacted>"
    return out
  })
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
