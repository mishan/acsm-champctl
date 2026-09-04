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
import { HttpAcsmReader, type AcsmReader } from "../acsm/client.js"
import { GatewayTransport } from "../bot/discord.js"
import { nightlyMessages } from "../bot/message.js"
import { findingsAtOrAbove, nightly, type NightlyEntry } from "../bot/nightly.js"
import { BotError, RecordingTransport, type DiscordTransport } from "../bot/transport.js"
import type { Severity } from "../gridmom/finding.js"
import { DEFAULT_MIN_SEVERITY } from "../gridmom/report.js"
import { loadProfile } from "../profile/load.js"
import { loadPits, reportUsageError, runCli, UsageError } from "./args.js"

const USAGE = `champctl-bot — champctl's voice in Discord

Usage:
  champctl-bot report                 check every championship and post what's wrong

Options:
  --profile <id|path>   league profile (default: batl)
  --channel <id>        override the profile's discord.adminChannelId
  --pits <path>         track pit table JSON (default: data/track-pits.json)
  --min <severity>      ERROR | WARN | INFO     (default: WARN)
  --suppress <codes>    comma-separated finding codes or prefixes to hide
  --all                 include championships whose every round has been raced
  --dry-run             print what would be posted; talk to nobody
  --base-url <url>      override the profile's ACSM base URL
  --no-cache            bypass the on-disk response cache
  --now <iso>           pretend it is this time (for the schedule checks)
  -h, --help            this

Exit codes:
  0  nothing worth reporting
  1  warnings only
  2  at least one error, or a championship that couldn't be read
  3  the run itself failed

The bot token comes from CHAMPCTL_DISCORD_TOKEN and is never a flag — a flag
lands in shell history and in every ps listing on the box. There is deliberately
no way to give this command ACSM credentials.
`

/** Identifies bot traffic in ACSM's logs, distinctly from gridmom's and the archive's. */
export const BOT_USER_AGENT = "acsm-champctl/0.1 (bot)"

/** The token's only home. Read here so nothing else has to know the name. */
export const TOKEN_ENV = "CHAMPCTL_DISCORD_TOKEN"

interface Args {
  command: string
  profile: string
  channel?: string
  pits?: string
  min?: Severity
  suppress: string[]
  all: boolean
  dryRun: boolean
  baseUrl?: string
  cache: boolean
  now?: Date
  help: boolean
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    command: "",
    profile: "batl",
    suppress: [],
    all: false,
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
  if (rest.length > 1) {
    const extra = rest.slice(1).map((x) => JSON.stringify(x))
    throw new UsageError(
      `${args.command} takes no arguments, but got ${extra.join(", ")}. ` +
        `Did that belong to an option, such as --channel?`,
    )
  }
  return args
}

function parseSeverity(v: string): Severity {
  const up = v.toUpperCase()
  if (up === "ERROR" || up === "WARN" || up === "INFO") return up
  throw new UsageError(`--min must be ERROR, WARN or INFO`)
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
  if (args.command !== "report") throw new UsageError(`Unknown command ${args.command}`)

  const profile = await loadProfile(args.profile)
  const baseUrl = args.baseUrl ?? profile.acsmBaseUrl
  if (!baseUrl) {
    throw new UsageError(
      `No ACSM base URL. Set acsmBaseUrl in the ${args.profile} profile, or pass --base-url.`,
    )
  }

  const channelId = args.channel ?? profile.discord?.adminChannelId
  // Refused before a single request goes out. A nightly job that walks a whole
  // server and then discovers it has nowhere to say so has spent the league's
  // rate limit to produce nothing.
  if (!channelId && !args.dryRun) {
    throw new UsageError(
      `No Discord channel. Set discord.adminChannelId in the ${args.profile} profile, pass ` +
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

      const report = await nightly(reader, {
        profile,
        pits: await loadPits(args.pits),
        includeFinished: args.all,
        suppress: args.suppress,
        ...(args.now ? { now: args.now } : {}),
        onProgress: (entry) => process.stderr.write(`${describe(entry)}\n`),
      })

      // Resolved once, used twice. These two decide different things — what goes
      // in the channel, and what cron is told the night was like — and they have
      // to be the same number. Reading the default separately at each call site
      // is how they drift, silently and in both directions: a bot that posts
      // warnings and exits 0, or one that exits 1 having said nothing.
      const minSeverity = args.min ?? DEFAULT_MIN_SEVERITY
      const messages = nightlyMessages(report, { minSeverity })

      for (const content of messages) {
        // `channelId` is non-empty here for a real post; a dry run records
        // whatever it was given and prints it below.
        await transport.post({ channelId: channelId ?? "(dry run)", content })
      }

      if (args.dryRun) {
        for (const m of messages) process.stdout.write(`${m}\n\n`)
      }

      const counts = findingsAtOrAbove(report, minSeverity)
      process.stdout.write(
        `${summarise(report.checked, report.finished, report.failed, messages.length)}\n`,
      )
      return exitCodeFor(counts, report.failed)
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

function summarise(checked: number, finished: number, failed: number, posted: number): string {
  const parts = [`${checked} checked`]
  if (finished) parts.push(`${finished} already run`)
  if (failed) parts.push(`${failed} failed`)
  parts.push(`${posted} ${posted === 1 ? "message" : "messages"}`)
  return parts.join(", ")
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
