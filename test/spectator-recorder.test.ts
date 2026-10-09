import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { readJournal, type JournalRecord } from "../src/spectator/journal.js"
import { Recorder } from "../src/spectator/recorder.js"
import { WireWriter } from "../src/spectator/wire.js"
import { type FakeAcServer, fakeAcRoot, fakeAcServer } from "./support/fake-ac-server.js"

let dir: string
let server: FakeAcServer

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "recorder-"))
  await fakeAcRoot(dir)
  server = await fakeAcServer()
})
afterEach(async () => {
  await server.close()
  await rm(dir, { recursive: true, force: true })
})

function recorder(onJournal: (p: string) => void = () => {}): Recorder {
  return new Recorder({
    client: {
      host: "127.0.0.1",
      port: server.port,
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
    outDir: dir,
    onJournal,
    retryMs: { min: 20, max: 20 },
  })
}

async function journals(): Promise<JournalRecord[][]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".ndjson.gz")).sort()
  const out: JournalRecord[][] = []
  for (const f of files) {
    const records: JournalRecord[] = []
    for await (const r of readJournal(join(dir, f))) records.push(r)
    out.push(records)
  }
  return out
}

const sessionUpdate = (name: string): Buffer =>
  new WireWriter()
    .u8(0x4a)
    .ascii(name)
    .u8(1)
    .u8(3)
    .u16(30)
    .u16(0)
    .f32(1)
    .u8(0)
    .bytes(Buffer.alloc(8))
    .build()

const settle = (ms = 100): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe("Recorder", () => {
  it("names a driver who joins later, without the plugin feed", async () => {
    const rec = recorder()
    await rec.start()
    await server.joins(1)
    await settle()
    server.sendTcp(new WireWriter().u8(0x5a).u8(3).ascii("Late Driver").ascii("ITA").build())
    await settle()
    await rec.stop()
    const [records] = await journals()
    expect(records).toContainEqual(
      expect.objectContaining({ t: "car", carId: 3, driver: "Late Driver", nation: "ITA" }),
    )
  })

  it("finishes every journal when the server drops in the middle of a session change", async () => {
    const finished: string[] = []
    const rec = recorder((p) => finished.push(p))
    await rec.start()
    await server.joins(1)
    await settle()
    server.sendTcp(sessionUpdate("Race"))
    server.dropAll()
    await server.joins(2)
    await settle()
    await rec.stop()
    const all = await journals()
    const summary = (records: JournalRecord[]) => {
      const session = records.find((r) => r.t === "session")
      const end = records.at(-1)
      return [session?.t === "session" && session.name, end?.t === "end" && end.reason]
    }
    // No third journal opened for the dropped connection once the old one closed.
    expect(all.map(summary)).toEqual([
      ["Practice", "session changed to Race"],
      ["Practice", "recorder stopped"],
    ])
    expect(finished).toHaveLength(all.length)
  })

  it("names the journal after the latest session when two changes come at once", async () => {
    const rec = recorder()
    await rec.start()
    await server.joins(1)
    await settle()
    server.sendTcp(sessionUpdate("Qualify"), sessionUpdate("Race"))
    await settle()
    await rec.stop()
    const names = (await journals()).map((r) => r.find((x) => x.t === "session"))
    expect(names.map((x) => x?.t === "session" && x.name)).toEqual(["Practice", "Race"])
  })
})
