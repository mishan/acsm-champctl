#!/usr/bin/env node
/**
 * gridmom CLI.
 *
 * Read-only by construction: it can reach a championship export and nothing
 * else. Exit code is the contract for cron — 0 clean, 1 warnings, 2 errors —
 * so a nightly job can decide whether to post without parsing the output.
 */

import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { CACHE_FILE, SqliteCache } from "../acsm/cache.js"
import { type AcsmReader, HttpAcsmReader } from "../acsm/client.js"
import type { Championship } from "../acsm/types.js"
import { loadProfile } from "../profile/load.js"
import { defaultProfile, loadPits, reportUsageError, runCli, UsageError } from "./args.js"
import { check } from "../gridmom/index.js"
import type { Severity } from "../gridmom/finding.js"
import { formatReport, type ReportFormat } from "../gridmom/report.js"
import { DateTime } from "luxon"
import { nextRound } from "../bot/announce.js"
import type { ResultsReader } from "../laps/practice.js"
import { lapsForRound, type RoundLaps, roundFindings } from "../laps/round.js"

const USAGE = `gridmom — championship sanity checker

Usage:
  gridmom check <championship-id>     check a championship on the league's ACSM
  gridmom check --file <export.json>  check an export already on disk
  gridmom list                        list championships on the league's ACSM
  gridmom laps <championship-id>      propose a round's race laps from its practice

Options:
  --profile <id|path>   league profile (default: $CHAMPCTL_PROFILE, else batl)
  --pits <path>         track pit table JSON
                        (default: $CHAMPCTL_PITS, else data/track-pits.json)
  --format <fmt>        text | json | discord   (default: text)
  --min <severity>      ERROR | WARN | INFO     (default: INFO, discord: WARN)
  --suppress <codes>    comma-separated finding codes or prefixes to hide
  --base-url <url>      override the profile's ACSM base URL
  --no-cache            bypass the on-disk response cache
  --now <iso>           pretend it is this time (for testing schedule checks)
  --round <n>           laps: which round (default: the next one)
  --minutes <n>         laps: minutes per race (default: the round's while it is
                        timed, else the profile's lapCount.raceMinutes)
  -h, --help            this

Exit codes:
  0  nothing worth reporting
  1  warnings only; for laps, only this round's, or nothing to propose
  2  at least one error
  3  gridmom itself failed
`

interface Args {
  command: string
  target?: string
  file?: string
  profile: string
  pits?: string
  format: ReportFormat
  min?: Severity
  suppress: string[]
  baseUrl?: string
  cache: boolean
  now?: Date
  round?: number
  minutes?: number
  help: boolean
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    command: "",
    profile: defaultProfile(),
    format: "text",
    suppress: [],
    cache: true,
    help: false,
  }

  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
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
      case "--file":
        args.file = next()
        break
      case "--profile":
        args.profile = next()
        break
      case "--pits":
        args.pits = next()
        break
      case "--format":
        args.format = parseFormat(next())
        break
      case "--min":
        args.min = parseSeverity(next())
        break
      case "--suppress":
        args.suppress.push(
          ...next()
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        )
        break
      case "--base-url":
        args.baseUrl = next()
        break
      case "--no-cache":
        args.cache = false
        break
      case "--now": {
        const d = new Date(next())
        if (Number.isNaN(d.getTime())) throw new UsageError(`--now must be an ISO timestamp`)
        args.now = d
        break
      }
      case "--round":
        args.round = wholeFromOne(a, next())
        break
      case "--minutes":
        args.minutes = wholeFromOne(a, next())
        break
      default:
        if (a.startsWith("-")) throw new UsageError(`Unknown option ${a}`)
        rest.push(a)
    }
  }

  args.command = rest[0] ?? ""
  if (rest[1] !== undefined) args.target = rest[1]
  return args
}

function wholeFromOne(flag: string, v: string): number {
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`${flag} must be a whole number from 1`)
  return n
}

function parseFormat(v: string): ReportFormat {
  if (v === "text" || v === "json" || v === "discord") return v
  throw new UsageError(`--format must be text, json or discord`)
}

function parseSeverity(v: string): Severity {
  const up = v.toUpperCase()
  if (up === "ERROR" || up === "WARN" || up === "INFO") return up
  throw new UsageError(`--min must be ERROR, WARN or INFO`)
}

/**
 * Builds a reader and runs `use` with it, closing the cache afterwards.
 *
 * The cache owns a SQLite connection, and a connection nobody closes leaves
 * its WAL and shared-memory files behind for the next process to recover. That
 * costs nothing on a CLI that exits immediately, and it is exactly the kind of
 * thing that stops being free when the same code is called twice from a bot.
 * Closing belongs here rather than in the reader: a cache is meant to outlive
 * any one reader, so the thing that opened it is the thing that ends it.
 */
async function withReader<T>(
  args: Args,
  baseUrl: string,
  use: (reader: AcsmReader & ResultsReader) => Promise<T>,
): Promise<T> {
  const cache = args.cache
    ? await SqliteCache.open({ path: resolve(process.cwd(), CACHE_FILE) })
    : undefined
  try {
    return await use(new HttpAcsmReader({ baseUrl, ...(cache ? { cache } : {}) }))
  } finally {
    cache?.close()
  }
}

/**
 * Runs a command and turns every usage mistake into the usage block, wherever
 * it was raised — argument parsing and "no base URL configured" deserve the
 * same treatment, and only one of them happens during parsing.
 */
export async function main(argv: readonly string[]): Promise<number> {
  try {
    return await runCommand(argv)
  } catch (e) {
    if (e instanceof UsageError) return reportUsageError(e, USAGE)
    throw e
  }
}

