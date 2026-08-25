#!/usr/bin/env node
/**
 * champctl-finalize — the weekly flow from a terminal (plan §5.2).
 *
 * The phase 3 engine with a face on it. Everything dangerous lives in
 * `src/finalize/`; this reads arguments, prints a preview, and asks before
 * writing.
 *
 * **Writing requires an explicit `--push`.** The default is a preview: fetch
 * the event, show what would change, run gridmom, and stop. That ordering is
 * deliberate — the destructive option should be the one you have to type, not
 * the one you forget to turn off.
 *
 * Credentials are needed either way, including for the preview: it reads the
 * event *edit form*, which ACSM only serves to a logged-in session, and that
 * form is what makes the preview honest about the fields it would post. For a
 * credential-free look at a championship, use gridmom — the export is public.
 */

import { pathToFileURL } from "node:url"

import { AcsmError, HttpAcsmReader } from "../acsm/client.js"
import { AcsmSession } from "../acsm/session.js"
import { events } from "../acsm/view.js"
import { applyFinalize, EntryListChangedError, PartialWriteError } from "../finalize/apply.js"
import type { RaceFormat, RaceLength } from "../finalize/format.js"
import { readFormat } from "../finalize/format.js"
import { FinalizeError, planFinalize, type FinalizePlan } from "../finalize/plan.js"
import { ScheduleError } from "../finalize/schedule.js"
import { loadProfile } from "../profile/load.js"
import { confirm, loadPits, reportUsageError, runCli, UsageError } from "./args.js"

// Re-exported so callers and tests have one obvious place to import it from,
// while there is still only one class.
export { UsageError }

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
  3  a usage mistake, or champctl itself failed
`

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
    /**
     * The next argument, refusing one that is obviously another flag.
     *
     * `--quali` takes two values and called this twice with no lookahead, so
     * `--quali 2026-09-09 --push` read "--push" as the time and silently
     * dropped the flag — the write never happened and nothing said why. The
     * later parse does reject "--push" as a time, but it complains about the
     * time rather than about the option that got eaten.
     *
     * A leading "-" followed by a digit is a negative number, not a flag, and
     * stays allowed so a value like -1 reaches the check that has something
     * useful to say about it.
     */
    const next = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new UsageError(`${a} needs a value`)
      if (v.startsWith("-") && !/^-\d/.test(v)) {
        throw new UsageError(
          `${a} needs a value, but the next argument is ${JSON.stringify(v)}, which looks like ` +
            `another option. If that is genuinely the value, there is no way to say so yet.`,
        )
      }
      return v
    }
    /**
     * A whole number of laps, minutes or grid places.
     *
     * `Number()` was doing all the work, and it is far too willing.
     * `Number("")` and `Number(" ")` are both `0`, so `--laps "$LAPS"` with an
     * unset shell variable asked for a zero-lap race — and `formFieldsFor`
     * posts `Race.Laps: "0"` *and* `Race.Time: "0"`, a race with no end
     * condition that nothing downstream rejects: gridmom has no lap check, so
     * the plan isn't blocked, and it isn't a noop either, so `--push` sends it.
     * It also accepted `1.5`, `0x10` and `1e3` for fields that are Go ints on
     * the other side.
     *
     * `min` is a parameter because `--laps 0` is meaningless while
     * `--reversed 0` is the normal way to say "no reversed grid".
     */
    const num = (min: number): number => {
      const raw = next()
      if (raw.trim() === "") {
        throw new UsageError(`${a} needs a number, but the value was empty.`)
      }
      // Plain decimal digits, checked as a string before Number sees it.
      // `Number` also accepts "0x10" (16) and "1e3" (1000), both of which are
      // integers and neither of which anyone meant to type as a lap count.
      if (!/^-?\d+$/.test(raw.trim())) {
        throw new UsageError(`${a} needs a whole number, not ${JSON.stringify(raw)}.`)
      }
      const v = Number(raw)
      if (!Number.isInteger(v) || v < min) {
        throw new UsageError(
          `${a} needs a whole number of ${min} or more, not ${JSON.stringify(raw)}.`,
        )
      }
      return v
    }
    switch (a) {
      case "-h":
      case "--help":
        args.help = true
        break
      case "--laps":
        args.laps = num(1)
        break
      case "--minutes":
        args.minutes = num(1)
        break
      case "--reversed":
        args.reversed = num(0)
        break
      case "--pit":
        args.pit = true
        break
      case "--no-pit":
        args.pit = false
        break
      case "--extra-lap":
        args.extraLap = true
        break
      case "--no-extra-lap":
        args.extraLap = false
        break
      case "--quali":
        args.quali = { date: next(), time: next() }
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
      case "--push":
        args.push = true
        break
      case "--yes":
        args.yes = true
        break
      case "--accept-warnings":
        args.acceptWarnings = true
        break
      case "--json":
        args.json = true
        break
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

export async function main(argv: readonly string[]): Promise<number> {
  try {
    return await runCommand(argv)
  } catch (e) {
    if (e instanceof UsageError) return reportUsageError(e, USAGE)
    if (e instanceof EntryListChangedError) {
      process.stderr.write(`${e.message}\n`)
      return 2
    }
    // A ScheduleError is something the person typed: a malformed --quali, a
    // wall-clock time the zone doesn't have, a timezone the profile got wrong.
    // Grouping it with FinalizeError gave it exit 2 and no usage block, so a
    // date typo looked exactly like "gridmom blocked this" or "someone changed
    // the entry list" — a refusal to act on a correct request, rather than a
    // request that needs retyping. The message already says what to do; the
    // usage block says what the flag looks like.
    if (e instanceof ScheduleError) return reportUsageError(new UsageError(e.message), USAGE)
    // Before the generic FinalizeError branch: a partial write is not a
    // refusal, it is a half-finished job, and the message says which half.
    if (e instanceof PartialWriteError) {
      process.stderr.write(`${e.message}\n`)
      return 3
    }
    if (e instanceof FinalizeError) {
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

async function runCommand(argv: readonly string[]): Promise<number> {
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

  // Progress lines go to stderr under --json, for the same reason the prompt
  // does: stdout is carrying a JSON document, and prose appended to it makes
  // the document unparseable. The prompt itself was fixed and these two were
  // not, which left `--json --push` still able to emit trailing text.
  const say = (line: string): void => {
    if (args.json) process.stderr.write(line)
    else process.stdout.write(line)
  }

  if (!args.yes && !(await confirm("\nPush this?"))) {
    say("Nothing sent.\n")
    return 0
  }

  const result = await applyFinalize(session, plan, {
    acknowledgeWarnings: args.acceptWarnings,
  })
  say(
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
export async function run(argv: readonly string[]): Promise<void> {
  await runCli({ name: "champctl-finalize", usage: USAGE, main }, argv)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await run(process.argv.slice(2))
}
