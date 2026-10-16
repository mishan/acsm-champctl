import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { readJournal, type JournalRecord } from "../src/spectator/journal.js"
import { Recorder, type RecorderOptions } from "../src/spectator/recorder.js"
import { WireWriter } from "ac-spectator"
import { type FakeAcServer, fakeAcRoot, fakeAcServer } from "./support/fake-ac-server.js"
import { fakeRaceControl } from "./support/fake-race-control.js"

let dir: string
let server: FakeAcServer
let rc: Awaited<ReturnType<typeof fakeRaceControl>>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "recorder-"))
  await fakeAcRoot(dir)
  server = await fakeAcServer()
})
afterEach(async () => {
  await server.close()
  await rm(dir, { recursive: true, force: true })
})

function recorder(
  onJournal: (p: string) => void = () => {},
  extra: Partial<RecorderOptions> = {},
): Recorder {
  return new Recorder({
    ...extra,
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

  it.each([
    ["carries on the round it left off", false, "2026-10-01-imola"],
    ["starts a round when the last one's event is over", true, "TODAY-imola"],
  ])("%s, with every session of it in the round's folder", async (_, over, folder) => {
    const today = new Date().toISOString().slice(0, 10)
    const rec = recorder(undefined, {
      rounds: { timeZone: "UTC", last: { folder: "2026-10-01-imola", place: "imola", over } },
    })
    await rec.start()
    await server.joins(1)
    await settle()
    server.sendTcp(sessionUpdate("Race"))
    await settle()
    await rec.stop()
    const into = folder.replace("TODAY", today)
    const files = (await readdir(join(dir, into))).filter((f) => f.endsWith(".ndjson.gz")).sort()
    const sessions: JournalRecord[] = []
    for (const f of files) {
      for await (const r of readJournal(join(dir, into, f))) if (r.t === "session") sessions.push(r)
    }
    // Where each sits in the server's list of one: a practice server.
    expect(
      sessions.map((r) => r.t === "session" && [r.name, r.sessionIndex, r.sessionCount]),
    ).toEqual([
      ["Practice", 0, 1],
      ["Race", 1, 1],
    ])
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

  it("journals collisions from ACSM's live timing, with no contact point", async () => {
    const rc = await fakeRaceControl()
    const rec = recorder(undefined, { raceControl: { url: rc.url } })
    await rec.start()
    await server.joins(1)
    await rc.connections(1)
    await settle()
    rc.send({
      EventType: 200,
      Message: {
        ConnectedDrivers: {
          Drivers: { g1: { CarInfo: { CarID: 1 } }, g2: { CarInfo: { CarID: 2 } } },
        },
        SessionInfo: {},
      },
    })
    rc.send({
      EventType: 108,
      Message: {
        Time: new Date().toISOString(),
        DriverGUID: "g2",
        OtherDriverGUID: "g1",
        Speed: 30,
        WorldPos: { X: 1, Y: 2, Z: 3 },
      },
    })
    await settle()
    await rec.stop()
    await rc.close()
    const [records] = await journals()
    // Already on the server when the feed opened: named, with GUIDs, for an
    // incident report to find their cars by.
    expect(
      records!
        .filter((r) => r.t === "car" && r.guid)
        .map((r) => r.t === "car" && [r.carId, r.guid]),
    ).toEqual([
      [1, "g1"],
      [2, "g2"],
    ])
    const hit = records!.find((r) => r.t === "collision")
    expect(hit).toMatchObject({ carId: 2, otherCarId: 1, impactSpeed: 30, worldPos: [1, 2, 3] })
    expect(hit).not.toHaveProperty("relPos")
  })

  it.each([
    ["names every driver's GUID at the start of the next session", [], ["g1", "g2"]],
    [
      "forgets the GUID of a driver who left, by either feed",
      [
        // ACSM's feed says car 2 left; the game's own says car 1 did.
        () => rc.send({ EventType: 52, Message: { CarID: 2, DriverGUID: "g2" } }),
        () => server.sendTcp(new WireWriter().u8(0x4d).u8(1).build()),
      ],
      [undefined, undefined],
    ],
  ] as [string, (() => void)[], (string | undefined)[]][])("%s", async (_, leave, guids) => {
    await server.close()
    server = await fakeAcServer({
      cars: [
        { carId: 1, driver: "Ana" },
        { carId: 2, driver: "Bo" },
      ],
    })
    rc = await fakeRaceControl()
    const rec = recorder(undefined, { raceControl: { url: rc.url } })
    await rec.start()
    await server.joins(1)
    await rc.connections(1)
    rc.send({
      EventType: 200,
      Message: {
        ConnectedDrivers: {
          Drivers: { g1: { CarInfo: { CarID: 1 } }, g2: { CarInfo: { CarID: 2 } } },
        },
        SessionInfo: {},
      },
    })
    await settle()
    for (const l of leave) l()
    await settle()
    server.sendTcp(sessionUpdate("Race"))
    await settle()
    await rec.stop()
    await rc.close()
    const next = (await journals())[1]!
    const opening = next.filter((r) => r.t === "car" && r.at === next[0]!.at)
    expect(opening.map((r) => r.t === "car" && [r.carId, r.guid])).toEqual([
      [1, guids[0]],
      [2, guids[1]],
    ])
  })
})