async function runCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv)

  if (args.help || !args.command) {
    process.stdout.write(USAGE)
    return args.help ? 0 : 3
  }

  const profile = await loadProfile(args.profile)
  const baseUrl = args.baseUrl ?? profile.acsmBaseUrl

  if (args.command === "list") {
    if (!baseUrl)
      throw new UsageError(`No ACSM base URL; set one in the profile or pass --base-url`)
    const list = await withReader(args, baseUrl, (reader) => reader.listChampionships())
    for (const c of list) process.stdout.write(`${c.ID ?? "?"}  ${c.Name ?? ""}\n`)
    return 0
  }

  if (args.command === "laps") {
    if (!args.target) throw new UsageError("laps needs a championship id")
    if (!baseUrl)
      throw new UsageError(`No ACSM base URL; set one in the profile or pass --base-url`)
    const id = args.target
    const now = args.now ?? new Date()
    const pits = await loadPits(args.pits)
    const result = await withReader(args, baseUrl, async (reader) => {
      const c = await reader.exportChampionship(id)
      const rounds = c.Events?.length ?? 0
      if (args.round !== undefined && args.round > rounds) {
        throw new UsageError(`--round ${args.round}: the championship has ${rounds} rounds`)
      }
      const round = args.round ?? nextRound(c, profile, now)
      if (round === undefined) return undefined
      return lapsForRound(reader, c, id, round, profile, {
        pits,
        now,
        suppress: args.suppress,
        ...(args.minutes ? { minutes: args.minutes } : {}),
      })
    })
    if (!result) {
      process.stdout.write("No round left to propose laps for. Pass --round for one already run.\n")
      return 1
    }
    process.stdout.write(`${describeLaps(result, profile.schedule.timezone)}\n`)
    return lapsExitCode(result)
  }

  if (args.command !== "check") {
    throw new UsageError(`Unknown command ${args.command}`)
  }

  let championship: Championship
  if (args.file) {
    championship = JSON.parse(
      await readFile(resolve(process.cwd(), args.file), "utf8"),
    ) as Championship
  } else if (args.target) {
    if (!baseUrl)
      throw new UsageError(`No ACSM base URL; set one in the profile or pass --base-url`)
    const target = args.target
    championship = await withReader(args, baseUrl, (reader) => reader.exportChampionship(target))
  } else {
    throw new UsageError(`check needs a championship id or --file`)
  }

  const report = check(championship, profile, {
    pits: await loadPits(args.pits),
    suppress: args.suppress,
    ...(args.now ? { now: args.now } : {}),
  })

  const output = formatReport(report, args.format, {
    colour: args.format === "text" && process.stdout.isTTY === true,
    ...(args.min ? { minSeverity: args.min } : {}),
  })
  process.stdout.write(`${output}\n`)

  if (report.counts.ERROR > 0) return 2
  if (report.counts.WARN > 0) return 1
  return 0
}

/** A lap time as people read one: `54.694 s`, or `1:54.694` past a minute. */
function lapTime(ms: number): string {
  const s = (ms % 60_000) / 1000
  return ms < 60_000
    ? `${s.toFixed(3)} s`
    : `${Math.floor(ms / 60_000)}:${s.toFixed(3).padStart(6, "0")}`
}

/** As for `check`, counting only what bears on this round; 1 too when there is nothing to propose. */
export function lapsExitCode(r: RoundLaps): number {
  if (r.proposal.kind === "none") return 1
  const { here } = roundFindings(r)
  if (here.some((f) => f.severity === "ERROR")) return 2
  return here.length > 0 ? 1 : 0
}

export function describeLaps(r: RoundLaps, zone: string): string {
  const at = (d: Date) => DateTime.fromJSDate(d).setZone(zone).toFormat("ccc d LLL HH:mm")
  const span = `between ${r.window.since ? at(r.window.since) : "the last race night"} and ${at(r.window.until)}`
  const lines = [`Round ${r.round}, ${r.label}`]
  const p = r.proposal
  if (p.kind === "none") {
    lines.push(`No lap count to propose: ${p.reason}, ${span}.`)
    return lines.join("\n")
  }
  const now =
    r.currentLaps === p.laps
      ? "already set"
      : r.currentLaps > 0
        ? `now ${r.currentLaps}`
        : r.currentMinutes > 0
          ? `now ${r.currentMinutes} minutes`
          : "now unset"
  lines.push(
    `${p.laps} laps for ${p.minutes}-minute races (${now}).`,
    `Fastest clean practice lap: ${lapTime(p.best.lapMs)} by ${p.best.driver} in ${p.best.car}.`,
    `From ${p.sessions} practice sessions ${span}: ${p.validLaps} clean laps by ${p.drivers} drivers.`,
  )
  const { here, elsewhere } = roundFindings(r)
  if (here.length > 0) {
    lines.push("", `With ${p.laps} laps, gridmom reports:`)
    for (const f of here) lines.push(`  ${f.severity} ${f.message}`)
  }
  if (elsewhere > 0) {
    lines.push(
      `${here.length > 0 ? "" : "\n"}Plus ${elsewhere} for other rounds; \`gridmom check\` lists them.`,
    )
  }
  return lines.join("\n")
}

/** Entry point used by both `bin/gridmom.js` and `npm run gridmom`. */
export async function run(argv: readonly string[]): Promise<void> {
  await runCli({ name: "gridmom", usage: USAGE, main }, argv)
}

// Run when executed directly, not when imported by a test.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await run(process.argv.slice(2))
}
