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

import { FileCache } from "../acsm/cache.js"
import { AcsmError, HttpAcsmReader, type AcsmReader } from "../acsm/client.js"
import type { Championship } from "../acsm/types.js"
import { EMPTY_PIT_TABLE, loadPitTable, type PitTable } from "../pits/table.js"
import { loadProfile } from "../profile/load.js"
import { check } from "../gridmom/index.js"
import { Severity } from "../gridmom/finding.js"
import { formatReport, type ReportFormat } from "../gridmom/report.js"

const USAGE = `gridmom — championship sanity checker

Usage:
  gridmom check <championship-id>     check a championship on the league's ACSM
  gridmom check --file <export.json>  check an export already on disk
  gridmom list                        list championships on the league's ACSM

Options:
  --profile <id|path>   league profile (default: batl)
  --pits <path>         track pit table JSON (default: data/track-pits.json)
  --format <fmt>        text | json | discord   (default: text)
  --min <severity>      ERROR | WARN | INFO     (default: INFO, discord: WARN)
  --suppress <codes>    comma-separated finding codes or prefixes to hide
  --base-url <url>      override the profile's ACSM base URL
  --no-cache            bypass the on-disk response cache
  --now <iso>           pretend it is this time (for testing schedule checks)
  -h, --help            this

Exit codes:
  0  nothing worth reporting
  1  warnings only
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
  help: boolean
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    command: "",
    profile: "batl",
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
        args.suppress.push(...next().split(",").map((s) => s.trim()).filter(Boolean))
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
      default:
        if (a.startsWith("-")) throw new UsageError(`Unknown option ${a}`)
        rest.push(a)
    }
  }

  args.command = rest[0] ?? ""
  if (rest[1] !== undefined) args.target = rest[1]
  return args
}

/**
 * A mistake the person can fix by retyping the command, as opposed to
 * something going wrong with ACSM. These always print the usage block, so the
 * CLI explains itself rather than just saying no.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UsageError"
  }
}

function reportUsageError(e: UsageError): number {
  process.stderr.write(`${e.message}\n\n${USAGE}`)
  return 3
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

async function readerFor(args: Args, baseUrl: string): Promise<AcsmReader> {
  return new HttpAcsmReader({
    baseUrl,
    ...(args.cache ? { cache: new FileCache({ dir: resolve(process.cwd(), ".cache/acsm") }) } : {}),
  })
}

async function loadPits(path: string | undefined): Promise<PitTable> {
  const target = path ?? resolve(process.cwd(), "data/track-pits.json")
  try {
    return await loadPitTable(target)
  } catch (e) {
    // An explicit --pits that doesn't load is a mistake worth reporting; the
    // default one simply may not exist yet.
    if (path) throw e
    void e
    return EMPTY_PIT_TABLE
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
    if (e instanceof UsageError) return reportUsageError(e)
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
    if (!baseUrl) throw new UsageError(`No ACSM base URL; set one in the profile or pass --base-url`)
    const reader = await readerFor(args, baseUrl)
    const list = await reader.listChampionships()
    for (const c of list) process.stdout.write(`${c.ID ?? "?"}  ${c.Name ?? ""}\n`)
    return 0
  }

  if (args.command !== "check") {
    throw new UsageError(`Unknown command ${args.command}`)
  }

  let championship: Championship
  if (args.file) {
    championship = JSON.parse(await readFile(resolve(process.cwd(), args.file), "utf8")) as Championship
  } else if (args.target) {
    if (!baseUrl) throw new UsageError(`No ACSM base URL; set one in the profile or pass --base-url`)
    const reader = await readerFor(args, baseUrl)
    championship = await reader.exportChampionship(args.target)
  } else {
    throw new UsageError(`check needs a championship id or --file`)
  }

  const report = check(championship, profile, {
    pits: await loadPits(args.pits),
    suppress: args.suppress,
    ...(args.now ? { now: args.now } : {}),
  })

  process.stdout.write(
    formatReport(report, args.format, {
      colour: args.format === "text" && process.stdout.isTTY === true,
      ...(args.min ? { minSeverity: args.min } : {}),
    }) + "\n",
  )

  if (report.counts.ERROR > 0) return 2
  if (report.counts.WARN > 0) return 1
  return 0
}

/** Entry point used by both `bin/gridmom.js` and `npm run gridmom`. */
export async function run(argv: readonly string[]): Promise<void> {
  try {
    process.exitCode = await main(argv)
  } catch (e) {
    // main() already turns UsageError into the usage block; anything reaching
    // here is ACSM or the filesystem misbehaving, which usage text won't fix.
    if (e instanceof UsageError) {
      process.exitCode = reportUsageError(e)
      return
    }
    const msg = e instanceof AcsmError || e instanceof Error ? e.message : String(e)
    process.stderr.write(`gridmom couldn't run: ${msg}\n`)
    process.exitCode = 3
  }
}

// Run when executed directly, not when imported by a test.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await run(process.argv.slice(2))
}
