#!/usr/bin/env node
/**
 * champctl-month — build a month and, optionally, import it (plan §5.1).
 *
 * The phase 4 emitter with a face on it.
 *
 * This one creates championships, so the safety ordering is stricter than
 * `champctl-finalize`'s. By default it **prints a summary and writes nothing
 * at all**: the championship JSON reaches a file only with `--out`, and ACSM
 * only with `--import`. An accidental extra import is recoverable — delete it
 * — but only if you notice, and a championship that appears without anyone
 * meaning it to is exactly the sort of thing nobody notices until sign-ups are
 * split across two of them.
 *
 * `--json` is a *summary*, not an export: it wraps the championship alongside
 * the grid cap, schedule and gridmom report, so piping it to a file does not
 * produce something importable. `--out` is the one that writes an export.
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
import { loadProfile } from "../profile/load.js"
import { loadPits, reportUsageError, runCli, UsageError } from "./args.js"

// Re-exported so callers and tests have one obvious place to import it from,
// while there is still only one class.
export { UsageError }

const USAGE = `champctl-month — create a month of racing

Usage:
  champctl-month build --spec <spec.json> --template <export.json> [options]
  champctl-month clone <championship-id> [options]

Options:
  --spec <path>         month spec JSON (see README). Required for build.
  --template <path>     golden template export. Required for build.
  --name <name>         override the month name. For clone, without this the
                        new month reuses last month's name.
  --start <yyyy-mm-dd>  first race night. Without it, the next occurrence of
                        the league's race weekday.
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
      case "--help":
        args.help = true
        break
      case "--spec":
        args.spec = next()
        break
      case "--template":
        args.template = next()
        break
      case "--name":
        args.name = next()
        break
      case "--start":
        args.start = next()
        break
      case "--tracks":
        args.tracks = next()
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
        break
      case "--out":
        args.out = next()
        break
      case "--import":
        args.doImport = true
        break
      case "--yes":
        args.yes = true
        break
      case "--profile":
        args.profile = next()
        break
      case "--pits":
        args.pits = next()
        break
      case "--base-url":
        args.baseUrl = next()
        break
      case "--json":
        args.json = true
        break
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
        `${rest
          .slice(1)
          .map((r) => JSON.stringify(r))
          .join(", ")}`,
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

/**
 * Checks the shape `emitMonth` actually indexes into, before it does.
 *
 * `readJson<MonthSpec>` is a cast, not a check — parsing tells you the bytes
 * were JSON, nothing more. A spec of `{}` got as far as `spec.rounds.length`
 * and died with "Cannot read properties of undefined (reading 'length')" and
 * exit 3, which reads as champctl breaking rather than as a bad file. The
 * `--template` path already fails properly, with an EmitError naming the
 * problem, so this only brings `--spec` up to the same standard.
 *
 * Deliberately shallow: emitMonth validates the *contents* — empty rounds,
 * empty cars, blank tracks — with messages better than anything here. This
 * covers only the fields that would throw a TypeError before reaching it.
 */
function assertMonthSpec(value: unknown, path: string): asserts value is MonthSpec {
  const bad = (why: string): never => {
    throw new UsageError(`The month spec at ${path} ${why}.`)
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    bad("is not a JSON object")
  }
  const v = value as Record<string, unknown>
  if (typeof v["name"] !== "string") bad("has no `name`, which the month is called")
  if (!Array.isArray(v["cars"])) bad("has no `cars` array — RaceSetup.Cars is derived from it")
  if (!Array.isArray(v["rounds"])) bad("has no `rounds` array, so there is nothing to generate")
  for (const [i, r] of (v["rounds"] as unknown[]).entries()) {
    if (typeof r !== "object" || r === null || Array.isArray(r)) {
      bad(`has a round ${i + 1} that is not an object`)
    }
  }
}

/**
 * Asks, when there is someone to ask. Twin of the one in `finalize.ts`.
 *
 * With stdin at EOF — cron, a closed fd, `< /dev/null` — `rl.question` never
 * settles: the process hangs and then exits **13** on Node's unsettled
 * top-level await warning, outside the documented 0/1/2/3 contract. The prompt
 * goes to stderr so it cannot corrupt a `--json` document on stdout.
 */
export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new UsageError(
      "Refusing to ask for confirmation with nothing attached to stdin — there is no one to " +
        "answer, and waiting would hang. Pass --yes to confirm up front.",
    )
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await rl.question(`${question} [y/N] `)
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  try {
    return await runCommand(argv)
  } catch (e) {
    if (e instanceof UsageError) return reportUsageError(e, USAGE)
    // Same split as champctl-finalize: a ScheduleError is a date or time the
    // person typed, so it gets the usage block that documents the flag. An
    // EmitError is about the *contents* of a spec or template file, where the
    // message is long and specific and the usage block adds nothing.
    if (e instanceof ScheduleError) return reportUsageError(new UsageError(e.message), USAGE)
    if (e instanceof EmitError) {
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

async function runCommand(argv: readonly string[]): Promise<number> {
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
    // build takes no positional: parseArgs allows one so `clone <id>` works,
    // which would otherwise let `build <id> --spec ...` run against the spec
    // while silently ignoring the id someone clearly meant something by.
    if (args.source !== undefined) {
      throw new UsageError(
        `build takes no positional argument, but got ${JSON.stringify(args.source)}. ` +
          `Did you mean \`clone ${args.source}\`, or to pass it to --spec or --template?`,
      )
    }
    if (!args.spec || !args.template) {
      throw new UsageError("build needs --spec and --template.")
    }
    const spec = await readJson<unknown>(args.spec, "the month spec")
    assertMonthSpec(spec, args.spec)
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
    process.stdout.write(`${JSON.stringify({ ...result, gridmom: report }, null, 2)}\n`)
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

  // Named, or described. A partial export with no Name would otherwise ask
  // `Create "undefined" on ...?`, which is the one moment the prompt has to be
  // clear about what is going to be created.
  const what = championship.Name ? `"${championship.Name}"` : "this unnamed championship"

  // Under --json, stdout is a JSON document; prose appended to it makes the
  // document unparseable. The prompt already goes to stderr, and these two
  // lines have to follow it for the same reason.
  const say = (line: string): void => {
    if (args.json) process.stderr.write(line)
    else process.stdout.write(line)
  }

  if (!args.yes && !(await confirm(`\nCreate ${what} on ${baseUrl}?`))) {
    say("Nothing sent.\n")
    return
  }

  const session = new AcsmSession({ baseUrl })
  await session.login({ username, password })
  // freshIds is the default; the emitter already regenerated them, and this
  // regenerates again, which is harmless and keeps the safety rail on.
  const { championshipId } = await importChampionship(session, championship)
  say(`Created ${championshipId}\n`)
}

function specOverrides(args: Args): Partial<MonthSpec> {
  const o: Partial<MonthSpec> = {}
  if (args.name !== undefined) o.name = args.name
  if (args.start !== undefined) o.startDate = args.start
  if (args.tracks !== undefined) o.rounds = args.tracks.map((track) => ({ track }))
  return o
}

/** Entry point for `bin/champctl-month.js` and `npm run month`. */
export async function run(argv: readonly string[]): Promise<void> {
  await runCli({ name: "champctl-month", usage: USAGE, main }, argv)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await run(process.argv.slice(2))
}

export { specFromChampionship }
