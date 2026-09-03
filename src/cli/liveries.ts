#!/usr/bin/env node
/**
 * champctl-liveries — upload a pack of custom liveries and assign them.
 *
 * Replaces the two manual steps in the race-week routine: getting a zip of
 * skins onto the server, and then clicking through the entry list reassigning
 * each driver to the skin they submitted.
 *
 * **The assignment is made on the championship, never on an event.** ACSM
 * builds each round's `entry_list.ini` from the class entrants and lets the
 * round's own entry list override six properties on top, so the class list is
 * the one write that applies everywhere. `src/liveries/plan.ts` has the detail,
 * including how a plan notices when a round would override the change anyway.
 *
 * **Writing requires an explicit `--push`**, like the other write commands. The
 * default reads the pack, matches it against the entry list, and prints what it
 * would do.
 *
 * This is deliberately a CLI and not a screen. The intended operator is a
 * Discord bot taking uploads from drivers directly, and it wants an engine and
 * an argument list rather than a form.
 */

import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"

import { AcsmError, HttpAcsmReader } from "../acsm/client.js"
import { AcsmSession } from "../acsm/session.js"
import { events } from "../acsm/view.js"
import {
  LiveryApplyError,
  PracticeRestartError,
  RosterChangedError,
  applyLiveries,
} from "../liveries/apply.js"
import { DEFAULT_LIMITS, LiveryPackError, readLiveryPack } from "../liveries/pack.js"
import { loadProfile } from "../profile/load.js"
import {
  LiveryPlanError,
  type LiveryPlan,
  planLiveries,
  unreachableRounds,
} from "../liveries/plan.js"
import { confirm, reportUsageError, runCli, UsageError } from "./args.js"

export { UsageError }

const USAGE = `champctl-liveries — upload custom liveries and assign them

Usage:
  champctl-liveries <championship-id> --zip <pack.zip> [options]

The pack is a zip of zips, one folder per car model:

  rss_formula_hybrid_2021/Misha.zip
  rss_formula_hybrid_2021/postaL.zip
  ford_transit/Stream.zip

Each inner zip is one driver's skin folder — a .dds livery and its preview and
ui_skin.json. The inner zip's name is matched against the entrant's name
exactly, and becomes the skin folder on the server.

Options:
  --zip <path>          the livery pack (required)
  --restart <round>     restart that round's looping practice server afterwards
  --base-url <url>      override the profile's ACSM base URL
  --profile <id|path>   league profile (default: batl)
  --push                actually write. Without it this only previews.
  --yes                 skip the confirmation prompt (for scripts)
  --json                machine-readable plan
  -h, --help            this

Credentials come from CHAMPCTL_USERNAME and CHAMPCTL_PASSWORD. A preview needs
none — it reads the championship export, which is public.

The liveries are assigned on the championship's own entry list, so they apply to
every round. Per-event entry lists are never written.

Exit codes:
  0  previewed cleanly, or pushed
  1  nothing to do — every livery is already assigned
  2  the pack or the entry list wouldn't allow it
  3  a usage mistake, or champctl itself failed
`

interface Args {
  championshipId?: string
  zip?: string
  restart?: number
  profile: string
  baseUrl?: string
  push: boolean
  yes: boolean
  json: boolean
  help: boolean
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { profile: "batl", push: false, yes: false, json: false, help: false }
  const rest: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    const next = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new UsageError(`${a} needs a value`)
      if (v.startsWith("-") && !/^-\d/.test(v)) {
        throw new UsageError(
          `${a} needs a value, but the next argument is ${JSON.stringify(v)}, which looks like ` +
            `another option.`,
        )
      }
      return v
    }

    switch (a) {
      case "-h":
      case "--help":
        args.help = true
        break
      case "--zip":
        args.zip = next()
        break
      case "--restart": {
        const raw = next()
        if (!/^\d+$/.test(raw.trim()) || Number(raw) < 1) {
          throw new UsageError(
            `--restart needs a round number from 1, not ${JSON.stringify(raw)}. It is the round ` +
              `whose looping practice server should pick the new liveries up.`,
          )
        }
        args.restart = Number(raw)
        break
      }
      case "--profile":
        args.profile = next()
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
      case "--json":
        args.json = true
        break
      default:
        if (a.startsWith("-")) throw new UsageError(`Unknown option ${a}`)
        rest.push(a)
    }
  }

  if (rest.length > 1) {
    throw new UsageError(
      `Expected one championship id, but got ${rest.length} arguments: ` +
        `${rest.map((r) => JSON.stringify(r)).join(", ")}. The pack goes after --zip.`,
    )
  }
  if (rest[0] !== undefined) args.championshipId = rest[0]
  return args
}

