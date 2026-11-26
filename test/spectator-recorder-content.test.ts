import { createServer, type Server } from "node:http"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { ContentFiles } from "../src/spectator/content.js"
import { Recorder, type RecorderOptions } from "../src/spectator/recorder.js"
import { type FakeAcServer, fakeAcRoot, fakeAcServer } from "./support/fake-ac-server.js"

const MODELS = "content/tracks/imola/models.ini"
const SURFACES = "content/tracks/imola/data/surfaces.ini"
const ACD = "content/cars/ks_mazda_mx5_cup/data.acd"
const LINE = "content/tracks/imola/ai/fast_lane.ai"

let dir: string
let hand: string
let server: FakeAcServer
let http: Server
let base: string
let served: Set<string>
let requests: string[]
let content: ContentFiles | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "recorder-content-"))
  hand = join(dir, "hand")
  await mkdir(hand)
  await fakeAcRoot(hand)
  server = await fakeAcServer()
  served = new Set()
  requests = []
  http = createServer((req, res) => {
    const path = (req.url ?? "").slice(1)
    requests.push(path)
    if (served.has(path)) res.writeHead(200).end("x")
    else res.writeHead(404).end()
  })
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${(http.address() as { port: number }).port}`
})
afterEach(async () => {
  await content?.idle()
  content = undefined
  await server.close()
  await new Promise<void>((r) => http.close(() => r()))
  await rm(dir, { recursive: true, force: true })
})

async function recorder(extra: Partial<RecorderOptions> = {}): Promise<{
  rec: Recorder
  content: ContentFiles
  said: string[]
}> {
  const said: string[] = []
  const files = await ContentFiles.open({
    handRoot: hand,
    mirrorRoot: join(dir, "mirror"),
    acsmBase: base,
  })
  const rec = new Recorder({
    client: {
      host: "127.0.0.1",
      port: server.port,
      acRoot: hand,
      identity: {
        guid: "76561198000000001",
        name: "rec",
        team: "",
        nation: "",
        car: "ks_mazda_mx5_cup",
        password: "",
      },
      pose: () => ({ pos: [0, 1000, 0], rot: [0, 0, 0], vel: [0, 0, 0] }),
    },
    content: files,
    outDir: dir,
    retryMs: { min: 20, max: 20 },
    settleMs: 50,
    log: (m) => said.push(m),
    ...extra,
  })
  content = files
  return { rec, content: files, said }
}

const settle = (ms = 150): Promise<void> => new Promise((r) => setTimeout(r, ms))
/** The car slot the recorder took, as it said when it joined. */
function kick(said: string[], reason: number): Buffer {
  const carId = Number(said.join("\n").match(/ as car (\d+)/)?.[1])
  return Buffer.from([0x68, carId, reason])
}

describe("Recorder content", () => {
  it("joins with a track file it lacked, fetched from Server Manager", async () => {
    await rm(join(hand, MODELS))
    served.add(MODELS)
    const { rec, said } = await recorder()
    await rec.start()
    await server.joins(1)
    await settle()
    await rec.stop()
    expect(said.join("\n")).toMatch(/could not join: .*models\.ini/)
    expect(said.join("\n")).toMatch(/joined imola/)
    expect(requests).toContain(MODELS)
  })

  it.each([
    ["fetches the racing line of a track it joins", false, 1],
    ["leaves a racing line the hand copy has", true, 0],
  ])("%s", async (_, inHand, asked) => {
    if (inHand) {
      await mkdir(join(hand, "content/tracks/imola/ai"), { recursive: true })
      await writeFile(join(hand, LINE), "x")
    }
    served.add(LINE)
    const { rec, content } = await recorder()
    await rec.start()
    await server.joins(1)
    await settle()
    await content.idle()
    await rec.stop()
    expect(requests.filter((p) => p === LINE)).toHaveLength(asked)
  })

  it("asks for fresh copies of the files a join used, after a checksum kick", async () => {
    await mkdir(join(hand, "content/cars/ks_mazda_mx5_cup"), { recursive: true })
    await writeFile(join(hand, ACD), "x")
    served.add(SURFACES).add(MODELS)
    const { rec, said } = await recorder()
    await rec.start()
    await server.joins(1)
    await settle()
    expect(requests.filter((p) => p === SURFACES || p === MODELS)).toEqual([])
    server.sendTcp(kick(said, 3))
    await server.joins(2)
    await rec.stop()
    expect(requests).toEqual(expect.arrayContaining([SURFACES, MODELS]))
  })

  it("blames a missing file, not the ones it had, for a checksum kick", async () => {
    served.add(SURFACES).add(MODELS).add(ACD)
    const { rec, said } = await recorder()
    await rec.start()
    await server.joins(1)
    await settle()
    server.sendTcp(kick(said, 3))
    await server.joins(2)
    await rec.stop()
    expect(requests, "the car's data.acd, sent as zeros").toContain(ACD)
    expect(requests.filter((p) => p === SURFACES || p === MODELS)).toEqual([])
  })

  it("asks for nothing fresh after a kick for any other reason", async () => {
    const { rec, said } = await recorder()
    await rec.start()
    await server.joins(1)
    await settle()
    server.sendTcp(kick(said, 4))
    await server.joins(2)
    await rec.stop()
    expect(requests.filter((p) => p === SURFACES || p === MODELS)).toEqual([])
  })

  it("backs off while every join is kicked before it holds", async () => {
    const { rec, said } = await recorder({ retryMs: { min: 20, max: 10_000 }, settleMs: 10_000 })
    let joins = 0
    let done = false
    void (async () => {
      while (!done) {
        await server.joins(++joins)
        server.sendTcp(kick(said, 4))
      }
    })()
    await rec.start()
    await settle(1000)
    done = true
    await rec.stop()
    // 20, 40, 80, 160, 320 ms: six joins, where resetting at each would be fifty.
    expect(joins).toBeLessThan(10)
  })

  it("retries quickly again once a join has held", async () => {
    const { rec, said } = await recorder({ retryMs: { min: 20, max: 10_000 }, settleMs: 100 })
    await rec.start()
    for (let n = 1; n <= 6; n++) {
      await server.joins(n)
      server.sendTcp(kick(said, 4))
    }
    // Backed off to 1280 ms by now; this join holds past settleMs.
    await server.joins(7)
    await settle(400)
    const dropped = performance.now()
    server.dropAll()
    await server.joins(8)
    const took = performance.now() - dropped
    await rec.stop()
    expect(took).toBeLessThan(600)
  })
})
