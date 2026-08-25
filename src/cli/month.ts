#!/usr/bin/env node
/**
 * champctl-month — build a month and, optionally, import it (plan §5.1).
 *
 * The phase 4 emitter with a face on it.
 *
 * This one creates championships, so the safety ordering is stricter than
 * `champctl-finalize`'s: it emits to **stdout or a file by default** and needs
 * an explicit `--import` to send anything. An accidental extra import is
 * recoverable — delete it — but only if you notice, and a championship that
 * appears without anyone meaning it to is exactly the sort of thing nobody
 * notices until sign-ups are split across two of them.
 */

import { readFile, writeFile } from "node:fs/promises"
import { createInterface } from "node:readline/promises"
import { pathToFileURL } from "node:url"
import { resolve } from "node:path"

import { AcsmError, HttpAcsmReader } from "../acsm/client.js"
import { AcsmSession } from "../acsm/session.js"
import type { Championship } from "../acsm/types.js"
import { importChampionship } from "../acsm/write.js"
import { cloneMonth, specFromChampionship } from "../emit/clone.js"
import { EmitError, emitMonth, type EmitResult, type MonthSpec } from "../emit/month.js"
import { ScheduleError } from "../finalize/schedule.js"
import { check } from "../gridmom/index.js"
import { EMPTY_PIT_TABLE, loadPitTable, type PitTable } from "../pits/table.js"
import { loadProfile } from "../profile/load.js"

const USAGE = `champctl-month — create a month of racing

Usage:
  champctl-month build --spec <spec.json> --template <export.json> [options]
  champctl-month clone <championship-id> --name <name> --start <yyyy-mm-dd> [options]

Options:
  --spec <path>         month spec JSON (see README)
  --template <path>     golden template export; required for build
  --name <name>         override the month name
  --start <yyyy-mm-dd>  first race night
  --tracks <a,b,c>      override the track list
  --out <path>          write the championship JSON here
  --import              send it to ACSM. Without this, nothing is written.
  --yes                 skip the confirmation prompt
  --profile <id|path>   league profile (default: batl)
  --pits <path>         track pit table (default: data/track-pits.json)
  --base-url <url>      override the profile's ACSM base URL
  --json                machine-readable summary
  -h, --help            this

Credentials for --import come from CHAMPCTL_USERNAME and CHAMPCTL_PASSWORD.

Exit codes:
  0  built (and imported, if asked)
  2  gridmom found an error in the generated month
  3  champctl itself failed
`

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UsageError"
  }
}

interface Args {
  command: string
  source?: string
  spec?: string
  template?: string
  name?: string
  start?: string
  tracks?: string[]
  out?: string
  doImport: boolean
  yes: boolean
  profile: string
  pits?: string
  baseUrl?: string
  json: boolean
  help: boolean
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    command: "",
    doImport: false,
    yes: false,
    profile: "batl",
    json: false,
    help: false,
  }
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
      case "--help": args.help = true; break
      case "--spec": args.spec = next(); break
      case "--template": args.template = next(); break
      case "--name": args.name = next(); break
      case "--start": args.start = next(); break
      case "--tracks":
        args.tracks = next().split(",").map((t) => t.trim()).filter(Boolean)
        break
      case "--out": args.out = next(); break
      case "--import": args.doImport = true; break
      case "--yes": args.yes = true; break
      case "--profile": args.profile = next(); break
      case "--pits": args.pits = next(); break
      case "--base-url": args.baseUrl = next(); break
      case "--json": args.json = true; break
      default:
        if (a.startsWith("-")) throw new UsageError(`Unknown option ${a}`)
        rest.push(a)
    }
  }

  args.command = rest[0] ?? ""
  if (rest[1] !== undefined) args.source = rest[1]
  if (rest.length > 2) {
    throw new UsageError(
      `${args.command} takes at most one argument, but got ` +
        `${rest.slice(1).map((r) => JSON.stringify(r)).join(", ")}`,
    )
  }
  return args
}

export function renderResult(result: EmitResult): string {
  const lines: string[] = []
  const c = result.championship
  lines.push(`${c.Name ?? "(unnamed)"} — ${result.schedule.length} rounds`)
  lines.push("")
  for (const round of result.schedule) {
    const track = c.Events?.[round.round - 1]?.RaceSetup?.Track ?? "?"
    const when = round.qualiStart.slice(0, 16).replace("T", " ")
    const moved = round.overridden ? `  (moved${round.note ? `: ${round.note}` : ""})` : ""
    lines.push(`  ${round.round}. ${track.padEnd(20)} quali ${when}${moved}`)
  }
  lines.push("")
  lines.push(`  ${result.grid.summary}`)
  lines.push("")
  lines.push("  Set rather than inherited:")
  for (const d of result.derived) lines.push(`    ${d}`)
  return lines.join("\n")
}

async function loadPits(path: string | undefined): Promise<PitTable> {
  const target = path ?? resolve(process.cwd(), "data/track-pits.json")
  try {
    return await loadPitTable(target)
  } catch (e) {
    if (path) throw e
    void e
    return EMPTY_PIT_TABLE
  }
}