export function renderPlan(plan: LiveryPlan, restartRound?: number): string {
  const lines: string[] = []
  lines.push(`${plan.championshipName} — liveries`)
  lines.push("")

  if (plan.assignments.length === 0) {
    lines.push("  Nothing to change; every livery in the pack is already assigned.")
  } else {
    for (const a of plan.assignments) {
      lines.push(
        `  ${a.driverName.padEnd(18)} ${a.fromSkin || "(no skin)"} → ${a.skinFolder}` +
          `   ${a.livery.files.length} files, ${a.carModel}`,
      )
    }
  }

  if (plan.unchanged.length > 0) {
    lines.push("")
    lines.push(
      `  Already assigned, nothing to do: ${plan.unchanged.map((a) => a.driverName).join(", ")}`,
    )
  }

  const unreachable = unreachableRounds(plan)
  if (unreachable.length > 0) {
    lines.push("")
    // Not a warning about tidiness. The write would land in the database and
    // the race would still run the old livery.
    lines.push(
      `  !! Rounds ${unreachable.join(", ")} keep their own entry-list skins, so this change`,
    )
    lines.push(`     would not reach them. See docs/acsm-champ-form.md §4.1.`)
  }

  if (plan.racedRounds.length > 0) {
    lines.push("")
    lines.push(
      `  Rounds ${plan.racedRounds.join(", ")} have already been raced. A skin is cosmetic and ` +
        `results are not touched, so this changes only what those cars look like in replays.`,
    )
  }

  if (restartRound !== undefined) {
    lines.push("")
    lines.push(`  Then: restart round ${restartRound}'s looping practice server.`)
  }

  return lines.join("\n")
}

export async function main(argv: readonly string[]): Promise<number> {
  try {
    return await runCommand(argv)
  } catch (e) {
    // A bad pack is something the person can fix by re-zipping, so it prints
    // the message and not the usage block — the message already says what is
    // wrong with which file, which is more use than the option list.
    if (e instanceof LiveryPackError || e instanceof LiveryPlanError) {
      process.stderr.write(`${e.message}\n`)
      return 2
    }
    if (e instanceof RosterChangedError) {
      process.stderr.write(`${e.message}\n`)
      return 2
    }
    // Before the generic branch: this is a half-finished job, not a refusal,
    // and the message says which half landed.
    if (e instanceof PracticeRestartError) {
      process.stderr.write(`${e.message}\n`)
      return 3
    }
    if (e instanceof LiveryApplyError) {
      process.stderr.write(`${e.message}\n`)
      return 3
    }
    if (e instanceof UsageError) return reportUsageError(e, USAGE)
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
  if (!args.championshipId) throw new UsageError("Needs a championship id.")
  if (!args.zip) throw new UsageError("Needs a livery pack: --zip <pack.zip>.")

  const profile = await loadProfile(args.profile)
  const baseUrl = args.baseUrl ?? profile.acsmBaseUrl
  if (!baseUrl) {
    throw new UsageError(
      `No ACSM base URL. Set acsmBaseUrl in the ${args.profile} profile, or pass --base-url.`,
    )
  }

  const packBytes = await readPack(args.zip)
  const pack = readLiveryPack(packBytes, DEFAULT_LIMITS)

  // The export is public, so a preview needs no credentials — unlike
  // champctl-finalize, whose preview has to read a form. The championship form
  // is only read when there is something to write.
  const reader = new HttpAcsmReader({ baseUrl })
  const championship = await reader.exportChampionship(args.championshipId)
  const plan = planLiveries(championship, args.championshipId, pack)

  const eventIds = events(championship).map((ev) => ev.ID ?? "")
  if (args.restart !== undefined && !eventIds[args.restart - 1]) {
    throw new UsageError(
      `--restart ${args.restart}: this championship has ${eventIds.length} rounds.`,
    )
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ...plan, pack: undefined }, replacer, 2)}\n`)
  } else {
    process.stdout.write(`${renderPlan(plan, args.restart)}\n`)
  }

  if (plan.noop) return 1

  if (!args.push) {
    if (!args.json) process.stdout.write("\nPreview only. Re-run with --push to apply.\n")
    return 0
  }

  const say = (line: string): void => {
    if (args.json) process.stderr.write(line)
    else process.stdout.write(line)
  }

  const session = new AcsmSession({ baseUrl })
  await login(session)

  if (!args.yes && !(await confirm("\nUpload and assign these?"))) {
    say("Nothing sent.\n")
    return 0
  }

  const result = await applyLiveries(session, plan, {
    ...(args.restart !== undefined ? { restartPracticeRound: args.restart } : {}),
    eventIds,
  })
  say(
    `Uploaded ${result.uploaded.length} ${result.uploaded.length === 1 ? "livery" : "liveries"}, ` +
      `championship saved${result.practiceRestarted ? ", practice restarted" : ""}.\n`,
  )
  return 0
}

async function readPack(path: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(path))
  } catch (e) {
    throw new UsageError(`Couldn't read ${path}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * Credentials, and only for a write.
 *
 * From the environment rather than a flag so they stay out of shell history and
 * out of the process list, same as the other write commands.
 */
async function login(session: AcsmSession): Promise<void> {
  const username = process.env["CHAMPCTL_USERNAME"]
  const password = process.env["CHAMPCTL_PASSWORD"]
  if (!username || !password) {
    throw new UsageError(
      `champctl-liveries needs CHAMPCTL_USERNAME and CHAMPCTL_PASSWORD in the environment to ` +
        `push. A preview needs neither — the championship export is public.`,
    )
  }
  await session.login({ username, password })
}

/** File bytes are not useful in JSON output, and are large. */
function replacer(key: string, value: unknown): unknown {
  return key === "livery" || key === "bytes" ? undefined : value
}

/** Entry point for `bin/champctl-liveries.js` and `npm run liveries`. */
export async function run(argv: readonly string[]): Promise<void> {
  await runCli({ name: "champctl-liveries", usage: USAGE, main }, argv)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await run(process.argv.slice(2))
}
