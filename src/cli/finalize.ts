#!/usr/bin/env node
/**
 * champctl-finalize — the weekly flow from a terminal (plan §5.2).
 *
 * The phase 3 engine with a face on it. Everything dangerous lives in
 * `src/finalize/`; this reads arguments, prints a preview, and asks before
 * writing.
 *
 * **Writes require credentials and an explicit `--push`.** The default is a
 * preview: fetch the event, show what would change, run gridmom, and stop.
 * That ordering is deliberate — the destructive option should be the one you
 * have to type, not the one you forget to turn off.
 */

import { createInterface } from "node:readline/promises"
import { pathToFileURL } from "node:url"

import { AcsmError, HttpAcsmReader } from "../acsm/client.js"
import { AcsmSession } from "../acsm/session.js"
import { events } from "../acsm/view.js"
import { applyFinalize, EntryListChangedError } from "../finalize/apply.js"
import type { RaceFormat, RaceLength } from "../finalize/format.js"
import { readFormat } from "../finalize/format.js"
import { FinalizeError, planFinalize, type FinalizePlan } from "../finalize/plan.js"
import { ScheduleError } from "../finalize/schedule.js"
import { loadPitTable, EMPTY_PIT_TABLE, type PitTable } from "../pits/table.js"
import { loadProfile } from "../profile/load.js"
import { resolve } from "node:path"

const USAGE = `champctl-finalize — set a race's format and push it

Usage:
  champctl-finalize <championship-id> <round> [options]

  Round is 1-based, as a league counts them.

Format:
  --laps <n>            race length in laps
  --minutes <n>         race length in minutes
  --reversed <n>        reversed grid positions (0 = single race)
  --pit / --no-pit      mandatory pit stop
  --extra-lap / --no-extra-lap
  --quali <date> <time> move quali, league-local, e.g. 2026-09-09 20:00

Options:
  --profile <id|path>   league profile (default: batl)
  --pits <path>         track pit table (default: data/track-pits.json)
  --base-url <url>      override the profile's ACSM base URL
  --push                actually write. Without it this only previews.
  --yes                 skip the confirmation prompt (for scripts)
  --accept-warnings     push despite gridmom warnings. Never overrides errors.
  --json                machine-readable plan
  -h, --help            this

Credentials come from CHAMPCTL_USERNAME and CHAMPCTL_PASSWORD, and are needed
even for a preview: the preview reads the event *edit form*, which ACSM only
serves to a logged-in session, and that form is what makes the preview honest
about the fields it would post. For a credential-free look at a championship,
use gridmom — the export is public.

Exit codes:
  0  previewed cleanly, or pushed
  1  nothing to do — the event already matches
  2  gridmom blocked it, or the entry list changed under us
  3  champctl itself failed
`

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UsageError"
  }
}

