#!/usr/bin/env node
/**
 * champctl-archive — hoard every championship export (plan §8.1).
 *
 * Read-only by construction: it holds an `AcsmReader`, which has no
 * credentials and no write methods. That is what makes this the one job safe
 * to point at a league's production manager on a schedule.
 *
 * Exit code is the contract for cron, matching gridmom's: 0 nothing new,
 * 1 something was archived, 2 at least one championship failed, 3 the run
 * itself failed. A nightly job can decide whether to say anything without
 * parsing the output.
 */

import { resolve } from "node:path"

import { DateTime } from "luxon"
import { pathToFileURL } from "node:url"

import { HttpAcsmReader, type AcsmReader } from "../acsm/client.js"
import { loadProfile } from "../profile/load.js"
import { SqliteArchiveStore } from "../archive/store.js"
import { ingest, IngestError, type IngestOutcome, type IngestReport } from "../archive/ingest.js"
import { reportUsageError, runCli, UsageError } from "./args.js"

const USAGE = `champctl-archive — keep a copy of every championship export

Usage:
  champctl-archive run              fetch every championship and store what changed
  champctl-archive status           what is in the archive already

Options:
  --profile <id|path>   league profile (default: batl)
  --base-url <url>      override the profile's ACSM base URL
  --db <path>           archive database (default: data/archive/archive.db)
  --since <iso>         skip championships already checked since this time
  --json                machine-readable output
  -h, --help            this

Exit codes:
  0  ran clean, nothing had changed
  1  ran clean, something was archived
  2  ran, but at least one championship failed
  3  the run itself failed

The archive is league data, not code: it holds Steam GUIDs and driver names,
and is gitignored for the same reason data/track-pits.json is.
`

interface Args {
  command: string
  profile: string
  baseUrl?: string
  db?: string
  since?: Date
  json: boolean
  help: boolean
}

/** Identifies archive traffic in ACSM's logs, distinctly from gridmom's. */
export const ARCHIVE_USER_AGENT = "acsm-champctl/0.1 (archive)"

/**
 * A cutoff, parsed strictly as ISO 8601.
 *
 * `new Date()` was doing this, and it is not an ISO parser. It accepts
 * implementation-defined formats — V8 reads `08/24/2026` as a US date, which
 * another runtime need not — and, worse, it *normalises* impossible ISO-looking
 * dates: `2026-02-30` becomes 2 March rather than an error. `--since` decides
 * which championships a run skips, so a mistyped cutoff that parses is a run
 * that quietly does the wrong thing and reports success.
 *
 * A bare date means UTC midnight rather than the machine's midnight, so the
 * same command means the same thing on the league's server and on a laptop.
 * An explicit offset or `Z` in the value is honoured.
 */
export function isoTimestampOrThrow(value: string): Date {
  const dt = DateTime.fromISO(value, { zone: "utc", setZone: true })
  if (!dt.isValid) {
    throw new UsageError(
      `--since must be an ISO 8601 timestamp, and ${JSON.stringify(value)} is not ` +
        `(${dt.invalidReason ?? "unparsable"}). Try 2026-08-24 or 2026-08-24T17:00:00Z — ` +
        `a bare date is read as UTC midnight.`,
    )
  }
  return dt.toJSDate()
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { command: "", profile: "batl", json: false, help: false }
  const rest: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    const next = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new UsageError(`${a} needs a value`)
      return v
    }
    switch (a) {
      case "-h":
      case "--help":
        args.help = true
        break
      case "--profile":
        args.profile = next()
        break
      case "--base-url":
        args.baseUrl = next()
        break
      case "--db":
        args.db = next()
        break
      case "--json":
        args.json = true
        break
      case "--since":
        args.since = isoTimestampOrThrow(next())
        break
      default:
        if (a.startsWith("-")) throw new UsageError(`Unknown option ${a}`)
        rest.push(a)
    }
  }

  args.command = rest[0] ?? ""

  // No command here takes a positional target, unlike `gridmom check <id>`.
  // Accepting extras and ignoring them would let a typo, or a value that
  // drifted away from the option it belongs to, look like a clean run against
  // the default archive.
  if (rest.length > 1) {
    const extra = rest.slice(1).map((a) => JSON.stringify(a))
    throw new UsageError(
      `${args.command} takes no arguments, but got ${extra.join(", ")}. ` +
        `Did that belong to an option, such as --db?`,
    )
  }

  return args
}

