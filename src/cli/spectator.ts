/**
 * `champctl-spectator`: a car on the server that records everyone else.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import { pathToFileURL } from "node:url"

import type { ReplaySummary } from "acreplay"
import { postToWebhook, replayMessage } from "../spectator/announce.js"
import { analyzeIncident, trackForJournal } from "../spectator/analysis.js"
import { findTrackSkips } from "../spectator/cuts.js"
import { ffmpegSink, loadClip, writeVideo } from "../spectator/video.js"
import { incidentBrief } from "../spectator/brief.js"
import { listCollisions } from "../spectator/incident.js"
import { sessionStart } from "../spectator/journal.js"
import { renderIncidentSvg } from "../spectator/render.js"
import { serveMcp } from "../spectator/mcp.js"
import { lastRound, organize } from "../spectator/rounds.js"
import { raceControlUrl } from "../spectator/racecontrol.js"
import { writeJournalReplay } from "../spectator/replay.js"
import { callName } from "../spectator/rules.js"
import { Recorder } from "../spectator/recorder.js"
import type { Vec3 } from "ac-spectator"
import { loadProfile } from "../profile/load.js"
import { defaultProfile, runCli, UsageError } from "./args.js"

export const USAGE = `champctl-spectator — records every race from a car parked on the server.

Usage:
  champctl-spectator record --server <host:port> --ac-root <dir> --car <model>
                            --guid <steam64> --out <dir> [options]
  champctl-spectator replay <journal.ndjson.gz> [--out <file>] [--interval <ms>]
                            [--from <m:ss>] [--to <m:ss>]
                            [--cars <dir>]
  champctl-spectator incidents <journal.ndjson.gz>
  champctl-spectator cuts <journal.ndjson.gz> --ac-root <dir> [--min-gain <s>]
  champctl-spectator video <journal.ndjson.gz> --ac-root <dir> --from <m:ss> --to <m:ss>
                           [--focus <driver,driver>] [--out <file.mp4>]
  champctl-spectator incident <journal.ndjson.gz> <n> --ac-root <dir>
                              [--svg <file>] [--prompt] [--rules <file>]
                              [--profile <id|path>]
  champctl-spectator mcp --journals <dir> --ac-root <dir> [--rules <file>]
                         [--profile <id|path>]
  champctl-spectator organize <dir> [--dry-run] [--profile <id|path>]

record joins the server as a car and stays: when ACSM moves to the next event
it rejoins. Each session becomes a journal in --out, and when the session ends
a .acreplay is written next to it, its wheels placed from each car's data in
<ac-root>/content/cars. replay does the same from --cars, an AC content/cars
folder; cars it can't read are drawn with a Nissan R32's wheel positions.

Record options:
  --server <host:port>       the game server's TCP port, as drivers connect
  --ac-root <dir>            copies of the league's AC files, laid out as in
                             an install: what the server checksums, and each
                             car's data (docs/spectator.md says which)
  --car <model>              the model of the slot to take
  --guid <steam64>           the GUID to join with
  --name <name>              driver name others see (default: Race Recorder)
  --out <dir>                where journals and replays go, a folder per
                             round: a track's practice server sessions, then
                             the championship event raced there
  --park <x,y,z>             where the car sits (default: 50 km off and 2 km
                             under the origin, out of sight from any track)
  --plugin-listen [host:]port receive the server's UDP plugin feed here, for
                             collisions; the plugin's Send Address in ACSM.
                             Listens on 127.0.0.1 unless a host is given
  --plugin-server <host:port> the plugin's Listen Address in ACSM
  --plugin-from <addr>       accept the feed only from this address (default:
                             the --plugin-server host). A server in Docker
                             sends from its container address
  --race-control <url>       take collisions from the server's ACSM live
                             timing instead of the plugin feed, for when no
                             admin can add a plugin. It doesn't say where on
                             the car the contact was
  --replay-url <url>         where champctl-serve publishes the replays, e.g.
                             https://champctl.example.org/replays. With
                             CHAMPCTL_REPLAY_WEBHOOK set to a Discord webhook,
                             each session's replay is posted there
  --profile <id|path>        the league profile, whose time zone dates the
                             round folders (default: $CHAMPCTL_PROFILE, else batl)
  --no-replay                keep journals only

Give the recorder a spectator car of its own in the championship, locked to
--guid, beside any stream car. ACSM leaves spectator cars out of points and
grid decisions and exempts them from Car Update Filtering, which an ordinary
entry would be subject to.

video draws that stretch from above as an MP4: the track, every car where the
recording put it, and the drivers named in --focus followed, with trails,
speeds and gears. Needs ffmpeg.

organize files recordings made before round folders into them, replays and
clips with the sessions they came from. Those don't say which sessions were the
championship event's, so each run of sessions on one track is a round. Run it
before the first recorder that writes rounds starts, or the round under way
splits in two. A journal written to in the last 10 minutes is left alone. --dry-run lists the
moves without making them.

cuts finds every time a car left the track and came back on further round,
having covered that stretch at least --min-gain seconds (default 1) faster
than its driver does on the track, measured against their own other laps.

incidents lists a session's car-to-car collisions, numbered. incident <n>
measures one: who was ahead, when they were alongside, who braked where, who
moved across whom. The track's racing line comes from
<ac-root>/content/tracks/<track>/[<layout>/]ai/fast_lane.ai. --svg draws it
from above.

It ends with a suggested call from fixed rules (no overlap at turn-in, moving
across a car alongside, a move under braking, contact from behind, rejoining),
naming the rule and its numbers, or "unclear" when none clearly applies. The
thresholds come from the league profile's incidentThresholds. --prompt prints
the incident written up for any chat model to give a second opinion on,
judged against --rules (a text file of the league's rules; common sim racing
conventions otherwise). champctl calls no model itself.

mcp serves the journals in --journals over MCP, on stdin and stdout, for a
steward's MCP client (Claude Desktop, Claude Code, a local model) to list
sessions and incidents and fetch one with its drawing and suggested call.

The join password, if the server has one, comes from
CHAMPCTL_SPECTATOR_PASSWORD rather than the command line, where anyone on the
machine could read it.

  -h, --help                 this
`

type Args =
  | { command: "help" }
  | {
      command: "record"
      host: string
      port: number
      acRoot: string
      car: string
      guid: string
      name: string
      out: string
      park: Vec3
      plugin?: {
        listenHost: string
        listenPort: number
        serverHost: string
        serverPort: number
        allowedSources?: string[]
      }
      raceControl?: string
      replayUrl?: string
      replay: boolean
      /** The league profile, for its time zone: round folders are named by the league's date. */
      profile: string
    }
  | {
      command: "replay"
      journal: string
      out?: string
      intervalMs?: number
      cars?: string
      window?: { fromMs: number; toMs: number }
    }
  | { command: "incidents"; journal: string }
  | { command: "cuts"; journal: string; acRoot: string; minSavedS: number }
  | { command: "organize"; dir: string; dryRun: boolean; profile: string }
  | {
      command: "video"
      journal: string
      acRoot: string
      fromMs: number
      toMs: number
      focus: string[]
      out?: string
    }
  | { command: "mcp"; journals: string; acRoot: string; rules?: string; profile: string }
  | {
      command: "incident"
      journal: string
      index: number
      acRoot: string
      svg?: string
      prompt: boolean
      rules?: string
      profile: string
    }