interface Args {
  championshipId?: string
  round?: number
  laps?: number
  minutes?: number
  reversed?: number
  pit?: boolean
  extraLap?: boolean
  quali?: { date: string; time: string }
  profile: string
  pits?: string
  baseUrl?: string
  push: boolean
  yes: boolean
  acceptWarnings: boolean
  json: boolean
  help: boolean
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    profile: "batl",
    push: false,
    yes: false,
    acceptWarnings: false,
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
    const num = (): number => {
      const v = Number(next())
      if (!Number.isFinite(v) || v < 0) throw new UsageError(`${a} needs a non-negative number`)
      return v
    }
    switch (a) {
      case "-h":
      case "--help": args.help = true; break
      case "--laps": args.laps = num(); break
      case "--minutes": args.minutes = num(); break
      case "--reversed": args.reversed = num(); break
      case "--pit": args.pit = true; break
      case "--no-pit": args.pit = false; break
      case "--extra-lap": args.extraLap = true; break
      case "--no-extra-lap": args.extraLap = false; break
      case "--quali": args.quali = { date: next(), time: next() }; break
      case "--profile": args.profile = next(); break
      case "--pits": args.pits = next(); break
      case "--base-url": args.baseUrl = next(); break
      case "--push": args.push = true; break
      case "--yes": args.yes = true; break
      case "--accept-warnings": args.acceptWarnings = true; break
      case "--json": args.json = true; break
      default:
        // A leading "-" followed by a digit is a mistyped value, not a flag —
        // champctl has no numeric options. Letting it fall through to the
        // positional checks produces "Round must be a whole number from 1"
        // rather than the less useful "Unknown option -1".
        if (a.startsWith("-") && !/^-\d/.test(a)) throw new UsageError(`Unknown option ${a}`)
        rest.push(a)
    }
  }

  if (args.laps !== undefined && args.minutes !== undefined) {
    throw new UsageError(
      "--laps and --minutes are two ways to say the same thing; pick one. A race is measured " +
        "in laps or in minutes, and setting both leaves the export ambiguous.",
    )
  }

  if (rest.length > 2) {
    throw new UsageError(
      `Expected a championship id and a round, but got ${rest.length} arguments: ` +
        `${rest.map((r) => JSON.stringify(r)).join(", ")}`,
    )
  }
  if (rest[0] !== undefined) args.championshipId = rest[0]
  if (rest[1] !== undefined) {
    const round = Number(rest[1])
    if (!Number.isInteger(round) || round < 1) {
      throw new UsageError(`Round must be a whole number from 1, got ${JSON.stringify(rest[1])}`)
    }
    args.round = round
  }
  return args
}

/**
 * Builds the desired format from the current one plus whatever was asked for.
 *
 * Starting from the current format rather than from defaults is the whole
 * point: `--laps 18` means "make it 18 laps", not "make it 18 laps and reset
 * everything else I didn't mention".
 */
export function formatFrom(current: RaceFormat, args: Partial<Args>): RaceFormat {
  const length: RaceLength =
    args.laps !== undefined
      ? { kind: "laps", laps: args.laps }
      : args.minutes !== undefined
        ? { kind: "minutes", minutes: args.minutes }
        : current.length

  return {
    length,
    reversedGridPositions: args.reversed ?? current.reversedGridPositions,
    mandatoryPit: args.pit ?? current.mandatoryPit,
    extraLap: args.extraLap ?? current.extraLap,
  }
}

export function renderPlan(plan: FinalizePlan): string {
  const lines: string[] = []
  lines.push(`Round ${plan.round} of ${plan.championshipId}`)

  if (plan.changes.length === 0 && !plan.schedule) {
    lines.push("  Nothing to change; the event already matches.")
  } else {
    for (const c of plan.changes) lines.push(`  ${c.label}: ${c.before} → ${c.after}`)
    if (plan.schedule) {
      lines.push(`  Quali: ${plan.schedule.from ?? "unscheduled"} → ${plan.schedule.to}`)
    }
    lines.push("")
    lines.push("  Fields that will be posted:")
    for (const f of plan.formChanges) {
      lines.push(`    ${f.name}: ${f.before ?? "(absent)"} → ${f.after}`)
    }
    if (plan.schedule) lines.push("    ...plus a separate POST to the schedule endpoint")
  }

  if (plan.gridmom.findings.length > 0) {
    lines.push("")
    lines.push("  gridmom, against the event as it would be:")
    for (const f of plan.gridmom.findings) lines.push(`    [${f.severity}] ${f.message}`)
  }
  return lines.join("\n")
}

