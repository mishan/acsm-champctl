#!/usr/bin/env node
/**
 * champctl-bot — what champctl says in Discord (plan §7).
 *
 * Four commands: the nightly gridmom report, the week's round announcement,
 * the championship standings, and `serve`, which answers `/livery`. The bot holds **no ACSM credentials,
 * ever** — it reads through Public Access and posts a message, and anything
 * that would change a championship is a link into `champctl-serve` that a
 * person clicks under their own login.
 *
 * Exit code is the contract for cron, and it matches gridmom's and the
 * archive's: 0 nothing worth saying, 1 warnings, 2 errors or a championship
 * that couldn't be read, 3 the run itself failed. A timer can decide whether to
 * page anyone without parsing a word of the output.
 */

import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { SqliteCache } from "../acsm/cache.js"
import { asMessage, HttpAcsmReader, type AcsmReader } from "../acsm/client.js"
import type { Championship } from "../acsm/types.js"
import { announce, NothingToAnnounce, RoundRefused, type Announcement } from "../bot/announce.js"
import { LIVERY_COMMANDS } from "../bot/commands.js"
import { GatewayTransport } from "../bot/discord.js"
import { LiveryRouter, liveryRouterSettings } from "../bot/livery-router.js"
import { nightlyMessages, standingsMessage } from "../bot/message.js"
import { findingsAtOrAbove, nightly, type NightlyEntry } from "../bot/nightly.js"
import {
  compareStandings,
  computeStandings,
  isUnscorable,
  parseStandings,
  type Standings,
  type StandingsClass,
} from "../bot/standings.js"
import { BotError, RecordingTransport, type DiscordTransport } from "../bot/transport.js"
import type { Severity } from "../gridmom/finding.js"
import { DEFAULT_MIN_SEVERITY } from "../gridmom/report.js"
import { SqliteClaimStore } from "../liveries/claims.js"
import { defaultStorePath } from "../sqlite.js"
import { SqliteSubmissionQueue } from "../liveries/queue.js"
import { SqliteLiveryStore } from "../liveries/store.js"
import { SqliteTokenStore } from "../liveries/upload-token.js"
import { loadProfile } from "../profile/load.js"
import type { LeagueProfile } from "../profile/types.js"
import { loadPits, reportUsageError, runCli, UsageError } from "./args.js"

const USAGE = `champctl-bot — champctl's voice in Discord

Usage:
  champctl-bot report                       check every championship, post what's wrong
  champctl-bot announce <champ-id> [round]  post the next round's details
  champctl-bot standings <champ-id>         post the championship standings
  champctl-bot serve                        answer /livery until stopped

Options:
  --profile <id|path>   league profile (default: batl)
  --channel <id>        override the channel this command posts to
  --pits <path>         track pit table JSON (default: data/track-pits.json)
  --min <severity>      ERROR | WARN | INFO     (default: WARN)   [report]
  --suppress <codes>    comma-separated finding codes or prefixes  [report]
  --all                 include championships already fully raced   [report]
  --source <where>      endpoint | export | auto  (default: auto) [standings]
  --dry-run             print what would be posted; talk to nobody
  --store <path>        queue, claims and tokens, shared with champctl-liveries
                        (default: $CHAMPCTL_STORE, else data/liveries/liveries.db)
  --register-only       publish the slash commands and exit, without serving
  --base-url <url>      override the profile's ACSM base URL
  --no-cache            bypass the on-disk response cache
  --now <iso>           pretend it is this time           [report, announce]
  -h, --help            this

Exit codes:
  0  nothing worth reporting / posted fine
  1  warnings only                                                  [report]
     the two standings sources disagreed, or ACSM's was unreadable  [standings]
  2  at least one error, or something couldn't be read
  3  the run itself failed

report posts to discord.adminChannelId; announce and standings post to
discord.announceChannelId, which is the channel drivers read.

announce and standings are one-shot: they post once and exit, so cron decides
when a round gets announced and champctl keeps no record of having done it.

The serve command takes drivers' liveries and writes them to the local queue.
It cannot put them on the game server: that is champctl-liveries --drain, the
process holding the credentials. Uploads apply by themselves only while
--drain --watch is running, and the bot checks that rather than assuming it.

The bot token comes from CHAMPCTL_DISCORD_TOKEN and is never a flag — a flag
lands in shell history and in every ps listing on the box. There is deliberately
no way to give this command ACSM credentials.
`

