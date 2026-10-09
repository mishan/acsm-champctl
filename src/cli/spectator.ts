/**
 * `champctl-spectator`: a car on the server that records everyone else.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { type ReplaySummary, writeReplay } from "../spectator/acreplay.js"
import { analyzeIncident } from "../spectator/analysis.js"
import { incidentBrief } from "../spectator/brief.js"
import { listCollisions } from "../spectator/incident.js"
import { renderIncidentSvg } from "../spectator/render.js"
import { serveMcp } from "../spectator/mcp.js"
import { callName } from "../spectator/rules.js"
import { Recorder } from "../spectator/recorder.js"
import type { Vec3 } from "../spectator/protocol.js"
import { loadProfile } from "../profile/load.js"
import { defaultProfile, runCli, UsageError } from "./args.js"

export const USAGE = `champctl-spectator — records every race from a car parked on the server.

Usage:
  champctl-spectator record --server <host:port> --ac-root <dir> --car <model>
                            --guid <steam64> --out <dir> [options]
  champctl-spectator replay <journal.ndjson.gz> [--out <file>] [--interval <ms>]
                            [--cars <dir>]
  champctl-spectator incidents <journal.ndjson.gz>
  champctl-spectator incident <journal.ndjson.gz> <n> --ac-root <dir>
                              [--svg <file>] [--prompt] [--rules <file>]
                              [--profile <id|path>]
  champctl-spectator mcp --journals <dir> --ac-root <dir> [--rules <file>]
                         [--profile <id|path>]

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
  --out <dir>                where journals and replays go
  --park <x,y,z>             where the car sits (default: 1000 m above the
                             origin, clear of anything a car can drive into)
  --plugin-listen [host:]port receive the server's UDP plugin feed here, for
                             collisions; the plugin's Send Address in ACSM.
                             Listens on 127.0.0.1 unless a host is given
  --plugin-server <host:port> the plugin's Listen Address in ACSM
  --plugin-from <addr>       accept the feed only from this address (default:
                             the --plugin-server host). A server in Docker
                             sends from its container address
  --no-replay                keep journals only

Give the recorder a spectator car of its own in the championship, locked to
--guid, beside any stream car. ACSM leaves spectator cars out of points and
grid decisions and exempts them from Car Update Filtering, which an ordinary
entry would be subject to.

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
      replay: boolean
    }
  | { command: "replay"; journal: string; out?: string; intervalMs?: number; cars?: string }
  | { command: "incidents"; journal: string }
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

const COMMANDS = ["record", "replay", "incidents", "incident", "mcp"] as const

export function parseArgs(argv: readonly string[]): Args {
  const [first, ...rest] = argv
  if (first === undefined || first === "-h" || first === "--help") return { command: "help" }
  const command = COMMANDS.find((c) => c === first)
  if (!command) throw new UsageError(`Unknown command ${JSON.stringify(first)}.`)

  const flags = new Map<string, string>()
  const positional: string[] = []
  let noReplay = false
  let prompt = false
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    if (arg === "-h" || arg === "--help") return { command: "help" }
    if (arg === "--no-replay") {
      noReplay = true
    } else if (arg === "--prompt") {
      prompt = true
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
    if (v === undefined) throw new UsageError(`${command} needs ${flag}.`)
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
    args = {
      command,
      journal,
      ...(out ? { out } : {}),
      ...(intervalMs ? { intervalMs } : {}),
      ...(cars ? { cars } : {}),
    }
  } else {
    const server = hostPort("--server", need("--server"))
    const guid = need("--guid")
    if (!/^\d{17}$/.test(guid))
      throw new UsageError(`--guid must be a 17-digit Steam64 ID, not ${JSON.stringify(guid)}.`)
    const parkRaw = take("--park")
    const parts = (parkRaw ?? "0,1000,0").split(",")
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
    args = {
      command,
      ...server,
      acRoot: need("--ac-root"),
      car: need("--car"),
      guid,
      name: take("--name") ?? "Race Recorder",
      out: need("--out"),
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
  if (args.command === "incidents") {
    const list = await listCollisions(args.journal)
    if (list.length === 0) process.stdout.write("No collisions in this session.\n")
    for (const c of list) {
      const what =
        c.otherCarId === undefined
          ? `${c.drivers[0]} hit the scenery`
          : `${c.drivers[0]} hit ${c.drivers[1]}`
      process.stdout.write(
        `${c.index}  ${formatClock(c.at)}  ${what}, ${Math.round(c.impactSpeedKmh)} km/h\n`,
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
    const out = args.out ?? args.journal.replace(/(\.ndjson)?(\.gz)?$/, ".acreplay")
    const summary = await writeReplay(args.journal, out, {
      ...(args.intervalMs ? { intervalMs: args.intervalMs } : {}),
      ...(args.cars ? { carsDir: args.cars } : {}),
    })
    process.stdout.write(
      `${out}: ${summary.cars.length} cars, ${summary.frames} frames, ${Math.round(summary.durationMs / 1000)} s\n${defaultWheels(summary)}`,
    )
    return 0
  }

  await mkdir(args.out, { recursive: true })
  const toReplay = async (journal: string): Promise<void> => {
    const out = journal.replace(/\.ndjson\.gz$/, ".acreplay")
    try {
      // The AC root's copies hold every car on the grid, data and all.
      const s = await writeReplay(journal, out, { carsDir: join(args.acRoot, "content/cars") })
      log(`wrote ${out}: ${s.cars.length} cars, ${Math.round(s.durationMs / 1000)} s`)
      const fallback = defaultWheels(s)
      if (fallback) log(fallback.trim())
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
    outDir: args.out,
    ...(args.replay ? { onJournal: (j: string) => void toReplay(j) } : {}),
    log,
  })
  await recorder.start()
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      log("stopping")
      void recorder.stop().then(resolve)
    }
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
  })
  return 0
}

export async function run(argv: readonly string[]): Promise<void> {
  await runCli({ name: "champctl-spectator", usage: USAGE, main }, argv)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await run(process.argv.slice(2))
}
