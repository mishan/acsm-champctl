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

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { AcsmError, HttpAcsmReader } from "../acsm/client.js"
import { AcsmAuthError, AcsmSession } from "../acsm/session.js"
import { events } from "../acsm/view.js"
import {
  LiveryApplyError,
  MultiClassError,
  PracticeRestartError,
  RosterChangedError,
  applyLiveries,
} from "../liveries/apply.js"
import { buildCarset, carsetFilename, carsetZip, type Carset } from "../liveries/carset.js"
import { SqliteClaimStore } from "../liveries/claims.js"
import {
  DEFAULT_LIMITS,
  LiveryPackError,
  liveryPack,
  readLiveryPack,
  readSingleLivery,
} from "../liveries/pack.js"
import { SqliteSubmissionQueue } from "../liveries/queue.js"
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
  champctl-liveries <championship-id> --claims [--release <discord-user-id>]
  champctl-liveries <championship-id> --drain [--push]
  champctl-liveries <championship-id> --drain --push --watch [--interval <s>]

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
  --drain               apply everything drivers have sent through the bot.
                        One championship save for the lot, not one per driver.
  --watch               keep draining on a timer. This is what makes uploads
                        self-serve, and it is this process — the one with the
                        credentials — that does it, never the bot.
  --interval <s>        seconds between drains under --watch (default: 120)
  --claims              list which Discord account is claimed as which driver
  --release <id>        drop that Discord account's claim, freeing the name
  --store <path>        where applied liveries and claims are kept
                        (default: data/liveries/liveries.db)
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
  1  nothing to do — every livery is already assigned, or the carset is empty
  2  the pack or the entry list wouldn't allow it
  3  a usage mistake, or champctl itself failed