function hostPort(flag: string, v: string): { host: string; port: number } {
  const m = /^(.+):(\d+)$/.exec(v)
  const port = Number(m?.[2])
  if (!m || port < 1 || port > 65535)
    throw new UsageError(`${flag} must be host:port, not ${JSON.stringify(v)}.`)
  return { host: m[1]!, port }
}

function port(flag: string, v: string): number {
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1 || n > 65535)
    throw new UsageError(`${flag} must be a port number, not ${JSON.stringify(v)}.`)
  return n
}

const COMMANDS = [
  "record",
  "replay",
  "video",
  "incidents",
  "incident",
  "cuts",
  "mcp",
  "organize",
] as const

export function parseArgs(argv: readonly string[]): Args {
  const [first, ...rest] = argv
  if (first === undefined || first === "-h" || first === "--help") return { command: "help" }
  const command = COMMANDS.find((c) => c === first)
  if (!command) throw new UsageError(`Unknown command ${JSON.stringify(first)}.`)

  const flags = new Map<string, string>()
  const positional: string[] = []
  let noReplay = false
  let prompt = false
  let dryRun = false
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    if (arg === "-h" || arg === "--help") return { command: "help" }
    if (arg === "--no-replay") {
      noReplay = true
    } else if (arg === "--prompt") {
      prompt = true
    } else if (arg === "--dry-run") {
      dryRun = true
    } else if (arg.startsWith("--")) {
      const value = rest[++i]
      if (value === undefined) throw new UsageError(`${arg} needs a value.`)
      flags.set(arg, value)
    } else {
      positional.push(arg)
    }
  }
  const take = (flag: string): string | undefined => {
    const v = flags.get(flag)
    flags.delete(flag)
    return v
  }
  const need = (flag: string): string => {
    const v = take(flag)
    // Empty too: it's what deploy/compose.yml passes for a variable nobody set.
    if (!v) throw new UsageError(`${command} needs ${flag}.`)
    return v
  }

  let args: Args
  if (command === "mcp") {
    const rules = take("--rules")
    args = {
      command,
      journals: need("--journals"),
      acRoot: need("--ac-root"),
      ...(rules ? { rules } : {}),
      profile: take("--profile") ?? defaultProfile(),
    }
  } else if (command === "video") {
    const journal = positional.shift()
    if (journal === undefined) throw new UsageError("video needs a journal file.")
    const fromMs = clock("--from", need("--from"))
    const toMs = clock("--to", need("--to"))
    if (!(toMs > fromMs)) throw new UsageError("--to must be later than --from.")
    // A video is drawn frame by frame; ten minutes is already 18,000 of them.
    if (toMs - fromMs > 10 * 60_000)
      throw new UsageError("A video can be at most ten minutes long.")
    const focus = (take("--focus") ?? "")
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean)
    const out = take("--out")
    args = {
      command,
      journal,
      acRoot: need("--ac-root"),
      fromMs,
      toMs,
      focus,
      ...(out ? { out } : {}),
    }
  } else if (command === "organize") {
    const dir = positional.shift()
    if (dir === undefined) throw new UsageError("organize needs the recordings folder.")
    args = {
      command,
      dir,
      dryRun,
      profile: take("--profile") ?? defaultProfile(),
    }
  } else if (command === "cuts") {
    const journal = positional.shift()
    if (journal === undefined) throw new UsageError("cuts needs a journal file.")
    const min = take("--min-gain")
    const minSavedS = min === undefined ? 1 : Number(min)
    if (!(minSavedS > 0)) throw new UsageError("--min-gain must be a positive number of seconds.")
    args = { command, journal, acRoot: need("--ac-root"), minSavedS }
  } else if (command === "incidents" || command === "incident") {
    const journal = positional.shift()
    if (journal === undefined) throw new UsageError(`${command} needs a journal file.`)
    if (command === "incidents") {
      args = { command, journal }
    } else {
      const raw = positional.shift()
      const index = Number(raw)
      if (!Number.isInteger(index) || index < 0) {
        throw new UsageError(
          `incident needs a collision number from \`incidents\`, not ${JSON.stringify(raw)}.`,
        )
      }
      const svg = take("--svg")
      const rules = take("--rules")
      args = {
        command,
        journal,
        index,
        acRoot: need("--ac-root"),
        ...(svg ? { svg } : {}),
        prompt,
        ...(rules ? { rules } : {}),
        profile: take("--profile") ?? defaultProfile(),
      }
    }
  } else if (command === "replay") {
    const journal = positional.shift()
    if (journal === undefined) throw new UsageError("replay needs a journal file.")
    const out = take("--out")
    const interval = take("--interval")
    const intervalMs = interval === undefined ? undefined : Number(interval)
    if (intervalMs !== undefined && !(intervalMs > 0))
      throw new UsageError("--interval must be a positive number of ms.")
    const cars = take("--cars")
    const from = take("--from")
    const to = take("--to")
    const fromMs = from === undefined ? 0 : clock("--from", from)
    const toMs = to === undefined ? Number.POSITIVE_INFINITY : clock("--to", to)
    if (!(toMs > fromMs)) throw new UsageError("--to must be later than --from.")
    args = {
      command,
      journal,
      ...(out ? { out } : {}),
      ...(intervalMs ? { intervalMs } : {}),
      ...(cars ? { cars } : {}),
      ...(from !== undefined || to !== undefined ? { window: { fromMs, toMs } } : {}),
    }
  } else {
    const server = hostPort("--server", need("--server"))
    const guid = need("--guid")
    if (!/^\d{17}$/.test(guid))
      throw new UsageError(`--guid must be a 17-digit Steam64 ID, not ${JSON.stringify(guid)}.`)
    const parkRaw = take("--park")
    // Out of sight: a game shows a car 1000 m above the origin to anyone on a
    // track a kilometer across, and no track is 50 km across.
    const parts = (parkRaw ?? "50000,-2000,50000").split(",")
    // Number("") is 0, so "1,2," would otherwise park at 1,2,0.
    const park = parts.map((v) => (v.trim() === "" ? Number.NaN : Number(v)))
    if (park.length !== 3 || park.some((v) => !Number.isFinite(v))) {
      throw new UsageError(`--park must be x,y,z in meters, not ${JSON.stringify(parkRaw)}.`)
    }
    const listen = take("--plugin-listen")
    const pluginServer = take("--plugin-server")
    const pluginFrom = take("--plugin-from")
    if ((listen === undefined) !== (pluginServer === undefined)) {
      throw new UsageError("--plugin-listen and --plugin-server go together.")
    }
    if (pluginFrom !== undefined && listen === undefined) {
      throw new UsageError("--plugin-from needs --plugin-listen and --plugin-server.")
    }
    // Empty is unset, which is what deploy/compose.yml passes for a variable
    // nobody set.
    const replayUrl = take("--replay-url") || undefined
    if (replayUrl !== undefined && !/^https?:\/\//.test(replayUrl)) {
      throw new UsageError(
        `--replay-url must be where the replays page is, such as https://champctl.example.org/replays, not ${JSON.stringify(replayUrl)}.`,
      )
    }
    const raceControl = take("--race-control") || undefined
    if (raceControl !== undefined) {
      // Both would report every collision twice.
      if (listen !== undefined)
        throw new UsageError("Collisions come from --race-control or the plugin feed, not both.")
      try {
        raceControlUrl(raceControl)
      } catch {
        throw new UsageError(
          `--race-control must be the server's ACSM address, such as https://acsm.example.org, not ${JSON.stringify(raceControl)}.`,
        )
      }
    }
    args = {
      command,
      ...server,
      acRoot: need("--ac-root"),
      car: need("--car"),
      guid,
      name: take("--name") ?? "Race Recorder",
      out: need("--out"),
      profile: take("--profile") ?? defaultProfile(),
      park: park as Vec3,
      ...(listen && pluginServer
        ? {
            plugin: {
              ...(listen.includes(":")
                ? (({ host, port }) => ({ listenHost: host, listenPort: port }))(
                    hostPort("--plugin-listen", listen),
                  )
                : { listenHost: "127.0.0.1", listenPort: port("--plugin-listen", listen) }),
              serverHost: hostPort("--plugin-server", pluginServer).host,
              serverPort: hostPort("--plugin-server", pluginServer).port,
              ...(pluginFrom ? { allowedSources: [pluginFrom] } : {}),
            },
          }
        : {}),
      ...(raceControl ? { raceControl } : {}),
      ...(replayUrl ? { replayUrl } : {}),
      replay: !noReplay,
    }
  }
  if (positional.length)
    throw new UsageError(`Unexpected argument ${JSON.stringify(positional[0])}.`)
  const [unknown] = flags.keys()
  if (unknown) throw new UsageError(`Unknown option ${unknown} for ${command}.`)
  return args
}

