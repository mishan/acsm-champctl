/**
 * A stdio MCP server: champctl's tools offered to whatever model an MCP client
 * runs, Claude Desktop or Claude Code on the user's own subscription, or a
 * local model. champctl calls no model and spends nothing.
 *
 * Written against the protocol directly rather than the official SDK, which
 * brings a web server stack along for transports this doesn't use. A stdio
 * server needs four methods: initialize, ping, tools/list and tools/call.
 */

import { createInterface } from "node:readline"

/** Newest first. A client that asks for one of these gets it back. */
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]

export type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }

export interface McpTool {
  name: string
  description: string
  inputSchema: object
  /** A thrown error reaches the model as a result it can read, not a protocol error. */
  run(args: Record<string, unknown>): Promise<Content[]>
}

export interface ServeOptions {
  name: string
  version: string
  /** What the model is told the server is for, and where to start. */
  instructions: string
  tools: readonly McpTool[]
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
}

export const NO_ARGS = { type: "object", properties: {}, additionalProperties: false }

export async function serveTools(o: ServeOptions): Promise<void> {
  const out = o.output ?? process.stdout
  const send = (msg: object): void => {
    out.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`)
  }
  const byName = new Map(o.tools.map((t) => [t.name, t]))
  const listed = o.tools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }))

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
            serverInfo: { name: o.name, version: o.version },
            instructions: o.instructions,
          },
        })
        return
      }
      case "ping":
        send({ id, result: {} })
        return
      case "tools/list":
        send({ id, result: { tools: listed } })
        return
      case "tools/call": {
        const name = params["name"]
        const tool = typeof name === "string" ? byName.get(name) : undefined
        if (!tool) {
          send({ id, error: { code: -32602, message: `no tool called ${JSON.stringify(name)}` } })
          return
        }
        try {
          const args = params["arguments"]
          const content = await tool.run(
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