`

interface Args {
  championshipId?: string
  zip?: string
  carset?: string
  drain: boolean
  watch: boolean
  intervalSeconds: number
  claims: boolean
  release?: string
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
    drain: false,
    watch: false,
    intervalSeconds: 120,
    claims: false,
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
      case "--drain":
        args.drain = true
        break
      case "--watch":
        args.watch = true
        break
      case "--interval": {
        const seconds = Number(next())
        if (!Number.isFinite(seconds) || seconds < 5) {
          // A tighter loop is a login and an export every few seconds against a
          // server that is also running races. Five is already generous.
          throw new UsageError(
            `--interval must be at least 5 seconds, not ${JSON.stringify(argv[i])}.`,
          )
        }
        args.intervalSeconds = seconds
        break
      }
      case "--claims":
        args.claims = true
        break
      case "--release":
        args.release = next()
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

  if (args.claims || args.release !== undefined) {
    if (args.zip || args.carset !== undefined) {
      throw new UsageError("--claims is a separate job from uploading or building a carset.")
    }
    return await manageClaims(args, args.championshipId)
  }

  if (args.carset !== undefined) {
    if (args.zip) {
      throw new UsageError(
        "--carset writes the pack drivers install and --zip uploads one, so they can't both " +
          "run. Do the upload first, then build the carset from what it recorded.",
      )
    }
    return await writeCarset(args, args.championshipId)
  }

  if (args.drain) {
    if (args.zip) {
      throw new UsageError("--drain applies what drivers sent; --zip applies a pack you assembled.")
    }
    return args.watch
      ? await watchDrain(args, args.championshipId)
      : await drain(args, args.championshipId)
  }

  if (args.watch) {
    throw new UsageError("--watch only means anything with --drain.")
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

/**
 * Applies everything drivers have sent through the bot
 * (docs/discord-livery-upload.md §5).
 *
 * **One pack, one championship save, for the lot.** `saveChampionshipSkins`
 * does GET the form → mutate → POST the whole form, so draining three
 * submissions as three applies is three overlapping read-modify-write cycles
 * against a full-form replace — a lost update waiting for the week three people
 * upload at once. `RosterChangedError` does not catch it: that guard compares
 * the *names* on the form, and a concurrent skin write does not change them.
 *
 * **Per-submission planning, not all-or-nothing.** The `--zip` path refuses a
 * whole pack when one driver is missing from the entry list, which is right for
 * a pack somebody assembled by hand. Here it would mean one driver leaving the
 * league blocks everyone else's liveries, so a submission that no longer
 * matches is refused with a reason and the rest go through.
 */
interface DrainOptions {
  /** Under --watch: say nothing when there was nothing to do. */
  quiet?: boolean
}

async function drain(
  args: Args,
  championshipId: string,
  options: DrainOptions = {},
): Promise<number> {
  const baseUrl = args.baseUrl ?? (await loadProfile(args.profile)).acsmBaseUrl
  if (!baseUrl) {
    throw new UsageError(
      `No ACSM base URL. Set acsmBaseUrl in the ${args.profile} profile, or pass --base-url.`,
    )
  }

  const queue = await SqliteSubmissionQueue.open(storePath(args))
  try {
    const waiting = await queue.queued(championshipId)
    if (waiting.length === 0) {
      // The heartbeat goes down even on an empty pass: an idle watcher is
      // exactly what proves to the bot that uploads really do apply themselves.
      if (args.push) await queue.recordDrainRun(championshipId, new Date())
      if (!options.quiet) process.stdout.write(`Nothing waiting for ${championshipId}.\n`)
      // Checked before the network on purpose. A watcher over an empty queue
      // never logs in, never fetches an export, and never shows up in ACSM's
      // logs at all.
      return 1
    }

    const reader = new HttpAcsmReader({ baseUrl })
    const championship = await reader.exportChampionship(championshipId)

    // Re-read here rather than trusting the bot's unpacking. Same bytes, same
    // checks, second time — and the entry list has had time to change since the
    // driver pressed send.
    const usable: { id: number; livery: ReturnType<typeof readSingleLivery> }[] = []
    const refused: { id: number; driverName: string; reason: string }[] = []
    for (const submission of waiting) {
      try {
        usable.push({
          id: submission.id,
          livery: readSingleLivery(
            submission.body,
            { carModel: submission.carModel, driverName: submission.driverName },
            DEFAULT_LIMITS,
          ),
        })
      } catch (e) {
        refused.push({
          id: submission.id,
          driverName: submission.driverName,
          reason: e instanceof Error ? e.message : String(e),
        })
      }
    }

    // Planned one at a time so a driver who has left the entry list takes only
    // their own submission down. `planLiveries` refuses a whole pack, which is
    // the wrong answer here and the right one for --zip.
    const applying: typeof usable = []
    for (const candidate of usable) {
      try {
        planLiveries(championship, championshipId, liveryPack([candidate.livery]))
        applying.push(candidate)
      } catch (e) {
        if (!(e instanceof LiveryPlanError)) throw e
        refused.push({
          id: candidate.id,
          driverName: candidate.livery.driverName,
          reason: e.message,
        })
      }
    }

    for (const r of refused) {
      process.stdout.write(`  refused  ${r.driverName.padEnd(18)} ${r.reason}\n`)
    }

    if (applying.length === 0) {
      process.stdout.write(`\nNothing left to apply.\n`)
      if (args.push) {
        const now = new Date()
        for (const r of refused) await queue.markRefused(r.id, r.reason, now)
      }
      return 1
    }

    const plan = planLiveries(
      championship,
      championshipId,
      liveryPack(applying.map((a) => a.livery)),
    )
    if (!options.quiet) process.stdout.write(`${renderPlan(plan)}\n`)

    if (!args.push) {
      process.stdout.write("\nPreview only. Re-run with --push to apply.\n")
      return plan.noop ? 1 : 0
    }

    const session = new AcsmSession({ baseUrl })
    await login(session)

    if (!args.yes && !(await confirm("\nApply these?"))) {
      process.stdout.write("Nothing sent.\n")
      return 0
    }

    const store = args.noStore ? undefined : await SqliteLiveryStore.open(storePath(args))
    try {
      // No `restartPracticeRound`, ever, on this path. A driver uploading at
      // 8pm must not be able to disconnect everyone in practice over a cosmetic
      // change; the livery appears at the next practice start, which is what
      // the bot's reply told them.
      const result = await applyLiveries(session, plan, {
        ...(store ? { record: store, source: "discord" as const } : {}),
      })
      const now = new Date()
      await queue.markApplied(
        applying.map((a) => a.id),
        now,
      )
      for (const r of refused) await queue.markRefused(r.id, r.reason, now)
      await queue.recordDrainRun(championshipId, now)

      // Timestamped under --watch, because this is the only line a daemon's log
      // will have and "when" is the first thing anyone reading it wants.
      const when = options.quiet ? `${now.toISOString()} ` : ""
      process.stdout.write(
        `${when}Applied ${result.uploaded.length} of ${waiting.length} for ${championshipId}, ` +
          `championship saved. Practice was not restarted — these appear at the next practice ` +
          `start.\n`,
      )
    } finally {
      store?.close()
    }
    return 0
  } finally {
    queue.close()
  }
}

/**
 * Drains on a timer, until something stops it
 * (docs/discord-livery-upload.md §5).
 *
 * **This process, not the bot.** The dial in the profile is called `autoApply`
 * and it is a claim about what is running here — the timer needs ACSM
 * credentials, and the whole design turns on the Discord-facing process not
 * having any. So `autoApply: true` in a profile with nothing running this is a
 * promise to drivers that nobody keeps, which is why each pass writes a
 * heartbeat and the bot degrades its wording when the heartbeat goes stale.
 *
 * **The queue is checked before the network.** An idle league is the common
 * case, and reading a local SQLite table costs nothing — so a watcher sitting
 * over an empty queue never logs in, never fetches an export, and never appears
 * in ACSM's logs at all.
 *
 * **Failures back off rather than exiting.** A watcher that dies on the first
 * timeout is a watcher an operator finds out about on race night. Bad
 * credentials are the exception: they will not fix themselves, and retrying a
 * login every two minutes for ever is a worse thing to do to a server than
 * stopping.
 */
async function watchDrain(args: Args, championshipId: string): Promise<number> {
  if (!args.push) {
    // A watcher that only previews looks exactly like a watcher that works,
    // in the logs and in the process list, while applying nothing at all.
    throw new UsageError(
      "--watch needs --push. Without it this would preview the same submissions every couple " +
        "of minutes for ever and apply none of them.",
    )
  }

  const intervalMs = args.intervalSeconds * 1000
  const maxBackoffMs = 15 * 60_000
  let consecutiveFailures = 0
  let stopping = false

  const stop = () => {
    // Sets a flag rather than exiting. A drain interrupted between the skin
    // upload and the championship save leaves a skin on the server that nothing
    // points at, so the loop finishes what it is doing first.
    if (stopping) return
    stopping = true
    process.stderr.write("\nStopping after this pass.\n")
  }
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)

  process.stderr.write(
    `Draining ${championshipId} every ${args.intervalSeconds}s. ` +
      `Uploads apply by themselves while this is running.\n`,
  )

  while (!stopping) {
    try {
      // `--yes` for the duration: a timer cannot answer a prompt, and a watcher
      // blocked on one would sit there looking healthy.
      await drain({ ...args, yes: true }, championshipId, { quiet: true })
      consecutiveFailures = 0
    } catch (e) {
      if (e instanceof AcsmAuthError) {
        process.stderr.write(
          `Stopping: ${e.message}\nBad credentials don't come right on their own, and retrying ` +
            `a login every ${args.intervalSeconds}s is worse for the server than stopping.\n`,
        )
        return 3
      }
      consecutiveFailures += 1
      process.stderr.write(
        `Drain failed (${consecutiveFailures} in a row): ${e instanceof Error ? e.message : e}\n`,
      )
    }

    if (stopping) break
    const backoff = Math.min(intervalMs * 2 ** consecutiveFailures, maxBackoffMs)
    await sleep(consecutiveFailures === 0 ? intervalMs : backoff, () => stopping)
  }

  return 0
}