/** Identifies bot traffic in ACSM's logs, distinctly from gridmom's and the archive's. */
export const BOT_USER_AGENT = "acsm-champctl/0.1 (bot)"

/** The token's only home. Read here so nothing else has to know the name. */
export const TOKEN_ENV = "CHAMPCTL_DISCORD_TOKEN"

/** Where standings are allowed to come from. See `src/bot/standings.ts`. */
export type StandingsSourceOption = "endpoint" | "export" | "auto"

interface Args {
  command: string
  championshipId?: string
  round?: number
  profile: string
  channel?: string
  pits?: string
  min?: Severity
  suppress: string[]
  store?: string
  registerOnly: boolean
  all: boolean
  source: StandingsSourceOption
  dryRun: boolean
  baseUrl?: string
  cache: boolean
  now?: Date
  help: boolean
}

/** Channel keys a command may post to. Named so neither can be typed as a string. */
type ChannelKey = "adminChannelId" | "announceChannelId"

interface CommandShape {
  /** Positionals it must be given. */
  required: number
  /** Positionals it may be given at most. */
  positionals: number
  /** Where it posts. Absent for serve, which reads the admin channel itself. */
  channel?: ChannelKey
}

/**
 * Every command: its positionals, and which channel it posts to.
 *
 * One table rather than two. The channel used to be decided by a separate
 * `command === "report"` test, which is the shape that drifts — and here it
 * drifted in the dangerous direction, since anything that was not "report"
 * came back as the league's channel.
 */
const COMMANDS: Record<string, CommandShape> = {
  report: { required: 0, positionals: 0, channel: "adminChannelId" },
  announce: { required: 1, positionals: 2, channel: "announceChannelId" },
  standings: { required: 1, positionals: 1, channel: "announceChannelId" },
  serve: { required: 0, positionals: 0 },
}

/**
 * A command's entry, or undefined for anything that isn't one.
 *
 * Own properties only. `COMMANDS["constructor"]` is Object's constructor, not
 * undefined, so a plain lookup took "constructor", "toString" and "__proto__"
 * for commands — and `channelFor` resolved them to `discord.undefined`.
 */
function commandShape(name: string): CommandShape | undefined {
  return Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    command: "",
    profile: "batl",
    suppress: [],
    registerOnly: false,
    all: false,
    source: "auto",
    dryRun: false,
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
      case "--profile":
        args.profile = next()
        break
      case "--channel":
        args.channel = next()
        break
      case "--pits":
        args.pits = next()
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
      case "--all":
        args.all = true
        break
      case "--source":
        args.source = parseSource(next())
        break
      case "--dry-run":
        args.dryRun = true
        break
      case "--store":
        args.store = next()
        break
      case "--register-only":
        args.registerOnly = true
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
      // A token on the command line is readable by every process on the
      // machine and lands in shell history, so the flag people will reach for
      // says no rather than being quietly absent.
      case "--token":
      case "--discord-token":
        throw new UsageError(
          `${a} is not a thing. Put the bot token in ${TOKEN_ENV} — a token in a command line ` +
            `is in your shell history and in every ps listing on the box.`,
        )
      default:
        if (a.startsWith("-")) throw new UsageError(`Unknown option ${a}`)
        rest.push(a)
    }
  }

  args.command = rest[0] ?? ""

  const shape = commandShape(args.command)
  if (args.command && shape === undefined) throw new UsageError(`Unknown command ${args.command}`)

  if (args.command === "serve") {
    // serve is a live service, and there is nothing it can do without logging
    // in and answering people. It honoured neither flag — --dry-run registered
    // commands for real — so both are refused rather than quietly ignored.
    if (args.dryRun) {
      throw new UsageError(
        "serve has no dry run: it would still log in and answer drivers. " +
          "--register-only checks the wiring and exits.",
      )
    }
    if (args.channel) {
      throw new UsageError(
        "serve takes no --channel: its notices go to discord.adminChannelId in the profile.",
      )
    }
  }

  const positionals = rest.slice(1)
  if (shape && positionals.length > shape.positionals) {
    const extra = positionals.slice(shape.positionals).map((x) => JSON.stringify(x))
    throw new UsageError(
      `${args.command} takes ${shape.positionals === 0 ? "no arguments" : `at most ${shape.positionals}`}, ` +
        `but got ${extra.join(", ")}. Did that belong to an option, such as --channel?`,
    )
  }

  // Here rather than when the command runs, which was after the profile, the
  // channel and the Discord login — so the first error was about a channel
  // nobody had got to yet. Not under --help, which should just print the usage.
  if (shape && !args.help && positionals.length < shape.required) {
    throw new UsageError(`${args.command} needs a championship id`)
  }

  if (positionals[0] !== undefined) args.championshipId = positionals[0]
  if (positionals[1] !== undefined) args.round = parseRound(positionals[1])

  return args
}

