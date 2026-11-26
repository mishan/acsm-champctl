import { mkdtemp, rm } from "node:fs/promises"
import { connect, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { RecorderAlerts } from "../src/spectator/alerts.js"
import { Recorder, type RecorderOptions } from "../src/spectator/recorder.js"
import { type FakeAcServer, fakeAcRoot, fakeAcServer } from "./support/fake-ac-server.js"

let dir: string
let server: FakeAcServer
let said: { raised: [string, string][]; resolved: string[] }
let started: Recorder[]
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "recorder-alerts-"))
  await fakeAcRoot(dir)
  server = await fakeAcServer()
  said = { raised: [], resolved: [] }
  started = []
})
afterEach(async () => {
  // A failed assertion skips a test's own stop, and its recorder would talk into the next.
  for (const r of started) await r.stop()
  await server.close()
  await rm(dir, { recursive: true, force: true })
})

const alerts: RecorderAlerts = {
  raise: (key, message) => said.raised.push([key, message]),
  resolve: (key) => said.resolved.push(key),
}

function recorder(port: number, extra: Partial<RecorderOptions> = {}): Recorder {
  const rec = new Recorder({
    client: {
      host: "127.0.0.1",
      port,
      acRoot: dir,
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
    alerts,
    alertAfterMs: 150,
    outDir: dir,
    retryMs: { min: 20, max: 20 },
    settleMs: 50,
    log: () => {},
    ...extra,
  })
  started.push(rec)
  return rec
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r))
  const { port } = s.address() as { port: number }
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

describe("Recorder alerts", () => {
  it("raises one when the server answers but no join holds, naming why", async () => {
    await rm(join(dir, "content/tracks/imola/models.ini"))
    const rec = recorder(server.port)
    await rec.start()
    await wait(100)
    expect(said.raised, "not before alertAfterMs").toEqual([])
    await wait(150)
    await rec.stop()
    expect(said.raised.length).toBeGreaterThan(0)
    const [key, message] = said.raised.at(-1)!
    expect(key).toBe("join")
    expect(message).toMatch(
      /^The recorder hasn't been able to join the game server for \d+ minutes?: .*models\.ini.*\. Nothing is being recorded\.$/,
    )
  })

  it("raises one when every join is kicked before it holds", async () => {
    const lines: string[] = []
    const rec = recorder(server.port, { log: (m) => lines.push(m) })
    await rec.start()
    let done = false
    void (async () => {
      for (let n = 1; !done; n++) {
        await server.joins(n)
        const carId = Number(lines.join("\n").match(/ as car (\d+)/)?.[1])
        server.sendTcp(Buffer.from([0x68, carId, 4]))
      }
    })()
    await wait(300)
    done = true
    await rec.stop()
    expect(said.raised.at(-1)?.[1]).toMatch(/kicked/)
  })

  it("raises none while the server is down and nobody is on it", async () => {
    const rec = recorder(await closedPort())
    await rec.start()
    await wait(300)
    await rec.stop()
    expect(said.raised).toEqual([])
  })

  it("counts only time the server answered, not a quiet spell before it", async () => {
    await rm(join(dir, "content/tracks/imola/models.ini"))
    const port = await closedPort()
    const rec = recorder(port)
    await rec.start()
    await wait(300)
    // The server comes up, at the port the recorder has been knocking on.
    const proxy = createServer((c) => {
      const s = connect(server.port, "127.0.0.1")
      c.pipe(s).pipe(c)
      c.on("error", () => s.destroy())
      s.on("error", () => c.destroy())
    })
    await new Promise<void>((r) => proxy.listen(port, "127.0.0.1", r))
    await wait(100)
    expect(said.raised, "answered for only 100 ms").toEqual([])
    await wait(150)
    await rec.stop()
    await new Promise<void>((r) => proxy.close(() => r()))
    expect(said.raised.length).toBeGreaterThan(0)
  })

  it("keeps recording when the store won't take an alert", async () => {
    const broken: RecorderAlerts = {
      raise: () => {
        throw new Error("database is locked")
      },
      resolve: () => {
        throw new Error("database is locked")
      },
    }
    const rec = recorder(server.port, { alerts: broken })
    await rec.start()
    await server.joins(1)
    await wait(100)
    server.dropAll()
    await server.joins(2)
    await rec.stop()
  })

  it("tries the resolution again while the join holds, if the store refused it", async () => {
    let refuse = 2
    const flaky: RecorderAlerts = {
      raise: () => {},
      resolve: (key) => {
        if (refuse-- > 0) throw new Error("database is locked")
        said.resolved.push(key)
      },
    }
    const rec = recorder(server.port, { alerts: flaky })
    await rec.start()
    await server.joins(1)
    await wait(250)
    await rec.stop()
    expect(said.resolved).toEqual(["join"])
  })

  it("resolves it once a join holds, and counts afresh after that join ends", async () => {
    const rec = recorder(server.port)
    await rec.start()
    await server.joins(1)
    await wait(100)
    expect(said.resolved).toEqual(["join"])
    await rm(join(dir, "content/tracks/imola/models.ini"))
    server.dropAll()
    await wait(100)
    expect(said.raised, "the 150 ms start over at the drop").toEqual([])
    await wait(150)
    await rec.stop()
    expect(said.raised.length).toBeGreaterThan(0)
  })
})
