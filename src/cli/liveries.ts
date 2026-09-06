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

import { createWriteStream } from "node:fs"
import { mkdir, readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { AcsmError, HttpAcsmReader } from "../acsm/client.js"
import { AcsmSession } from "../acsm/session.js"
import { events } from "../acsm/view.js"
import {
  LiveryApplyError,
  MultiClassError,
  PracticeRestartError,
  RosterChangedError,
  applyLiveries,
} from "../liveries/apply.js"
import { carsetFilename, carsetPlan, writeCarset } from "../liveries/carset.js"
import { defaultStorePath } from "../sqlite.js"
import { DEFAULT_LIMITS, LiveryPackError, readLiveryPack } from "../liveries/pack.js"
import { SqliteLiveryStore } from "../liveries/store.js"
import { loadProfile } from "../profile/load.js"
import {
  LiveryPlanError,
  type LiveryPlan,
  planLiveries,
  unreachableRounds,
} from "../liveries/plan.js"
import { confirm, reportUsageError, runCli, UsageError } from "./args.js"

export { UsageError }

export const USAGE = `champctl-liveries — upload custom liveries and assign them

Usage:
  champctl-liveries <championship-id> --zip <pack.zip> [options]
  champctl-liveries <championship-id> --carset <out.zip> [options]

The pack is a zip of zips, one folder per car model:

  rss_formula_hybrid_2021/Misha.zip
  rss_formula_hybrid_2021/postaL.zip
  ford_transit/Stream.zip

Each inner zip is one driver's skin folder — a .dds livery and its preview and
ui_skin.json. The inner zip's name is matched against the entrant's name
exactly, and becomes the skin folder on the server.

Options:
  --zip <path>          the livery pack
  --carset <path>       instead of uploading, write the carset every driver
                        installs — every livery champctl has applied to this
                        championship, as one archive you can drop on Content
                        Manager. Reads the local store; touches no server.
  --store <path>        where applied liveries are kept
                        (default: $CHAMPCTL_STORE, else data/liveries/liveries.db)
  --no-store            apply without recording. The carset will be missing
                        these, and nothing will say so later.
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
every round. Per-event entry lists are never written. Single-class championships
only — see docs/acsm-champ-form.md 4.4.

Re-running with the same pack uploads every livery again. There is no way to ask
ACSM what is already in a skin folder, so a corrected livery has to be re-sent
rather than guessed at; the championship itself is only written when a skin
assignment actually changes.

Everything pushed is also recorded locally, so --carset can hand drivers the
whole set later. That is the only copy champctl has: a livery uploaded through
ACSM's own web UI is invisible to it and will not be in the carset.

Exit codes:
  0  previewed cleanly, pushed, or wrote a carset
  1  nothing there — no recorded liveries to build a carset from
  2  the pack or the entry list wouldn't allow it
  3  a usage mistake, or champctl itself failed
`

interface Args {
  championshipId?: string
  zip?: string
  carset?: string
  store?: string
  noStore: boolean
  restart?: number
  profile: string
  baseUrl?: string
  push: boolean
  yes: boolean
  json: boolean
  help: boolean
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    profile: "batl",
    noStore: false,
    push: false,
    yes: false,
    json: false,
    help: false,
  }
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
      case "--carset":
        args.carset = next()
        break
      case "--store":
        args.store = next()
        break
      case "--no-store":
        args.noStore = true
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

  for (const a of plan.assignments) {
    // Two different things happen per driver and the difference is worth
    // seeing: a new assignment edits the entry list, a re-upload only replaces
    // the files the entry list already points at.
    const change =
      a.fromSkin === a.skinFolder
        ? `${a.skinFolder} (already assigned, files replaced)`
        : `${a.fromSkin || "(no skin)"} → ${a.skinFolder}`
    lines.push(
      `  ${a.driverName.padEnd(18)} ${change}   ${a.livery.files.length} files, ${a.carModel}`,
    )
  }

  lines.push("")
  lines.push(
    plan.skinChanges.length === 0
      ? `  Every skin is already assigned, so the files are uploaded and the championship is ` +
          `not written.`
      : `  ${plan.skinChanges.length} of ${plan.assignments.length} ` +
          `${plan.skinChanges.length === 1 ? "changes" : "change"} the entry list, so the ` +
          `championship is saved once.`,
  )

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

/**
 * What an error means for the exit code, and what to print with it.
 *
 * Its own function so the mapping can be tested without a server in front of
 * it, because the part worth testing is invisible: `MultiClassError`,
 * `RosterChangedError` and `PracticeRestartError` all extend
 * `LiveryApplyError`, so each has to be matched *before* the general case. Move
 * one below it and every refusal starts reporting itself as champctl failing,
 * which is a 3 telling somebody to file a bug about a championship that is
 * simply not one champctl will write.
 *
 * `undefined` means "not ours" — the caller decides, which for a usage mistake
 * means printing the option list.
 */
export function exitFor(e: unknown): { code: number; message: string } | undefined {
  // A bad pack is something the person can fix by re-zipping, so the message
  // goes out without the usage block — it already says what is wrong with which
  // file, which is more use than the option list.
  if (e instanceof LiveryPackError || e instanceof LiveryPlanError) {
    return { code: 2, message: e.message }
  }
  if (e instanceof RosterChangedError) return { code: 2, message: e.message }
  // A 2 rather than a 3: champctl works exactly as intended here, and the
  // championship is the thing that won't allow it — the same class of answer as
  // a pack that isn't a pack.
  if (e instanceof MultiClassError) return { code: 2, message: e.message }
  // A half-finished job rather than a refusal, and the message says which half
  // landed. Still a 3, because something did go wrong.
  if (e instanceof PracticeRestartError) return { code: 3, message: e.message }
  if (e instanceof LiveryApplyError) return { code: 3, message: e.message }
  if (e instanceof AcsmError) return { code: 3, message: `ACSM: ${e.message}` }
  return undefined
}

export async function main(argv: readonly string[]): Promise<number> {
  try {
    return await runCommand(argv)
  } catch (e) {
    const exit = exitFor(e)
    if (exit) {
      process.stderr.write(`${exit.message}\n`)
      return exit.code
    }
    if (e instanceof UsageError) return reportUsageError(e, USAGE)
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

  if (args.carset !== undefined) {
    if (args.zip) {
      throw new UsageError(
        "--carset writes the pack drivers install and --zip uploads one, so they can't both " +
          "run. Do the upload first, then build the carset from what it recorded.",
      )
    }
    return await buildCarsetFile(args, args.championshipId)
  }

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

  const store = args.noStore ? undefined : await SqliteLiveryStore.open(storePath(args))
  try {
    const result = await applyLiveries(session, plan, {
      ...(args.restart !== undefined ? { restartPracticeRound: args.restart } : {}),
      eventIds,
      ...(store ? { record: store, source: "zip" as const } : {}),
    })
    say(
      `Uploaded ${result.uploaded.length} ${result.uploaded.length === 1 ? "livery" : "liveries"}` +
        `${result.championshipSaved ? ", championship saved" : ", championship unchanged"}` +
        `${result.practiceRestarted ? ", practice restarted" : ""}.\n`,
    )
    if (store) {
      // Named rather than silent: the carset is only as complete as this, and
      // "recorded" is the word that makes --carset make sense later.
      say(`Recorded ${plan.assignments.length} for the carset in ${storePath(args)}.\n`)
    }
  } finally {
    store?.close()
  }
  return 0
}

/** Waits, but wakes early when asked to stop, so Ctrl-C isn't a two-minute wait. */

function storePath(args: Args): string {
  return args.store ?? defaultStorePath()
}

/**
 * Writes the carset. Reads the local store and talks to no server at all.
 *
 * Kept a separate path from the apply rather than a flag on it, because the two
 * have nothing in common: this needs no credentials, no championship export and
 * no network, and the thing it produces is for drivers rather than for the
 * server.
 */
async function buildCarsetFile(args: Args, championshipId: string): Promise<number> {
  const store = await SqliteLiveryStore.open(storePath(args))
  try {
    const plan = carsetPlan(championshipId, await store.list(championshipId))

    if (plan.skins.length === 0) {
      // Exit 1, matching the no-op plan: there is nothing wrong, and there is
      // also no file, so a script should not carry on as though there were.
      process.stderr.write(
        `No liveries recorded for ${championshipId} in ${storePath(args)}. Anything applied ` +
          `before champctl started keeping them, or uploaded through ACSM's own web UI, isn't ` +
          `here — push a pack with --zip and it will be.\n`,
      )
      return 1
    }

    const path = resolve(args.carset as string)
    await mkdir(dirname(path), { recursive: true })

    // Streamed to the file a driver at a time, rather than assembled in the
    // heap and written in one go. Thirty drivers is a few hundred megabytes and
    // this used to hold all of it twice over.
    const handle = createWriteStream(path)
    const result = await writeCarset(handle, plan, (skin) =>
      store.filesFor(championshipId, skin.carModel, skin.driverName),
    )

    if (args.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            path,
            digest: plan.digest,
            suggestedFilename: carsetFilename(plan),
            skins: plan.skins.map((s) => ({
              driver: s.driverName,
              car: s.carModel,
              path: s.path,
            })),
            missingPreviews: result.missingPreviews,
            bytes: result.bytes,
          },
          null,
          2,
        )}\n`,
      )
      return 0
    }

    process.stdout.write(
      `${plan.skins.length} ${plan.skins.length === 1 ? "livery" : "liveries"} across ` +
        `${plan.cars.length} ${plan.cars.length === 1 ? "car" : "cars"} → ${path}\n` +
        `Drivers can drop it on Content Manager, or extract it over their Assetto Corsa folder.\n`,
    )
    if (result.missingPreviews.length > 0) {
      // Not a failure. It races fine and looks broken, which is the kind of thing
      // that generates a message on race night if nobody mentions it now.
      process.stdout.write(
        `\nNo preview.jpg for ${result.missingPreviews.join(", ")} — those will show as blank ` +
          `tiles in Content Manager.\n`,
      )
    }
    return 0
  } finally {
    store.close()
  }
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