/** Which car models got an R32's wheels because their own data couldn't be read. */
function defaultWheels(s: ReplaySummary): string {
  const models = [...new Set(s.cars.filter((c) => !c.ownWheels).map((c) => c.model))]
  return models.length
    ? `No car data for ${models.join(", ")}: drawn with a Nissan R32's wheel positions.\n`
    : ""
}

/** Recorder clock, ms since it started, as minutes and seconds. */
function formatClock(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

const log = (m: string): void => {
  process.stderr.write(`${new Date().toISOString()} ${m}\n`)
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv)
  if (args.command === "help") {
    process.stdout.write(USAGE)
    return 0
  }
  if (args.command === "mcp") {
    const profile = await loadProfile(args.profile)
    await serveMcp({
      journals: args.journals,
      acRoot: args.acRoot,
      ...(args.rules ? { rules: await readFile(args.rules, "utf8") } : {}),
      ...(profile.incidentThresholds ? { thresholds: profile.incidentThresholds } : {}),
    })
    return 0
  }
  if (args.command === "video") {
    const window = `-${formatClock(args.fromMs).replace(":", "m")}s-${formatClock(args.toMs).replace(":", "m")}s`
    const out = args.out ?? args.journal.replace(/(\.ndjson)?(\.gz)?$/, `${window}.mp4`)
    const track = await trackForJournal(args.journal, args.acRoot)
    const options = { fromMs: args.fromMs, toMs: args.toMs, focus: args.focus }
    const clip = await loadClip(args.journal, track, options)
    const followed = clip.cars.filter((c) => c.focused).map((c) => c.driver)
    if (followed.length > 0) process.stdout.write(`following ${followed.join(", ")}\n`)
    const frames = await writeVideo(clip, ffmpegSink(out, 1280, 720, 30), options).catch(
      async (e: unknown) => {
        // Half a video plays as if it were the whole of one.
        await rm(out, { force: true })
        throw e
      },
    )
    process.stdout.write(`${out}: ${frames} frames, ${clip.cars.length} cars\n`)
    return 0
  }
  if (args.command === "organize") {
    const { schedule } = await loadProfile(args.profile)
    const moves = await organize(args.dir, schedule.timezone, { dryRun: args.dryRun })
    for (const m of moves) process.stdout.write(`${m.from} -> ${m.to}\n`)
    process.stdout.write(
      moves.length === 0
        ? "Nothing to file.\n"
        : `${args.dryRun ? "Would move" : "Moved"} ${moves.length} ${moves.length === 1 ? "file" : "files"}.\n`,
    )
    return 0
  }
  if (args.command === "cuts") {
    const skips = await findTrackSkips(
      args.journal,
      await trackForJournal(args.journal, args.acRoot),
      args.minSavedS,
    )
    if (skips.length === 0)
      process.stdout.write(`Nobody gained ${args.minSavedS} s or more off the track.\n`)
    for (const k of skips) {
      process.stdout.write(
        `${formatClock(k.offS * 1000)}  ${k.driver}: ${Math.round(k.skippedM)} m of track in ${k.tookS.toFixed(1)} s off it, ` +
          `usually ${k.usualS.toFixed(1)} s (${k.passes} ${k.passes === 1 ? "pass" : "passes"}${k.field ? " by other drivers" : ""}): ${k.savedS.toFixed(1)} s gained. ` +
          `Back on at ${formatClock(k.backS * 1000)}.\n`,
      )
    }
    return 0
  }
  if (args.command === "incidents") {
    const list = await listCollisions(args.journal)
    // From the session's start, like --from and --to: the recorder's own clock
    // starts when it does, hours before a race.
    const start = await sessionStart(args.journal)
    if (list.length === 0) process.stdout.write("No collisions in this session.\n")
    for (const c of list) {
      const what =
        c.otherCarId === undefined
          ? `${c.drivers[0]} hit the scenery`
          : `${c.drivers[0]} hit ${c.drivers[1]}`
      process.stdout.write(
        `${c.index}  ${formatClock(c.at - start)}  ${what}, ${Math.round(c.impactSpeedKmh)} km/h\n`,
      )
    }
    return 0
  }
  if (args.command === "incident") {
    const profile = await loadProfile(args.profile)
    const { packet, suggestion, track } = await analyzeIncident(
      args.journal,
      args.index,
      args.acRoot,
      profile.incidentThresholds,
    )
    if (args.prompt) {
      const rules = args.rules ? await readFile(args.rules, "utf8") : undefined
      process.stdout.write(`${incidentBrief(packet, rules)}\n`)
      return 0
    }
    process.stdout.write(`${packet.facts.map((f) => `- ${f}`).join("\n")}\n`)
    process.stdout.write(
      `\nSuggested call: ${callName(suggestion.call, packet)}${suggestion.rule ? ` (rule: ${suggestion.rule})` : ""}\n${suggestion.reasons.map((r) => `- ${r}`).join("\n")}\nA steward makes the decision.\n`,
    )
    if (args.svg) {
      await writeFile(args.svg, renderIncidentSvg(packet, track))
      process.stdout.write(`\nDrawn to ${args.svg}\n`)
    }
    return 0
  }
  if (args.command === "replay") {
    const clip = args.window
      ? `-${formatClock(args.window.fromMs).replace(":", "m")}s-${Number.isFinite(args.window.toMs) ? `${formatClock(args.window.toMs).replace(":", "m")}s` : "end"}`
      : ""
    const out = args.out ?? args.journal.replace(/(\.ndjson)?(\.gz)?$/, `${clip}.acreplay`)
    const summary = await writeJournalReplay(args.journal, out, {
      ...(args.intervalMs ? { intervalMs: args.intervalMs } : {}),
      ...(args.cars ? { carsDir: args.cars } : {}),
      ...(args.window ? { window: args.window } : {}),
    })
    process.stdout.write(
      `${out}: ${summary.cars.length} cars, ${summary.frames} frames, ${Math.round(summary.durationMs / 1000)} s\n${defaultWheels(summary)}`,
    )
    return 0
  }

  await mkdir(args.out, { recursive: true })
  const timeZone = await loadProfile(args.profile).then(
    (p) => p.schedule.timezone,
    () => {
      log(`no league profile at ${args.profile}, so round folders are named by UTC dates`)
      return "UTC"
    },
  )
  const replays = new Set<Promise<void>>()
  // A secret, so from the environment rather than the command line.
  const webhook = replayWebhook(process.env["CHAMPCTL_REPLAY_WEBHOOK"])
  if (Boolean(webhook) !== Boolean(args.replayUrl)) {
    log(
      webhook
        ? "CHAMPCTL_REPLAY_WEBHOOK is set but --replay-url isn't, so there's no link to post"
        : "--replay-url is set but CHAMPCTL_REPLAY_WEBHOOK isn't, so nothing will be posted",
    )
  }
  const toReplay = async (journal: string): Promise<void> => {
    const out = journal.replace(/\.ndjson\.gz$/, ".acreplay")
    try {
      // The AC root's copies hold every car on the grid, data and all.
      const s = await writeJournalReplay(journal, out, {
        carsDir: join(args.acRoot, "content/cars"),
      })
      log(`wrote ${out}: ${s.cars.length} cars, ${Math.round(s.durationMs / 1000)} s`)
      const fallback = defaultWheels(s)
      if (fallback) log(fallback.trim())
      const message =
        webhook && args.replayUrl
          ? replayMessage(
              s,
              `${args.replayUrl.replace(/\/+$/, "")}/${relative(args.out, out).split(sep).map(encodeURIComponent).join("/")}`,
            )
          : undefined
      if (webhook && message) {
        await postToWebhook(webhook, message).catch((e: unknown) =>
          log(`couldn't post the replay to Discord: ${e instanceof Error ? e.message : String(e)}`),
        )
      }
    } catch (e) {
      log(`no replay from ${journal}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const recorder = new Recorder({
    client: {
      host: args.host,
      port: args.port,
      acRoot: args.acRoot,
      identity: {
        guid: args.guid,
        name: args.name,
        team: "",
        nation: "",
        car: args.car,
        password: process.env["CHAMPCTL_SPECTATOR_PASSWORD"] ?? "",
      },
      pose: () => ({ pos: args.park, rot: [0, 0, 0], vel: [0, 0, 0] }),
    },
    ...(args.plugin ? { plugin: { ...args.plugin, realtimeIntervalMs: 100 } } : {}),
    ...(args.raceControl ? { raceControl: { url: args.raceControl } } : {}),
    outDir: args.out,
    rounds: { timeZone, ...(await lastRound(args.out).then((last) => (last ? { last } : {}))) },
    ...(args.replay
      ? {
          onJournal: (j: string) => {
            const p = toReplay(j).finally(() => replays.delete(p))
            replays.add(p)
          },
        }
      : {}),
    log,
  })
  await recorder.start()
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      log("stopping")
      void recorder
        .stop()
        .then(() => Promise.all(replays))
        .then(() => resolve())
    }
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
  })
  // Everything is written. Node's WebSocket waits for the server to answer
  // its close, and ACSM behind Cloudflare never did: the process stayed up
  // after it had finished.
  process.exit(0)
}

/** "12:59", "1:02:03" or plain seconds, as a replay shows the time, to ms. */
function clock(flag: string, value: string): number {
  const parts = value.split(":")
  const n = parts.map(Number)
  // Digits only, and minutes and seconds under 60: Number() would take 1e3,
  // 0x10 and " 5", and 12:60 isn't a time anyone means.
  if (
    parts.length > 3 ||
    parts.some((p) => !/^\d+(\.\d+)?$/.test(p)) ||
    n.some((v, i) => i > 0 && v >= 60)
  ) {
    throw new UsageError(
      `${flag} must be a time into the session such as 12:59, not ${JSON.stringify(value)}.`,
    )
  }
  return Math.round(n.reduce((t, v) => t * 60 + v, 0) * 1000)
}

/**
 * The Discord webhook replays are posted to, checked up front. Never in a
 * message: its path is the token, and a URL fetch can't parse is quoted whole
 * in the error it throws.
 */
export function replayWebhook(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    new URL(value)
  } catch {
    throw new UsageError(
      "CHAMPCTL_REPLAY_WEBHOOK isn't a URL. It should be a Discord channel's webhook URL, as copied.",
    )
  }
  return value
}

export async function run(argv: readonly string[]): Promise<void> {
  await runCli({ name: "champctl-spectator", usage: USAGE, main }, argv)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await run(process.argv.slice(2))
}