/** Waits, but wakes early when asked to stop, so Ctrl-C isn't a two-minute wait. */
async function sleep(ms: number, cancelled: () => boolean): Promise<void> {
  const step = 250
  for (let waited = 0; waited < ms; waited += step) {
    if (cancelled()) return
    await new Promise((r) => setTimeout(r, Math.min(step, ms - waited)))
  }
}

/**
 * The operator half of the identity mapping (docs/discord-livery-upload.md §2).
 *
 * Releasing is deliberately not something a driver can do for themselves: a
 * driver who could release their own claim could release it the moment somebody
 * asked them to, which is most of the way to letting anyone take a name off
 * anyone.
 */
async function manageClaims(args: Args, championshipId: string): Promise<number> {
  const store = await SqliteClaimStore.open(storePath(args))
  try {
    if (args.release !== undefined) {
      const released = await store.release(args.release)
      if (!released) {
        process.stderr.write(`No claim held by ${args.release}. Nothing released.\n`)
        return 1
      }
      process.stdout.write(
        `Released ${args.release}, who was claimed as "${released.entrantName}". ` +
          `That name is free for someone else to claim.\n`,
      )
      return 0
    }

    const claims = await store.list()
    if (args.json) {
      process.stdout.write(`${JSON.stringify(claims, null, 2)}\n`)
      return claims.length === 0 ? 1 : 0
    }
    if (claims.length === 0) {
      process.stdout.write(
        `Nobody has claimed a driver yet, so nobody can upload a livery through Discord. ` +
          `Drivers claim themselves with /livery claim.\n`,
      )
      return 1
    }

    for (const c of claims) {
      const hint = await store.handleHint(c.entrantName)
      // The sign-up handle beside the claim, because agreeing and disagreeing
      // look different at a glance and that is the whole verification story.
      const note = !hint
        ? ""
        : hint.handle.toLowerCase() === (c.discordHandle ?? "").toLowerCase()
          ? "   (sign-up agrees)"
          : `   (sign-up says "${hint.handle}")`
      process.stdout.write(
        `  ${c.entrantName.padEnd(20)} ${(c.discordHandle ?? "?").padEnd(20)} ` +
          `${c.discordUserId}${note}\n`,
      )
    }
    process.stdout.write(`\n${claims.length} claimed. Championship: ${championshipId}\n`)
    return 0
  } finally {
    store.close()
  }
}

