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
import { pathToFileURL } from "node:url"

import { HttpAcsmReader, type AcsmReader } from "../acsm/client.js"
import { loadProfile } from "../profile/load.js"
import { FileArchiveStore } from "../archive/store.js"
import { ingest, IngestError, type IngestOutcome, type IngestReport } from "../archive/ingest.js"

const USAGE = `champctl-archive — keep a copy of every championship export

Usage:
  champctl-archive run              fetch every championship and store what changed
  champctl-archive status           what is in the archive already

Options:
  --profile <id|path>   league profile (default: batl)
  --base-url <url>      override the profile's ACSM base URL
  --dir <path>          archive directory (default: data/archive)
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
  dir?: string
  since?: Date
  json: boolean
  help: boolean
}

/** Identifies archive traffic in ACSM's logs, distinctly from gridmom's. */
export const ARCHIVE_USER_AGENT = "acsm-champctl/0.1 (archive)"

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UsageError"
  }
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
      case "--dir":
        args.dir = next()
        break
      case "--json":
        args.json = true
        break
      case "--since": {
        const d = new Date(next())
        if (Number.isNaN(d.getTime())) throw new UsageError("--since must be an ISO timestamp")
        args.since = d
        break
      }
      default:
        if (a.startsWith("-")) throw new UsageError(`Unknown option ${a}`)
        rest.push(a)
    }
  }

  args.command = rest[0] ?? ""

  // No command here takes a positional target, unlike `gridmom check <id>`.
  // Accepting extras and ignoring them would let a typo, or a value that
  // drifted away from the option it belongs to, look like a clean run against
  // the default archive directory.
  if (rest.length > 1) {
    const extra = rest.slice(1).map((a) => JSON.stringify(a))
    throw new UsageError(
      `${args.command} takes no arguments, but got ${extra.join(", ")}. ` +
        `Did that belong to an option, such as --dir?`,
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
    if (e instanceof UsageError) {
      process.stderr.write(`${e.message}\n\n${USAGE}`)
      return 3
    }
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

  const store = new FileArchiveStore(args.dir ?? resolve(process.cwd(), "data/archive"))

  if (args.command === "status") return status(store, args)
  if (args.command !== "run") throw new UsageError(`Unknown command ${args.command}`)

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

async function status(store: FileArchiveStore, args: Args): Promise<number> {
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
  try {
    process.exitCode = await main(argv)
  } catch (e) {
    // main() already handles UsageError and IngestError; anything reaching
    // here is ACSM or the filesystem misbehaving, which usage text won't fix.
    const msg = e instanceof Error ? e.message : String(e)
    process.stderr.write(`champctl-archive couldn't run: ${msg}\n`)
    process.exitCode = 3
  }
}

// Run when executed directly, not when imported by a test.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await run(process.argv.slice(2))
}
