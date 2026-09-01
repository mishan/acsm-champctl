#!/usr/bin/env node
/**
 * champctl-bot — what champctl says in Discord (plan §7).
 *
 * One command so far: the nightly gridmom report. The bot holds **no ACSM
 * credentials, ever** — it reads through Public Access and posts a message, and
 * anything that would change a championship is a link into `champctl-serve`
 * that a person clicks under their own login.
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
import { announce, NothingToAnnounce, type Announcement } from "../bot/announce.js"
import { GatewayTransport } from "../bot/discord.js"
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
import { loadProfile } from "../profile/load.js"
import type { LeagueProfile } from "../profile/types.js"
import { loadPits, reportUsageError, runCli, UsageError } from "./args.js"

const USAGE = `champctl-bot — champctl's voice in Discord

Usage:
  champctl-bot report                       check every championship, post what's wrong
  champctl-bot announce <champ-id> [round]  post the next round's details
  champctl-bot standings <champ-id>         post the championship standings

Options:
  --profile <id|path>   league profile (default: batl)
  --channel <id>        override the channel this command posts to
  --pits <path>         track pit table JSON (default: data/track-pits.json)
  --min <severity>      ERROR | WARN | INFO     (default: WARN)   [report]
  --suppress <codes>    comma-separated finding codes or prefixes  [report]
  --all                 include championships already fully raced   [report]
  --source <where>      endpoint | export | auto  (default: auto) [standings]
  --dry-run             print what would be posted; talk to nobody
  --base-url <url>      override the profile's ACSM base URL
  --no-cache            bypass the on-disk response cache
  --now <iso>           pretend it is this time, for the checks     [report]
  -h, --help            this

Exit codes:
  0  nothing worth reporting / posted fine
  1  warnings only                                                  [report]
  2  at least one error, or something couldn't be read
  3  the run itself failed

report posts to discord.adminChannelId; announce and standings post to
discord.announceChannelId, which is the channel drivers read.

announce and standings are one-shot: they post once and exit, so cron decides
when a round gets announced and champctl keeps no record of having done it.

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
  all: boolean
  source: StandingsSourceOption
  dryRun: boolean
  baseUrl?: string
  cache: boolean
  now?: Date
  help: boolean
}

/** Commands taking a championship id, and how many extra positionals each allows. */
const COMMANDS: Record<string, { positionals: number }> = {
  report: { positionals: 0 },
  announce: { positionals: 2 },
  standings: { positionals: 1 },
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    command: "",
    profile: "batl",
    suppress: [],
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

  const shape = COMMANDS[args.command]
  if (args.command && shape === undefined) throw new UsageError(`Unknown command ${args.command}`)

  const positionals = rest.slice(1)
  if (shape && positionals.length > shape.positionals) {
    const extra = positionals.slice(shape.positionals).map((x) => JSON.stringify(x))
    throw new UsageError(
      `${args.command} takes ${shape.positionals === 0 ? "no arguments" : `at most ${shape.positionals}`}, ` +
        `but got ${extra.join(", ")}. Did that belong to an option, such as --channel?`,
    )
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
  const n = Number(v)
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
 */
export function channelFor(
  command: string,
  profile: LeagueProfile,
): { id: string | undefined; key: string } {
  if (command === "report") {
    return { id: profile.discord?.adminChannelId, key: "adminChannelId" }
  }
  return { id: profile.discord?.announceChannelId, key: "announceChannelId" }
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

      const post = async (messages: readonly string[]): Promise<void> => {
        for (const content of messages) {
          // `channelId` is non-empty here for a real post; a dry run records
          // whatever it was given and prints it afterwards.
          await transport.post({ channelId: channelId ?? "(dry run)", content })
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
  const championship = await reader.exportChampionship(id)

  let announcement: Announcement
  try {
    announcement = announce(championship, {
      profile,
      baseUrl: args.baseUrl ?? profile.acsmBaseUrl ?? "",
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
    throw e
  }

  await post([announcement.content])
  process.stdout.write(`Announced round ${announcement.round}.\n`)
  return 0
}

async function runStandings(
  reader: AcsmReader,
  args: Args,
  baseUrl: string,
  post: Post,
): Promise<number> {
  const id = requireChampionshipId(args, "standings")
  const championship = await reader.exportChampionship(id)
  const subject = championship.Name?.trim() || id

  const resolved = await resolveStandings(reader, championship, id, args, baseUrl)
  if (!resolved) {
    process.stderr.write(`No standings for ${subject}.\n`)
    return 2
  }

  const messages = standingsMessage(subject, resolved)
  await post(messages)
  process.stdout.write(
    `Posted ${messages.length} ${messages.length === 1 ? "message" : "messages"} from the ${resolved.source}.\n`,
  )
  return 0
}

/**
 * Standings from wherever `--source` allows, and the cross-check between them.
 *
 * Under `auto` the endpoint wins and the export is computed anyway, purely so
 * the two can be compared — see `compareStandings` for why that is worth a
 * request champctl already has cached. The disagreement goes to stderr, never
 * to the channel.
 */
async function resolveStandings(
  reader: AcsmReader,
  championship: Championship,
  id: string,
  args: Args,
  baseUrl: string,
): Promise<Standings | undefined> {
  const computed = args.source === "endpoint" ? undefined : computeStandings(championship)

  if (args.source === "export") {
    if (!computed || isUnscorable(computed)) {
      process.stderr.write(
        `champctl can't work these standings out: ${computed ? computed.reason : "no export"}\n`,
      )
      return undefined
    }
    return { source: "export", classes: computed }
  }

  let fromEndpoint: StandingsClass[] | undefined
  try {
    fromEndpoint = parseStandings(await reader.standings(id))
    if (!fromEndpoint) {
      // The endpoint answered with something champctl doesn't recognise. Worth
      // saying loudly: its shape has never been measured, and this is the only
      // moment anyone would find out it changed.
      process.stderr.write(
        `${baseUrl} answered standings.json in a shape champctl doesn't recognise. ` +
          `Run npm run recon:standings against it and send the output.\n`,
      )
    }
  } catch (e) {
    // Premium-only, so a 404 here is an OSS build rather than a fault.
    process.stderr.write(`standings.json didn't answer (${asMessage(e)}); using the export.\n`)
  }

  if (fromEndpoint && computed && !isUnscorable(computed)) {
    for (const line of compareStandings(fromEndpoint, computed)) {
      process.stderr.write(`disagreement: ${line}\n`)
    }
  }

  if (fromEndpoint) return { source: "endpoint", classes: fromEndpoint }

  if (args.source === "endpoint") return undefined
  if (!computed || isUnscorable(computed)) {
    process.stderr.write(
      `champctl can't work these standings out either: ${computed ? computed.reason : "no export"}\n`,
    )
    return undefined
  }
  return { source: "export", classes: computed }
}

function requireChampionshipId(args: Args, command: string): string {
  if (!args.championshipId) throw new UsageError(`${command} needs a championship id`)
  return args.championshipId
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
