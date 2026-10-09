/**
 * An MCP server over a folder of recorder journals, so a steward can talk an
 * incident through with whatever model their MCP client runs: Claude Desktop
 * or Claude Code on their own subscription, or a local model. champctl calls
 * no model and spends nothing.
 *
 * Written against the protocol directly rather than the official SDK, which
 * brings a web server stack along for transports this doesn't use. A stdio
 * server needs four methods: initialize, ping, tools/list and tools/call.
 */

import { readdir } from "node:fs/promises"
import { basename, join } from "node:path"
import { createInterface } from "node:readline"

import { analyzeIncident } from "./analysis.js"
import { DEFAULT_RULES, incidentBrief, LIMITS } from "./brief.js"
import type { IncidentThresholds } from "./incident.js"
import { listCollisions } from "./incident.js"
import { readJournal } from "./journal.js"
import { renderIncidentSvg } from "./render.js"
import { callName } from "./rules.js"

export interface McpOptions {
  journals: string
  acRoot: string
  rules?: string
  thresholds?: Partial<IncidentThresholds>
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
}

/** Newest first. A client that asks for one of these gets it back. */
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }

const SESSION_ARG = {
  type: "string",
  description: "A session's journal file name, as list_sessions gives it.",
}

const TOOLS = [
  {
    name: "list_sessions",
    description:
      "The recorded sessions: track, session, when, and how many car-to-car collisions each has.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
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
    name: "get_rules",
    description: "The league's racing rules, and what a recording can and can't show.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
]

export async function serveMcp(o: McpOptions): Promise<void> {
  const out = o.output ?? process.stdout
  const send = (msg: object): void => {
    out.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`)
  }

  /** A journal in the folder by its file name, and nothing outside it. */
  const journal = async (session: unknown): Promise<string> => {
    if (
      typeof session !== "string" ||
      basename(session) !== session ||
      !session.endsWith(".ndjson.gz")
    ) {
      throw new Error(`${JSON.stringify(session)} isn't a session name from list_sessions`)
    }
    const files = await readdir(o.journals)
    if (!files.includes(session)) throw new Error(`no session called ${session}`)
    return join(o.journals, session)
  }

  const tools: Record<string, (args: Record<string, unknown>) => Promise<Content[]>> = {
    async list_sessions() {
      const files = (await readdir(o.journals))
        .filter((f) => f.endsWith(".ndjson.gz"))
        .sort()
        .reverse()
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
      // Loaded here so `record`, which shares the CLI, never needs the native binary.
      const { createCanvas, loadImage } = await import("@napi-rs/canvas")
      const img = await loadImage(Buffer.from(svg))
      const canvas = createCanvas(img.width, img.height)
      canvas.getContext("2d").drawImage(img, 0, 0)
      const png = await canvas.encode("png")
      return [
        { type: "text", text: `${incidentBrief(packet, o.rules ?? DEFAULT_RULES)}\n\n${call}` },
        { type: "image", data: png.toString("base64"), mimeType: "image/png" },
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

  const handle = async (msg: unknown): Promise<void> => {
    if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
      send({ id: null, error: { code: -32600, message: "expected a JSON-RPC request object" } })
      return
    }
    const { id, method } = msg as { id?: unknown; method?: unknown }
    const raw = (msg as { params?: unknown }).params
    const params =
      typeof raw === "object" && raw !== null && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {}
    // Notifications have no id and get no answer.
    if (id === undefined) return
    switch (method) {
      case "initialize": {
        const asked = params["protocolVersion"]
        send({
          id,
          result: {
            protocolVersion:
              typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked)
                ? asked
                : PROTOCOL_VERSIONS[0],
            capabilities: { tools: {} },
            serverInfo: { name: "champctl-spectator", version: "0.1.0" },
            instructions:
              "Recorded race sessions and the collisions in them. Start with list_sessions, then list_incidents and get_incident. Facts come from a server-side recording; the suggested call is from fixed rules; the decision is a human steward's.",
          },
        })
        return
      }
      case "ping":
        send({ id, result: {} })
        return
      case "tools/list":
        send({ id, result: { tools: TOOLS } })
        return
      case "tools/call": {
        const name = params["name"]
        const tool =
          typeof name === "string" && Object.hasOwn(tools, name) ? tools[name] : undefined
        if (!tool) {
          send({ id, error: { code: -32602, message: `no tool called ${JSON.stringify(name)}` } })
          return
        }
        try {
          const args = params["arguments"]
          const content = await tool(
            typeof args === "object" && args !== null && !Array.isArray(args)
              ? (args as Record<string, unknown>)
              : {},
          )
          send({ id, result: { content } })
        } catch (e) {
          // A tool that fails tells the model why, as a result it can read,
          // rather than a protocol error it can't.
          send({
            id,
            result: {
              content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
              isError: true,
            },
          })
        }
        return
      }
      default:
        send({ id, error: { code: -32601, message: `method not found: ${String(method)}` } })
    }
  }

  const lines = createInterface({ input: o.input ?? process.stdin, crlfDelay: Infinity })
  const pending = new Set<Promise<void>>()
  for await (const line of lines) {
    if (!line.trim()) continue
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      send({ id: null, error: { code: -32700, message: "parse error" } })
      continue
    }
    // Whatever goes wrong answering one request must not take the server
    // down: the steward's client would lose it mid-conversation.
    const p = handle(msg)
      .catch((e: unknown) => {
        const id = (msg as { id?: unknown } | null)?.id
        if (id !== undefined) {
          send({ id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } })
        }
      })
      .finally(() => pending.delete(p))
    pending.add(p)
  }
  await Promise.all(pending)
}