function parseSource(v: string): StandingsSourceOption {
  if (v === "endpoint" || v === "export" || v === "auto") return v
  throw new UsageError(`--source must be endpoint, export or auto`)
}

function parseSeverity(v: string): Severity {
  const up = v.toUpperCase()
  if (up === "ERROR" || up === "WARN" || up === "INFO") return up
  throw new UsageError(`--min must be ERROR, WARN or INFO`)
}

/**
 * A round number, 1-based, as a league counts them.
 *
 * Rejected rather than coerced: `Number("2nd")` is NaN and `parseInt("2nd")` is
 * 2, and a command that quietly announced round 2 because someone typed the
 * round they meant in words is worse than one that says what it wanted.
 */
function parseRound(v: string): number {
  // Digits first, then Number. Number alone reads "0x2", "1e1" and " 2 ", so
  // this coerced after all — "1e1" announced round 10.
  const n = /^\d+$/.test(v) ? Number(v) : Number.NaN
  if (!Number.isInteger(n) || n < 1) {
    throw new UsageError(`Round must be a whole number from 1, not ${JSON.stringify(v)}`)
  }
  return n
}

/**
 * 2 beats 1 beats 0, and a championship nobody could read counts as a 2.
 *
 * The archive's rule, for the archive's reason: a night that reported cleanly
 * on eleven championships and could not reach the twelfth has something for a
 * person to look at, and "clean" is the wrong word for it.
 */
export function exitCodeFor(counts: Record<Severity, number>, failed: number): number {
  if (counts.ERROR > 0 || failed > 0) return 2
  return counts.WARN > 0 ? 1 : 0
}

/**
 * Which channel a command posts to, and the profile key that configures it.
 *
 * gridmom goes to the admins; announcements and standings go to the league.
 * Resolved per command with **no fallback between them**, and that is the
 * safety property rather than a tidiness one: gridmom quotes the entry list, so
 * a report falling back to the announce channel would tell everyone which three
 * drivers are about to be dropped from the grid. Refusing with "set
 * discord.adminChannelId" is the correct outcome for a half-configured profile.
 *
 * A command with no entry in `COMMANDS` is refused rather than defaulted. This
 * asked `command === "report"` and treated everything else as an announcement,
 * so the fallback it exists to prevent was one typo away: any string that was
 * not exactly "report" resolved to the channel the whole league reads.
 */
export function channelFor(
  command: string,
  profile: LeagueProfile,
): { id: string | undefined; key: ChannelKey } {
  const known = commandShape(command)
  if (!known) throw new UsageError(`Unknown command ${command}`)
  if (!known.channel) throw new UsageError(`${command} doesn't post to a channel of its own`)
  return { id: profile.discord?.[known.channel], key: known.channel }
}

