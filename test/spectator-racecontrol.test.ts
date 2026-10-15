/**
 * Messages as ACSM 2.4.15's race-control websocket sent them during a staged
 * collision, trimmed to the fields this reads.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  RaceControlDecoder,
  RaceControlFeed,
  type RaceControlUpdate,
  raceControlUrl,
} from "../src/spectator/racecontrol.js"
import { type FakeRaceControl, fakeRaceControl } from "./support/fake-race-control.js"

const status = {
  EventType: 200,
  Message: {
    // Every slot each GUID has held; the connected drivers say which is now.
    CarIDToGUID: { "0": "76561198000000001", "1": "76561198000000002", "9": "76561198000000002" },
    ConnectedDrivers: {
      Drivers: {
        "76561198000000001": { CarInfo: { CarID: 0 } },
        "76561198000000002": { CarInfo: { CarID: 1 } },
      },
    },
    SessionInfo: { Track: "imola", TrackConfig: "", Name: "Qualify" },
  },
}
const collision = (other: string) => ({
  EventType: 108,
  Message: {
    Type: other ? "with other car" : "with environment",
    Time: "2026-10-13T01:42:44.037228882Z",
    DriverGUID: "76561198000000002",
    OtherDriverGUID: other,
    Speed: 12.5,
    WorldPos: { X: 10, Y: 0, Z: 20 },
  },
})
const at = Date.parse("2026-10-13T01:42:44.037Z")

describe("RaceControlDecoder", () => {
  const decode = (...messages: unknown[]): RaceControlUpdate[] => {
    const d = new RaceControlDecoder()
    return messages.flatMap((m) => d.decode(JSON.stringify(m)))
  }

  it("names both cars in a collision by the slots their drivers are in now", () => {
    expect(decode(status, collision("76561198000000001")).at(-1)).toEqual({
      kind: "collision",
      carId: 1,
      otherCarId: 0,
      impactSpeed: 12.5,
      worldPos: [10, 0, 20],
      time: at,
    })
  })

  it("takes a collision with no other driver as one with the scenery", () => {
    expect(decode(status, collision("")).at(-1)).not.toHaveProperty("otherCarId")
  })

  it("learns a late joiner's car from their connection", () => {
    const joined = {
      EventType: 51,
      Message: { CarID: 4, DriverGUID: "76561198000000009", DriverName: "Late", CarModel: "m" },
    }
    const hit = collision("76561198000000009")
    expect(decode(status, joined, hit).at(-1)).toMatchObject({ carId: 1, otherCarId: 4 })
  })

  it("drops a collision with a driver it can't place, rather than with the scenery", () => {
    expect(decode(status, collision("76561198000000099"))).not.toContainEqual(
      expect.objectContaining({ kind: "collision" }),
    )
  })

  it("announces each driver already on the server once, with their GUID", () => {
    const connections = decode(status, status).filter((u) => u.kind === "connection")
    expect(connections.map((u) => u.kind === "connection" && [u.carId, u.guid])).toEqual([
      [0, "76561198000000001"],
      [1, "76561198000000002"],
    ])
  })

  it("reports the session once, not with every status", () => {
    expect(decode(status, status).filter((u) => u.kind === "session")).toHaveLength(1)
  })

  it("ignores what isn't JSON", () => {
    expect(new RaceControlDecoder().decode("not json")).toEqual([])
  })
})

describe("raceControlUrl", () => {
  it.each([
    ["https://acsm.example.org", "wss://acsm.example.org/api/race-control"],
    ["http://10.0.0.5:8772/", "ws://10.0.0.5:8772/api/race-control"],
    [
      "https://example.org/practice/live-timing?x=1",
      "wss://example.org/practice/live-timing/api/race-control",
    ],
  ])("%s", (base, ws) => {
    expect(raceControlUrl(base)).toBe(ws)
  })

  it("refuses an address that isn't http", () => {
    expect(() => raceControlUrl("ftp://example.org")).toThrow(/http/)
  })
})

describe("RaceControlFeed", () => {
  let server: FakeRaceControl
  beforeEach(async () => {
    server = await fakeRaceControl()
  })
  afterEach(async () => {
    await server.close()
  })

  it("places a collision when the server says it happened, and rejoins a dropped feed", async () => {
    const got: [RaceControlUpdate, number][] = []
    const feed = new RaceControlFeed({
      url: server.url,
      now: () => 10_000,
      // 300 ms after the collision by the wall clock.
      wallClock: () => at + 300,
      retryMs: { min: 10, max: 10 },
      onUpdate: (u, receivedAt) => got.push([u, receivedAt]),
    })
    feed.start()
    await server.connections(1)
    server.dropAll()
    await server.connections(2)
    server.send(status)
    server.send(collision("76561198000000001"))
    while (!got.some(([u]) => u.kind === "collision")) await new Promise((r) => setTimeout(r, 5))
    feed.close()
    expect(got.find(([u]) => u.kind === "collision")?.[1]).toBe(9_700)
  })

  it("tries again after a refused connection, not only after a dropped one", async () => {
    // Node 22 reports a refused connection with an error and no close.
    await server.close()
    server = await fakeRaceControl({ refuse: 2 })
    const feed = new RaceControlFeed({
      url: server.url,
      retryMs: { min: 10, max: 10 },
      onUpdate: () => {},
    })
    feed.start()
    await server.connections(1)
    feed.close()
  })

  it("trusts its own clock over a server's that's far out", async () => {
    const got: number[] = []
    const feed = new RaceControlFeed({
      url: server.url,
      now: () => 10_000,
      wallClock: () => at + 60_000,
      onUpdate: (u, receivedAt) => {
        if (u.kind === "collision") got.push(receivedAt)
      },
    })
    feed.start()
    await server.connections(1)
    server.send(status)
    server.send(collision("76561198000000001"))
    while (got.length === 0) await new Promise((r) => setTimeout(r, 5))
    feed.close()
    expect(got).toEqual([10_000])
  })
})
