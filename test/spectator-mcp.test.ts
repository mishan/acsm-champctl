import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { JournalWriter } from "../src/spectator/journal.js"
import { serveMcp } from "../src/spectator/mcp.js"
import { fastLane, loop } from "./support/synthetic-track.js"

let dir: string
let acRoot: string
const SESSION = "2026-10-08-loop-race.ndjson.gz"

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mcp-"))
  acRoot = join(dir, "ac")
  await mkdir(join(acRoot, "content/tracks/loop/ai"), { recursive: true })
  await writeFile(join(acRoot, "content/tracks/loop/ai/fast_lane.ai"), fastLane(loop("left")))
  const journals = join(dir, "journals")
  await mkdir(journals)
  const w = new JournalWriter(join(journals, SESSION))
  w.write({
    t: "session",
    at: 0,
    serverName: "s",
    track: "loop",
    trackConfig: "",
    name: "Race",
    type: 3,
    recorderCarId: 0,
  })
  w.write({ t: "car", at: 0, carId: 1, model: "m", skin: "s", driver: "Ana" })
  w.write({ t: "car", at: 0, carId: 2, model: "m", skin: "s", driver: "Bo" })
  for (let t = 0; t <= 4000; t += 55) {
    for (const [carId, x] of [
      [1, 0],
      [2, -2],
    ] as const) {
      const z = 100 + (t / 1000) * 30 - (carId === 2 ? 1 : 0)
      w.write({
        t: "pos",
        at: t,
        car: {
          carId,
          seq: 0,
          timestamp: t,
          ping: 0,
          pos: [x, 0, z],
          rot: [0, 0, 0],
          vel: [0, 0, 30],
          steer: 0,
          rpm: 0,
          gear: 4,
          statusFlags: 0,
        },
      })
    }
  }
  w.write({
    t: "collision",
    at: 2000,
    carId: 2,
    otherCarId: 1,
    impactSpeed: 3,
    worldPos: [0, 0, 0],
    relPos: [0.7, 0, 0.5],
  })
  w.write({
    t: "collision",
    at: 3000,
    carId: 1,
    impactSpeed: 5,
    worldPos: [0, 0, 0],
    relPos: [0, 0, 1],
  })
  await w.close()
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Sends requests in order and returns the responses by id. */
interface Reply {
  result?: {
    content: { type: string; text: string; data: string; mimeType: string }[]
    isError?: boolean
    tools: { name: string }[]
  }
  error?: { code: number }
}

async function session(requests: object[]): Promise<Map<unknown, Reply>> {
  const input = new PassThrough()
  const output = new PassThrough()
  const lines: string[] = []
  output.on("data", (c: Buffer) => lines.push(...c.toString().split("\n").filter(Boolean)))
  const done = serveMcp({ journals: join(dir, "journals"), acRoot, input, output })
  for (const r of requests) input.write(`${JSON.stringify({ jsonrpc: "2.0", ...r })}\n`)
  input.end()
  await done
  return new Map(lines.map((l) => JSON.parse(l)).map((m) => [m.id, m]))
}

const call = (id: number, name: string, args: object = {}) => ({
  id,
  method: "tools/call",
  params: { name, arguments: args },
})

describe("serveMcp", () => {
  it("answers the protocol version a client asks for, and offers its tools", async () => {
    const r = await session([
      {
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      },
      { method: "notifications/initialized" },
      { id: 2, method: "tools/list" },
    ])
    expect(r.get(1)?.result).toMatchObject({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
    })
    expect(r.get(2)?.result?.tools.map((t) => t.name)).toEqual([
      "list_sessions",
      "list_incidents",
      "get_incident",
      "get_rules",
    ])
    // Notifications get no answer.
    expect(r.size).toBe(2)
  })

  it("lists sessions and their car-to-car collisions", async () => {
    const r = await session([
      call(1, "list_sessions"),
      call(2, "list_incidents", { session: SESSION }),
    ])
    expect(r.get(1)?.result?.content[0]?.text).toBe(
      `${SESSION}: loop, Race, 1 car-to-car collision`,
    )
    expect(r.get(2)?.result?.content[0]?.text).toMatch(
      /^0: Bo hit Ana, 11 km\/h\n1: Ana hit the scenery/,
    )
  })

  it("returns an incident as the brief, the suggested call and a drawing", async () => {
    const r = await session([call(1, "get_incident", { session: SESSION, index: 0 })])
    const [text, image] = r.get(1)!.result!.content
    expect(text!.text).toMatch(/^A collision in a sim racing league/)
    expect(text!.text).toMatch(/Suggested call from the rules engine: /)
    expect(image).toMatchObject({ type: "image", mimeType: "image/png" })
    expect(Buffer.from(image!.data, "base64").subarray(1, 4).toString()).toBe("PNG")
  })

  it.each([
    ["a path outside the folder", { session: "../journals/x.ndjson.gz" }, /isn't a session name/],
    ["a session that doesn't exist", { session: "nope.ndjson.gz" }, /no session called/],
  ])("refuses %s as a tool error the model can read", async (_, args, message) => {
    const r = await session([call(1, "list_incidents", args)])
    expect(r.get(1)?.result?.isError).toBe(true)
    expect(r.get(1)?.result?.content[0]?.text).toMatch(message)
  })

  it("answers malformed requests with errors and keeps serving", async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const lines: string[] = []
    output.on("data", (c: Buffer) => lines.push(...c.toString().split("\n").filter(Boolean)))
    const done = serveMcp({ journals: join(dir, "journals"), acRoot, input, output })
    input.write("null\n")
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: null })}\n`,
    )
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_sessions", arguments: null } })}\n`,
    )
    input.end()
    await done
    const replies = lines.map((l) => JSON.parse(l))
    expect(replies.find((m) => m.id === null)?.error.code).toBe(-32600)
    expect(replies.find((m) => m.id === 1)?.result.serverInfo.name).toBe("champctl-spectator")
    expect(replies.find((m) => m.id === 2)?.result.content[0].text).toMatch(
      /1 car-to-car collision/,
    )
  })

  it("says so for a method or tool it doesn't have", async () => {
    const r = await session([
      { id: 1, method: "resources/list" },
      call(2, "delete_everything"),
      call(3, "toString"),
      call(4, "constructor"),
    ])
    expect(r.get(1)?.error?.code).toBe(-32601)
    expect([2, 3, 4].map((id) => r.get(id)?.error?.code)).toEqual([-32602, -32602, -32602])
  })
})