export function describe(entry: NightlyEntry): string {
  const who = entry.name ? `${entry.name} (${entry.championshipId})` : entry.championshipId
  switch (entry.kind) {
    case "checked": {
      const { ERROR, WARN } = entry.report.counts
      return `checked    ${who} — ${ERROR} errors, ${WARN} warnings`
    }
    case "finished":
      return `finished   ${who} — every round has been raced`
    case "failed":
      return `FAILED     ${who} — ${entry.error}`
    default: {
      const never: never = entry
      return String(never)
    }
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  try {
    return await runCommand(argv)
  } catch (e) {
    if (e instanceof UsageError) return reportUsageError(e, USAGE)
    if (e instanceof BotError) {
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
  if (args.command === "serve") return await serve(args)

  const profile = await loadProfile(args.profile)
  const baseUrl = args.baseUrl ?? profile.acsmBaseUrl
  if (!baseUrl) {
    throw new UsageError(
      `No ACSM base URL. Set acsmBaseUrl in the ${args.profile} profile, or pass --base-url.`,
    )
  }

  const configured = channelFor(args.command, profile)
  const channelId = args.channel ?? configured.id
  // Refused before a single request goes out. A job that walks a whole server
  // and then finds it has nowhere to say so has spent the league's rate limit
  // to produce nothing.
  if (!channelId && !args.dryRun) {
    throw new UsageError(
      `No Discord channel. Set discord.${configured.key} in the ${args.profile} profile, pass ` +
        `--channel, or use --dry-run to see what would be posted.`,
    )
  }

  return await withResources(
    {
      transport: async () => (args.dryRun ? new RecordingTransport() : connect()),
      cache: async () =>
        args.cache
          ? SqliteCache.open({ path: resolve(process.cwd(), ".cache/acsm/cache.db") })
          : undefined,
    },
    async (transport, cache) => {
      const reader: AcsmReader = new HttpAcsmReader({
        baseUrl,
        userAgent: BOT_USER_AGENT,
        ...(cache ? { cache } : {}),
      })

      // Named for the transport's errors. No test sees this wiring: the dry-run
      // transport never fails a channel, and a real one needs a login. What the
      // transport does with it is covered in test/bot-gateway.test.ts.
      const source = args.channel
        ? "--channel"
        : `discord.${configured.key} in the ${args.profile} profile`
      const post = async (messages: readonly string[]): Promise<void> => {
        for (const content of messages) {
          // `channelId` is non-empty here for a real post; a dry run records
          // whatever it was given and prints it afterwards.
          await transport.post({ channelId: channelId ?? "(dry run)", content, source })
        }
        if (args.dryRun) for (const m of messages) process.stdout.write(`${m}\n\n`)
      }

      switch (args.command) {
        case "report":
          return await runReport(reader, profile, args, post)
        case "announce":
          return await runAnnounce(reader, profile, args, post)
        case "standings":
          return await runStandings(reader, args, baseUrl, post)
        default:
          throw new UsageError(`Unknown command ${args.command}`)
      }
    },
  )
}

/**
 * Opens both, runs the job, and closes whatever managed to open.
 *
 * Both acquisitions are inside the guard, not just the second. The cache used
 * to be opened after the gateway and outside it, so a cache that wouldn't open
 * — a full disk, a `.cache` nobody can write — left a signed-in client that
 * nothing destroyed. A half-open client keeps the process alive on its
 * reconnect timer, so the CLI hung rather than exiting non-zero, which from
 * cron reads as a nightly job that is merely slow. `GatewayTransport.login`
 * destroys the client on a failed login for the same reason.
 */
export async function withResources<C extends { close: () => void }, T>(
  open: { transport: () => Promise<DiscordTransport>; cache: () => Promise<C | undefined> },
  use: (transport: DiscordTransport, cache: C | undefined) => Promise<T>,
): Promise<T> {
  let transport: DiscordTransport | undefined
  let cache: C | undefined
  try {
    transport = await open.transport()
    cache = await open.cache()
    return await use(transport, cache)
  } finally {
    await transport?.close()
    cache?.close()
  }
}

type Post = (messages: readonly string[]) => Promise<void>

async function runReport(
  reader: AcsmReader,
  profile: LeagueProfile,
  args: Args,
  post: Post,
): Promise<number> {
  const report = await nightly(reader, {
    profile,
    pits: await loadPits(args.pits),
    includeFinished: args.all,
    suppress: args.suppress,
    ...(args.now ? { now: args.now } : {}),
    onProgress: (entry) => process.stderr.write(`${describe(entry)}\n`),
  })

  // Resolved once, used twice. These two decide different things — what goes in
  // the channel, and what cron is told the night was like — and they have to be
  // the same number. Reading the default separately at each call site is how
  // they drift, silently and in both directions: a bot that posts warnings and
  // exits 0, or one that exits 1 having said nothing.
  const minSeverity = args.min ?? DEFAULT_MIN_SEVERITY
  const messages = nightlyMessages(report, { minSeverity })
  await post(messages)

  const parts = [`${report.checked} checked`]
  if (report.finished) parts.push(`${report.finished} already run`)
  if (report.failed) parts.push(`${report.failed} failed`)
  parts.push(`${messages.length} ${messages.length === 1 ? "message" : "messages"}`)
  process.stdout.write(`${parts.join(", ")}\n`)

  return exitCodeFor(findingsAtOrAbove(report, minSeverity), report.failed)
}

async function runAnnounce(
  reader: AcsmReader,
  profile: LeagueProfile,
  args: Args,
  post: Post,
): Promise<number> {
  const id = requireChampionshipId(args, "announce")

  let championship: Championship
  try {
    championship = await reader.exportChampionship(id)
  } catch (e) {
    // 2, which is what the usage promises for something that couldn't be read.
    // Left to runCli it was a 3, "the run itself failed" — the code a timer
    // pages somebody over, for what is usually a mistyped id.
    const why = e instanceof Error ? e.message : String(e)
    process.stderr.write(`Couldn't read championship ${id}: ${why}\n`)
    return 2
  }

  let announcement: Announcement
  try {
    announcement = announce(championship, {
      profile,
      baseUrl: args.baseUrl ?? profile.acsmBaseUrl ?? "",
      now: args.now ?? new Date(),
      ...(args.round === undefined ? {} : { round: args.round }),
    })
  } catch (e) {
    // Not an error. A season that has finished is the ordinary end state, and a
    // cron entry that exits 3 every week after the last race is one people
    // silence rather than fix.
    if (e instanceof NothingToAnnounce) {
      process.stdout.write(`${e.message}\n`)
      return 0
    }
    // Somebody asked for a round by number and it can't be announced. This
    // shared the branch above and exited 0, so a typo'd round read to cron as a
    // successful post.
    if (e instanceof RoundRefused) {
      process.stderr.write(`${e.message}\n`)
      return 2
    }
    throw e
  }

  await post([announcement.content])
  process.stdout.write(`Announced round ${announcement.round}.\n`)
  return 0
}

/** Exported for the tests, like `resolveStandings` and for the same reason. */
export async function runStandings(
  reader: AcsmReader,
  args: Args,
  baseUrl: string,
  post: Post,
): Promise<number> {
  const id = requireChampionshipId(args, "standings")

  let championship: Championship | undefined
  try {
    championship = await reader.exportChampionship(id)
  } catch (e) {
    // Under --source endpoint the export is only for the championship's name,
    // and losing it costs the heading, not the table. Anywhere else it is what
    // the standings come from or are checked against, so this is 2 — "couldn't
    // be read" — rather than the 3 that escaping to runCli made it.
    if (args.source !== "endpoint") {
      process.stderr.write(`Couldn't read championship ${id}: ${asMessage(e)}\n`)
      return 2
    }
    process.stderr.write(`Couldn't read championship ${id} (${asMessage(e)}); naming it by id.\n`)
  }
  const subject = championship?.Name?.trim() || id

  const resolved = await resolveStandings(reader, championship, id, args, baseUrl)
  if (!resolved) {
    process.stderr.write(`No standings for ${subject}.\n`)
    return 2
  }

  const messages = standingsMessage(subject, resolved)
  // Said in its own words rather than as "Posted 0 messages", which is what a
  // shape champctl had misread used to look like from cron. Nobody having
  // scored yet is a real state — week one, every season — and it should not
  // read the same as a bug.
  if (messages.length === 0) {
    process.stdout.write(`Nobody has scored in ${subject} yet, so there is nothing to post.\n`)
    return resolved.warned ? 1 : 0
  }

  await post(messages)
  process.stdout.write(
    `Posted ${messages.length} ${messages.length === 1 ? "message" : "messages"} from the ${resolved.source}.\n`,
  )
  // 1 when the post went out but something about it needs a person: the two
  // sources disagreed, or ACSM answered in a shape champctl can't read. Said
  // only on stderr, it exited 0, and from cron nobody sees stderr — so the
  // cross-check that keeps the fallback honest was reporting to no one.
  return resolved.warned ? 1 : 0
}

/**
 * Standings from wherever `--source` allows, and the cross-check between them.
 *
 * Under `auto` the endpoint wins and the export is computed anyway, purely so
 * the two can be compared — see `compareStandings` for why that is worth a
 * request champctl already has cached. The disagreement goes to stderr, never
 * to the channel, and into `warned`, which is the exit code.
 */
export async function resolveStandings(
  reader: AcsmReader,
  championship: Championship | undefined,
  id: string,
  args: Args,
  baseUrl: string,
): Promise<ResolvedStandings | undefined> {
  // Undefined means the export is not on the table at all, which only
  // `--source endpoint` asks for — the one case where `runStandings` carries on
  // without the export, too. Every other path either answers from it or checks
  // the endpoint against it.
  const computed =
    args.source === "endpoint" || championship === undefined
      ? undefined
      : computeStandings(championship)

  if (computed && args.source === "export") {
    if (isUnscorable(computed)) {
      process.stderr.write(`champctl can't work these standings out: ${computed.reason}\n`)
      return undefined
    }
    return { source: "export", classes: computed, warned: false }
  }

  let warned = false
  let fromEndpoint: StandingsClass[] | undefined
  try {
    fromEndpoint = parseStandings(await reader.standings(id))
    if (!fromEndpoint) {
      warned = true
      // The endpoint answered with something champctl doesn't recognise. Worth
      // saying loudly: its shape has never been measured, and this is the only
      // moment anyone would find out it changed.
      process.stderr.write(
        `${baseUrl} answered standings.json in a shape champctl doesn't recognise. ` +
          `Run npm run recon:standings against it and send the output.\n`,
      )
    }
  } catch (e) {
    // Premium-only, so a 404 here is an OSS build rather than a fault. What
    // happens next depends on what this run is allowed to fall back to, and
    // this said "using the export" even under `--source endpoint`, which
    // forbids exactly that — describing the opposite of what it then did.
    const next =
      args.source === "endpoint" ? "and --source endpoint rules out the export" : "using the export"
    process.stderr.write(`standings.json didn't answer (${asMessage(e)}); ${next}.\n`)
  }

  if (fromEndpoint && computed) {
    if (isUnscorable(computed)) {
      // Said out loud rather than passed over. The cross-check is the thing
      // keeping the fallback honest, so a run where it could not happen has to
      // say so — silence here reads as the two sources agreeing. BATL's own
      // 2x20 is this case on every run.
      process.stderr.write(`not comparable: ${computed.reason}\n`)
    } else {
      for (const line of compareStandings(fromEndpoint, computed)) {
        process.stderr.write(`disagreement: ${line}\n`)
        warned = true
      }
    }
  }

  if (fromEndpoint) return { source: "endpoint", classes: fromEndpoint, warned }
  if (!computed) return undefined

  if (isUnscorable(computed)) {
    process.stderr.write(`champctl can't work these standings out either: ${computed.reason}\n`)
    return undefined
  }
  return { source: "export", classes: computed, warned }
}

/** Standings to post, and whether anything about them needs a person to look. */
export interface ResolvedStandings extends Standings {
  warned: boolean
}

/**
 * The id, narrowed. `parseArgs` has already refused a command missing it, so
 * the throw is unreachable from the CLI; it stays for the type, not as a check.
 */
function requireChampionshipId(args: Args, command: string): string {
  if (!args.championshipId) throw new UsageError(`${command} needs a championship id`)
  return args.championshipId
}

/**
 * Answers `/livery` until something stops the process
 * (docs/discord-livery-upload.md §3).
 *
 * The last mile, and it changes nothing about what the bot may do. It opens the
 * queue, the claims and the tokens — all local SQLite — and a *read-only* ACSM
 * reader for the entry list, which needs no login because the export is public.
 * There is still no way to give this process credentials, and
 * `test/bot.test.ts` walks the module graph to keep it that way.
 */
async function serve(args: Args): Promise<number> {
  const profile = await loadProfile(args.profile)
  const baseUrl = args.baseUrl ?? profile.acsmBaseUrl
  if (!baseUrl) {
    throw new UsageError(
      `No ACSM base URL. Set acsmBaseUrl in the ${args.profile} profile, or pass --base-url.`,
    )
  }

  const guildId = profile.discord?.guildId
  if (!guildId) {
    // Refused before connecting. A bot that logs in and then has nowhere to
    // publish its commands sits there looking healthy and answering nothing.
    throw new UsageError(
      `No Discord server. Set discord.guildId in the ${args.profile} profile — /livery is ` +
        `registered per server, not globally, so it needs to know which one.`,
    )
  }
  if (!profile.discord?.livery) {
    throw new UsageError(
      `This profile has no discord.livery section, so the league hasn't turned livery uploads ` +
        `on. Add one — an empty object accepts uploads from anyone, anywhere, which is probably ` +
        `not what you want.`,
    )
  }

  const storePath = args.store ?? defaultStorePath()
  const claims = await SqliteClaimStore.open(storePath)
  const queue = await SqliteSubmissionQueue.open(storePath)
  const tokens = await SqliteTokenStore.open(storePath)
  const liveries = await SqliteLiveryStore.open(storePath)
  const transport = await connect()

  try {
    if (!(transport instanceof GatewayTransport)) {
      throw new BotError("serve needs a real Discord connection.")
    }
    await transport.registerCommands(guildId, LIVERY_COMMANDS)
    process.stderr.write(`Registered /livery in ${guildId}.\n`)
    if (args.registerOnly) return 0

    const livery = profile.discord.livery
    const router = new LiveryRouter({
      reader: new HttpAcsmReader({ baseUrl, userAgent: BOT_USER_AGENT }),
      claims,
      queue,
      tokens,
      store: liveries,
      ...liveryRouterSettings(livery),
    })

    transport.listen(router, {
      ...(profile.discord.adminChannelId ? { adminChannelId: profile.discord.adminChannelId } : {}),
    })
    process.stderr.write(
      `Answering /livery. Uploads go to ${storePath}; champctl-liveries --drain applies them.\n`,
    )

    await new Promise<void>((done) => {
      const stop = () => done()
      process.once("SIGINT", stop)
      process.once("SIGTERM", stop)
    })
    return 0
  } finally {
    // Closed in reverse, and the databases last: SQLite leaves a -wal beside
    // the file, and a queue whose log was never checkpointed is one the drain
    // reads short.
    await transport.close()
    liveries.close()
    tokens.close()
    queue.close()
    claims.close()
  }
}

async function connect(): Promise<DiscordTransport> {
  const token = process.env[TOKEN_ENV]
  if (!token) {
    throw new UsageError(
      `No bot token. Put it in ${TOKEN_ENV}, or use --dry-run to see what would be posted.`,
    )
  }
  return GatewayTransport.login({ token })
}

/** Entry point used by both `bin/champctl-bot.js` and `npm run bot`. */
export async function run(argv: readonly string[]): Promise<void> {
  await runCli({ name: "champctl-bot", usage: USAGE, main }, argv)
}

// Run when executed directly, not when imported by a test.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await run(process.argv.slice(2))
}
