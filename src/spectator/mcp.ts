/**
 * The recordings as MCP tools: sessions, their collisions, and one collision
 * measured with a suggested call and a drawing, for a steward to talk an
 * incident through with a model. `champctl-spectator mcp` serves these alone;
 * `champctl-mcp` serves them with the rest of champctl.
 */

import { basename, join } from "node:path"

import { type Content, type McpTool, NO_ARGS, serveTools } from "../mcp/server.js"
import { analyzeIncident, trackForJournal } from "./analysis.js"
import { DEFAULT_RULES, incidentBrief, LIMITS } from "./brief.js"
import { findTrackSkips } from "./cuts.js"
import { svgToPng } from "./evidence.js"
import type { IncidentThresholds } from "./incident.js"
import { listCollisions } from "./incident.js"
import { readJournal } from "./journal.js"
import { listRecordings } from "./rounds.js"
import { renderIncidentSvg } from "./render.js"
import { callName } from "./rules.js"

export interface RecordingToolOptions {
  journals: string
  acRoot: string
  rules?: string
  thresholds?: Partial<IncidentThresholds>
}

export interface McpOptions extends RecordingToolOptions {
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
}

const SESSION_ARG = {
  type: "string",
  description: "A session's journal file name, as list_sessions gives it.",
}

const TOOLS = [
  {
    name: "list_sessions",
    description:
      "The recorded sessions: track, session, when, and how many car-to-car collisions each has.",
    inputSchema: NO_ARGS,
  },
  {
    name: "list_incidents",
    description: "A session's collisions, numbered, with who hit whom and the impact speed.",
    inputSchema: {
      type: "object",
      properties: { session: SESSION_ARG },
      required: ["session"],
      additionalProperties: false,
    },
  },
  {
    name: "get_incident",
    description:
      "One collision, measured from the recording: who was ahead, when they overlapped, who braked where, who moved across whom, a timeline of both cars, a suggested call from fixed rules, and a drawing from above. The call is the rules engine's; the decision is a human steward's.",
    inputSchema: {
      type: "object",
      properties: {
        session: SESSION_ARG,
        index: { type: "integer", minimum: 0, description: "The number from list_incidents." },
      },
      required: ["session", "index"],
      additionalProperties: false,
    },
  },
  {
    name: "list_track_skips",
    description:
      "Every time a car left the track and came back on further round having covered that stretch at least a second faster than its driver usually does on the track: a big cut. Times are into the session.",
    inputSchema: {
      type: "object",
      properties: { session: SESSION_ARG },
      required: ["session"],
      additionalProperties: false,
    },
  },
  {
    name: "get_rules",
    description: "The league's racing rules, and what a recording can and can't show.",
    inputSchema: NO_ARGS,
  },
]

export function recordingTools(o: RecordingToolOptions): McpTool[] {
  /** A journal in the folder by its file name, and nothing outside it. */
  const journal = async (session: unknown): Promise<string> => {
    if (
      typeof session !== "string" ||
      !session.endsWith(".ndjson.gz") ||
      session.split("/").includes("..")
    ) {
      throw new Error(`${JSON.stringify(session)} isn't a session name from list_sessions`)
    }
    // Only a name the folder lists, so nothing outside it can be asked for.
    const files = await listRecordings(o.journals, ".ndjson.gz")
    if (!files.includes(session)) throw new Error(`no session called ${session}`)
    return join(o.journals, session)
  }

  const tools: Record<string, (args: Record<string, unknown>) => Promise<Content[]>> = {
    async list_sessions() {
      // Newest first, by the recorder's timestamp leading each name, whichever round it's in.
      const files = (await listRecordings(o.journals, ".ndjson.gz")).sort((a, b) =>
        basename(b).localeCompare(basename(a)),
      )
      const lines: string[] = []
      for (const f of files) {
        const path = join(o.journals, f)
        let what = "no session record"
        for await (const r of readJournal(path)) {
          if (r.t === "session") {
            what = `${r.track}${r.trackConfig ? ` (${r.trackConfig})` : ""}, ${r.name}`
            break
          }
        }
        const collisions = (await listCollisions(path)).filter(
          (c) => c.otherCarId !== undefined,
        ).length
        lines.push(
          `${f}: ${what}, ${collisions} car-to-car ${collisions === 1 ? "collision" : "collisions"}`,
        )
      }
      return [{ type: "text", text: lines.length ? lines.join("\n") : "No sessions recorded yet." }]
    },
    async list_incidents(args) {
      const list = await listCollisions(await journal(args["session"]))
      const lines = list.map((c) =>
        c.otherCarId === undefined
          ? `${c.index}: ${c.drivers[0]} hit the scenery, ${Math.round(c.impactSpeedKmh)} km/h (not analyzable: no other car)`
          : `${c.index}: ${c.drivers[0]} hit ${c.drivers[1]}, ${Math.round(c.impactSpeedKmh)} km/h`,
      )
      return [
        { type: "text", text: lines.length ? lines.join("\n") : "No collisions in this session." },
      ]
    },
    async get_incident(args) {
      const index = args["index"]
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
        throw new Error("index must be a collision number from list_incidents")
      }
      const { packet, suggestion, track } = await analyzeIncident(
        await journal(args["session"]),
        index,
        o.acRoot,
        o.thresholds,
      )
      const call = `Suggested call from the rules engine: ${callName(suggestion.call, packet)}${suggestion.rule ? ` (rule: ${suggestion.rule})` : ""}\n${suggestion.reasons.map((r) => `- ${r}`).join("\n")}`
      const svg = renderIncidentSvg(packet, track)
      const png = await svgToPng(svg)
      return [
        { type: "text", text: `${incidentBrief(packet, o.rules ?? DEFAULT_RULES)}\n\n${call}` },
        { type: "image", data: png.toString("base64"), mimeType: "image/png" },
      ]
    },
    async list_track_skips(args) {
      const path = await journal(args["session"])
      const skips = await findTrackSkips(path, await trackForJournal(path, o.acRoot))
      const clock = (s: number) =>
        `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`
      const lines = skips.map(
        (k) =>
          `${clock(k.offS)}  ${k.driver}: ${Math.round(k.skippedM)} m of track in ${k.tookS.toFixed(1)} s off it, usually ${k.usualS.toFixed(1)} s${k.field ? " for other drivers" : ""}: ${k.savedS.toFixed(1)} s gained. Back on at ${clock(k.backS)}.`,
      )
      return [
        {
          type: "text",
          text: lines.length ? lines.join("\n") : "Nobody gained a second or more off the track.",
        },
      ]
    },
    async get_rules() {
      return [
        {
          type: "text",
          text: `League rules:\n${o.rules ?? DEFAULT_RULES}\n\nWhat the recording can't show:\n${LIMITS}`,
        },
      ]
    },
  }

  return TOOLS.map((t) => ({ ...t, run: tools[t.name]! }))
}

export async function serveMcp(o: McpOptions): Promise<void> {
  await serveTools({
    name: "champctl-spectator",
    version: "0.1.0",
    instructions:
      "Recorded race sessions and the collisions in them. Start with list_sessions, then list_incidents and get_incident. Facts come from a server-side recording; the suggested call is from fixed rules; the decision is a human steward's.",
    tools: recordingTools(o),
    ...(o.input ? { input: o.input } : {}),
    ...(o.output ? { output: o.output } : {}),
  })
}