async function readJson<T>(path: string, what: string): Promise<T> {
  let text: string
  try {
    text = await readFile(resolve(process.cwd(), path), "utf8")
  } catch (e) {
    throw new UsageError(`Couldn't read ${what} at ${path}: ${(e as Error).message}`)
  }
  try {
    return JSON.parse(text) as T
  } catch (e) {
    throw new UsageError(`${what} at ${path} isn't valid JSON: ${(e as Error).message}`)
  }
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(`${question} [y/N] `)
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  try {
    return await run(argv)
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`${e.message}\n\n${USAGE}`)
      return 3
    }
    if (e instanceof EmitError || e instanceof ScheduleError) {
      process.stderr.write(`${e.message}\n`)
      return 3
    }
    if (e instanceof AcsmError) {
      process.stderr.write(`ACSM: ${e.message}\n`)
      return 3
    }
    throw e
  }
}

async function run(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv)
  if (args.help || !args.command) {
    process.stdout.write(USAGE)
    return args.help ? 0 : 3
  }

  const profile = await loadProfile(args.profile)
  const pits = await loadPits(args.pits)
  const overrides = specOverrides(args)

  let result: EmitResult
  if (args.command === "build") {
    if (!args.spec || !args.template) {
      throw new UsageError("build needs --spec and --template.")
    }
    const spec = await readJson<MonthSpec>(args.spec, "the month spec")
    const template = await readJson<Championship>(args.template, "the golden template")
    result = emitMonth({ template, spec: { ...spec, ...overrides }, profile, pits })
  } else if (args.command === "clone") {
    if (!args.source) throw new UsageError("clone needs the championship id to clone from.")
    const baseUrl = args.baseUrl ?? profile.acsmBaseUrl
    if (!baseUrl) {
      throw new UsageError(
        `No ACSM base URL. Set acsmBaseUrl in the ${args.profile} profile, or pass --base-url.`,
      )
    }
    const source = await new HttpAcsmReader({ baseUrl }).exportChampionship(args.source)
    result = cloneMonth({ source, profile, pits, overrides })
  } else {
    throw new UsageError(`Unknown command ${args.command}. Try build or clone.`)
  }

  const report = check(result.championship, profile, { pits })

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({ ...result, gridmom: report }, null, 2)}\n`,
    )
  } else {
    process.stdout.write(`${renderResult(result)}\n`)
    if (report.findings.length > 0) {
      process.stdout.write("\n  gridmom:\n")
      for (const f of report.findings) {
        process.stdout.write(`    [${f.severity}] ${f.message}\n`)
      }
    }
  }

  if (args.out) {
    await writeFile(
      resolve(process.cwd(), args.out),
      `${JSON.stringify(result.championship, null, 2)}\n`,
      "utf8",
    )
    if (!args.json) process.stdout.write(`\nWritten to ${args.out}\n`)
  }

  if (report.counts.ERROR > 0) {
    process.stderr.write("\ngridmom found an error in the generated month; not importing.\n")
    return 2
  }

  if (!args.doImport) {
    if (!args.json && !args.out) {
      process.stdout.write("\nNothing written. Use --out to save it, or --import to send it.\n")
    }
    return 0
  }

  await importIt(result.championship, args, profile.acsmBaseUrl)
  return 0
}

async function importIt(
  championship: Championship,
  args: Args,
  profileBaseUrl: string | undefined,
): Promise<void> {
  const baseUrl = args.baseUrl ?? profileBaseUrl
  if (!baseUrl) throw new UsageError("No ACSM base URL for the import.")

  const username = process.env["CHAMPCTL_USERNAME"]
  const password = process.env["CHAMPCTL_PASSWORD"]
  if (!username || !password) {
    throw new UsageError(
      "--import needs CHAMPCTL_USERNAME and CHAMPCTL_PASSWORD in the environment. They are read " +
        "from there rather than from a flag so they stay out of shell history.",
    )
  }

  if (!args.yes && !(await confirm(`\nCreate "${championship.Name}" on ${baseUrl}?`))) {
    process.stdout.write("Nothing sent.\n")
    return
  }

  const session = new AcsmSession({ baseUrl })
  await session.login({ username, password })
  // freshIds is the default; the emitter already regenerated them, and this
  // regenerates again, which is harmless and keeps the safety rail on.
  const { championshipId } = await importChampionship(session, championship)
  process.stdout.write(`Created ${championshipId}\n`)
}

function specOverrides(args: Args): Partial<MonthSpec> {
  const o: Partial<MonthSpec> = {}
  if (args.name !== undefined) o.name = args.name
  if (args.start !== undefined) o.startDate = args.start
  if (args.tracks !== undefined) o.rounds = args.tracks.map((track) => ({ track }))
  return o
}

/** Entry point for `bin/champctl-month.js` and `npm run month`. */
export async function runCli(argv: readonly string[]): Promise<void> {
  try {
    process.exitCode = await main(argv)
  } catch (e) {
    process.stderr.write(`champctl-month couldn't run: ${e instanceof Error ? e.message : e}\n`)
    process.exitCode = 3
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runCli(process.argv.slice(2))
}

export { specFromChampionship }