async function loadPits(path: string | undefined): Promise<PitTable> {
  const target = path ?? resolve(process.cwd(), "data/track-pits.json")
  try {
    return await loadPitTable(target)
  } catch (e) {
    // An explicit --pits that won't load is a mistake worth reporting; the
    // default may simply not exist yet.
    if (path) throw e
    void e
    return EMPTY_PIT_TABLE
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
    if (e instanceof EntryListChangedError) {
      process.stderr.write(`${e.message}\n`)
      return 2
    }
    if (e instanceof FinalizeError || e instanceof ScheduleError) {
      process.stderr.write(`${e.message}\n`)
      return 2
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
  if (args.help) {
    process.stdout.write(USAGE)
    return 0
  }
  if (!args.championshipId || args.round === undefined) {
    throw new UsageError("Needs a championship id and a round.")
  }

  const profile = await loadProfile(args.profile)
  const baseUrl = args.baseUrl ?? profile.acsmBaseUrl
  if (!baseUrl) {
    throw new UsageError(
      `No ACSM base URL. Set acsmBaseUrl in the ${args.profile} profile, or pass --base-url.`,
    )
  }

  // The export itself is public, which is why *this* read needs no
  // credentials. The preview as a whole still does — see `login` below, which
  // runs whether or not --push was given, because planFinalize reads the event
  // edit form and ACSM serves that only to a logged-in session.
  const reader = new HttpAcsmReader({ baseUrl })
  const championship = await reader.exportChampionship(args.championshipId)
  const ev = events(championship)[args.round - 1]
  if (!ev?.ID) {
    throw new UsageError(
      `Championship ${args.championshipId} has no round ${args.round} — it has ` +
        `${events(championship).length}.`,
    )
  }

  const session = new AcsmSession({ baseUrl })
  await login(session, args)

  const plan = await planFinalize(session, {
    championship,
    championshipId: args.championshipId,
    eventId: ev.ID,
    format: formatFrom(readFormat(ev), args),
    ...(args.quali ? { qualiStart: args.quali } : {}),
    profile,
    pits: await loadPits(args.pits),
  })

  if (args.json) {
    process.stdout.write(`${JSON.stringify(plan, replacer, 2)}\n`)
  } else {
    process.stdout.write(`${renderPlan(plan)}\n`)
  }

  if (plan.noop) return 1
  if (plan.blocked) {
    if (!args.json) process.stderr.write("\nBlocked: gridmom found an error. Nothing was sent.\n")
    return 2
  }

  if (!args.push) {
    if (!args.json) process.stdout.write("\nPreview only. Re-run with --push to apply.\n")
    return 0
  }

  if (!args.yes && !(await confirm("\nPush this?"))) {
    process.stdout.write("Nothing sent.\n")
    return 0
  }

  const result = await applyFinalize(session, plan, {
    acknowledgeWarnings: args.acceptWarnings,
  })
  process.stdout.write(
    `Pushed: ${result.eventSaved ? "event saved" : "event unchanged"}` +
      `${result.scheduleSaved ? ", schedule saved" : ""}.\n`,
  )
  return 0
}

/**
 * Even a preview logs in.
 *
 * `planFinalize` fetches the event edit form, and ACSM serves that only to an
 * authenticated session — it answers a logged-out request with the login page
 * and a 200, which the form parser then reports as "no form posting to
 * /event/submit". Reading the form is the point: it is what lets the preview
 * list the exact fields that would be posted, and what the entry-list
 * fingerprint is taken from.
 *
 * `gridmom` remains the credential-free way to look at a championship, since
 * the export is public.
 *
 * Credentials come from the environment rather than a flag so they stay out of
 * shell history and out of the process list.
 */
async function login(session: AcsmSession, args: Args): Promise<void> {
  const username = process.env["CHAMPCTL_USERNAME"]
  const password = process.env["CHAMPCTL_PASSWORD"]
  if (!username || !password) {
    throw new UsageError(
      `champctl-finalize needs CHAMPCTL_USERNAME and CHAMPCTL_PASSWORD in the environment, even ` +
        `to ${args.push ? "push" : "preview"}: the preview reads the event edit form, which ACSM ` +
        `only serves to a logged-in session. They are read from the environment rather than from ` +
        `a flag so they stay out of shell history. For a credential-free check, use gridmom.`,
    )
  }
  await session.login({ username, password })
}

/** The parsed form is large and not useful in JSON output. */
function replacer(key: string, value: unknown): unknown {
  return key === "form" ? undefined : value
}

/** Entry point for `bin/champctl-finalize.js` and `npm run finalize`. */
export async function runCli(argv: readonly string[]): Promise<void> {
  try {
    process.exitCode = await main(argv)
  } catch (e) {
    process.stderr.write(`champctl-finalize couldn't run: ${e instanceof Error ? e.message : e}\n`)
    process.exitCode = 3
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runCli(process.argv.slice(2))
}