function storePath(args: Args): string {
  return args.store ?? resolve(process.cwd(), "data/liveries/liveries.db")
}

/**
 * Writes the carset. Reads the local store and talks to no server at all.
 *
 * Kept a separate path from the apply rather than a flag on it, because the two
 * have nothing in common: this needs no credentials, no championship export and
 * no network, and the thing it produces is for drivers rather than for the
 * server.
 */
async function writeCarset(args: Args, championshipId: string): Promise<number> {
  const store = await SqliteLiveryStore.open(storePath(args))
  let carset: Carset
  try {
    carset = buildCarset(championshipId, await store.read(championshipId))
  } finally {
    store.close()
  }

  if (carset.skins.length === 0) {
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
  await writeFile(path, carsetZip(carset))

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          path,
          digest: carset.digest,
          suggestedFilename: carsetFilename(carset),
          skins: carset.skins.map((s) => ({ driver: s.driverName, car: s.carModel, path: s.path })),
          missingPreviews: carset.missingPreviews,
          bytes: carset.bytes,
        },
        null,
        2,
      )}\n`,
    )
    return 0
  }

  process.stdout.write(
    `${carset.skins.length} ${carset.skins.length === 1 ? "livery" : "liveries"} across ` +
      `${carset.cars.length} ${carset.cars.length === 1 ? "car" : "cars"} → ${path}\n` +
      `Drivers can drop it on Content Manager, or extract it over their Assetto Corsa folder.\n`,
  )
  if (carset.missingPreviews.length > 0) {
    // Not a failure. It races fine and looks broken, which is the kind of thing
    // that generates a message on race night if nobody mentions it now.
    process.stdout.write(
      `\nNo preview.jpg for ${carset.missingPreviews.join(", ")} — those will show as blank ` +
        `tiles in Content Manager.\n`,
    )
  }
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