export function describe(outcome: IngestOutcome): string {
  const who = outcome.name ? `${outcome.name} (${outcome.championshipId})` : outcome.championshipId
  switch (outcome.kind) {
    case "stored":
      return `archived   ${who} — ${outcome.result.snapshot.bytes} bytes`
    case "unchanged":
      return `unchanged  ${who}`
    case "skipped":
      return `skipped    ${who} — ${outcome.reason}`
    case "failed":
      return `FAILED     ${who} — ${outcome.error}`
    default: {
      const never: never = outcome
      return String(never)
    }
  }
}

export function summarise(report: IngestReport): string {
  const parts = [`${report.stored} archived`, `${report.unchanged} unchanged`]
  if (report.skipped) parts.push(`${report.skipped} skipped`)
  if (report.failed) parts.push(`${report.failed} failed`)
  return parts.join(", ")
}

/**
 * 2 beats 1 beats 0: a run that archived something *and* had a failure should
 * report the failure, because that is the one a person needs to act on.
 */
export function exitCodeFor(report: IngestReport): number {
  if (report.failed > 0) return 2
  return report.stored > 0 ? 1 : 0
}

export async function main(argv: readonly string[]): Promise<number> {
  try {
    return await runCommand(argv)
  } catch (e) {
    if (e instanceof UsageError) return reportUsageError(e, USAGE)
    if (e instanceof IngestError) {
      process.stderr.write(`${e.message}\n`)
      return 3
    }
    throw e
  }
}

async function runCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv)

  if (args.help || !args.command) {
    process.stdout.write(USAGE)
    return args.help ? 0 : 3
  }

  // Command first, database second. Opening it creates the file, so a typo
  // like `champctl-archive frobnicate` would otherwise leave a database behind
  // — or fail with a SQLite error — instead of saying which command it didn't
  // recognise.
  if (args.command !== "run" && args.command !== "status") {
    throw new UsageError(`Unknown command ${args.command}`)
  }

  // One database file rather than a directory of them, so --dir became --db.
  const store = await SqliteArchiveStore.open(
    args.db ?? resolve(process.cwd(), "data/archive/archive.db"),
  )

  if (args.command === "status") return status(store, args)

  const profile = await loadProfile(args.profile)
  const baseUrl = args.baseUrl ?? profile.acsmBaseUrl
  if (!baseUrl) {
    throw new UsageError(
      `No ACSM base URL. Set acsmBaseUrl in the ${args.profile} profile, or pass --base-url.`,
    )
  }

  // No response cache: the archive wants what the server says right now, and a
  // cached body would be filed under the wrong fetch time.
  //
  // The User-Agent is set explicitly because the default names gridmom, and
  // the two jobs look very different in a server log — gridmom is one
  // championship on demand, the archive is every championship nightly.
  // Telling them apart matters the first time someone asks what is talking to
  // ACSM at 3am.
  const reader: AcsmReader = new HttpAcsmReader({
    baseUrl,
    userAgent: ARCHIVE_USER_AGENT,
  })

  const report = await ingest(reader, store, {
    ...(args.since === undefined ? {} : { skipCheckedSince: args.since }),
    ...(args.json ? {} : { onProgress: (o) => process.stdout.write(`${describe(o)}\n`) }),
  })

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(`\n${summarise(report)}\n`)
  }
  return exitCodeFor(report)
}

async function status(store: SqliteArchiveStore, args: Args): Promise<number> {
  const ids = await store.list()
  const rows = []
  for (const id of ids) {
    const index = await store.read(id)
    if (!index) continue
    rows.push({
      championshipId: id,
      name: index.snapshots.at(-1)?.name,
      snapshots: index.snapshots.length,
      firstSeen: index.firstSeen,
      lastCheckedAt: index.lastCheckedAt,
    })
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`)
    return 0
  }

  if (rows.length === 0) {
    process.stdout.write("The archive is empty. Run `champctl-archive run`.\n")
    return 0
  }

  for (const r of rows) {
    const who = r.name ? `${r.name} (${r.championshipId})` : r.championshipId
    const s = r.snapshots === 1 ? "snapshot" : "snapshots"
    process.stdout.write(`${who}\n  ${r.snapshots} ${s}, last checked ${r.lastCheckedAt}\n`)
  }
  process.stdout.write(`\n${rows.length} championship${rows.length === 1 ? "" : "s"} archived\n`)
  return 0
}

/** Entry point used by both `bin/champctl-archive.js` and `npm run archive`. */
export async function run(argv: readonly string[]): Promise<void> {
  await runCli({ name: "champctl-archive", usage: USAGE, main }, argv)
}

// Run when executed directly, not when imported by a test.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await run(process.argv.slice(2))
}
