/**
 * The captured packets came from a stock Kunos acServer on Imola, with a
 * second client reporting a car at a known pose, so their expected values are
 * what was sent rather than what the decoder happens to produce. Fields that
 * capture left at zero are covered by packets laid out from the spec instead.
 */

import { describe, expect, it } from "vitest"

import { isPlausibleTimestamp } from "../src/spectator/client.js"
import {
  decodeHandshakeReply,
  decodeServerPacket,
  frame,
  TcpDeframer,
} from "../src/spectator/protocol.js"

const hex = (s: string): Buffer => Buffer.from(s, "hex")

const HANDSHAKE_OK = hex(
  "3e0e6300000068000000610000006d0000007000000063000000740000006c0000002000000073000000700000006900" +
    "00006b00000065000000e4251205696d6f6c6100106b735f6d617a64615f6d78355f6375700b30305f6f666669636961" +
    "6c0428994102000101010001000000803f0000803f0000803f000060ea00001027000000000000000000000001010000" +
    "3c0008507261637469636500013c0000000000803f00ade70a0000000000031873797374656d2f646174612f73757266" +
    "616365732e696e6926636f6e74656e742f747261636b732f696d6f6c612f646174612f73757266616365732e696e691f" +
    "636f6e74656e742f747261636b732f696d6f6c612f6d6f64656c732e696e6900070bc6e5aee70a00",
)

// Sent as pos (12.5, 3.25, -40), rot (1.5, 0.01, -0.02), vel (10, 0, -2), neutral.
const POSITION = hex(
  "46010eb2ea0a0001000000484100005040000020c20000c03f0ad7233c0ad7a3bc0000204100000000000000c0646464" +
    "647f7f84030100000000000000",
)

const LEADERBOARD = hex(
  "49ff00000000000400ffc99a3b00000001ffc99a3b00000002ffc99a3b00000003ffc99a3b0000000000803f",
)

describe("decodeHandshakeReply", () => {
  it("reads the slot, rate, track and the files to checksum", () => {
    const reply = decodeHandshakeReply(HANDSHAKE_OK)
    if (!reply.ok) throw new Error(reply.reason)
    expect(reply.value).toMatchObject({
      serverName: "champctl spike",
      udpPort: 9700,
      refreshHz: 18,
      track: "imola",
      car: "ks_mazda_mx5_cup",
      carId: 0,
      sessions: [{ type: 1, laps: 0, minutes: 60 }],
      currentSession: { name: "Practice", index: 0, type: 1, minutes: 60, laps: 0 },
      checksumPaths: [
        "system/data/surfaces.ini",
        "content/tracks/imola/data/surfaces.ini",
        "content/tracks/imola/models.ini",
      ],
    })
  })

  it.each([
    [0x45, /no free entry-list slot/],
    [0x3c, /password/],
    [0x6e, /closed/],
  ])("names rejection 0x%s", (id, reason) => {
    const reply = decodeHandshakeReply(Buffer.from([id]))
    expect(reply.ok).toBe(false)
    if (!reply.ok) expect(reply.reason).toMatch(reason)
  })
})

describe("decodeServerPacket", () => {
  it("reads another car's pose from a captured single-car update", () => {
    const p = decodeServerPacket(POSITION)
    if (p.kind !== "position") throw new Error(p.kind)
    const [car] = p.cars
    expect(car).toMatchObject({ carId: 1, seq: 14, timestamp: 715442, ping: 1, rpm: 900, gear: 1 })
    expect(car!.pos).toEqual([12.5, 3.25, -40])
    expect(car!.vel).toEqual([10, 0, -2])
    expect(car!.rot.map((v) => Number(v.toFixed(5)))).toEqual([1.5, 0.01, -0.02])
  })

  // Laid out from the protocol tables with a distinct value in every field, so
  // a read one byte off anywhere in the tail picks up a neighbor's value.
  const carTail = (b: Buffer, at: number): void => {
    b.writeUInt8(140, at) // steer
    b.writeUInt8(99, at + 1) // wheel angle
    b.writeUInt16LE(6500, at + 2)
    b.writeUInt8(5, at + 4) // gear
    b.writeUInt32LE(0x10, at + 5) // brake lights
  }

  it("reads the tail of a single-car update: steering, rpm, gear, lights, gas", () => {
    const b = Buffer.alloc(61)
    b.writeUInt8(0x46, 0)
    b.writeUInt8(2, 1)
    carTail(b, 49)
    b.writeInt16LE(-321, 58) // performance delta
    b.writeUInt8(204, 60) // gas
    const p = decodeServerPacket(b)
    if (p.kind !== "position") throw new Error(p.kind)
    expect(p.cars[0]).toMatchObject({ steer: 13, rpm: 6500, gear: 5, statusFlags: 0x10, gas: 0.8 })
  })

  it("reads a batched update with several cars and no gas", () => {
    const record = (carId: number, seq: number): Buffer => {
      const b = Buffer.alloc(57)
      b.writeUInt8(carId, 0)
      b.writeUInt8(seq, 1)
      b.writeUInt32LE(4_000_000_000, 2)
      b.writeUInt16LE(42, 6)
      b.writeFloatLE(-7.5, 8) // pos.x
      b.writeFloatLE(3, 40) // vel.z
      carTail(b, 48)
      return b
    }
    const head = Buffer.from([0x48, 1, 2, 3, 4, 5, 6, 2])
    const p = decodeServerPacket(Buffer.concat([head, record(3, 7), record(5, 8)]))
    if (p.kind !== "position") throw new Error(p.kind)
    expect(p.cars).toHaveLength(2)
    expect(p.cars[1]).toMatchObject({
      carId: 5,
      seq: 8,
      timestamp: 4_000_000_000,
      ping: 42,
      pos: [-7.5, 0, 0],
      vel: [0, 0, 3],
      steer: 13,
      rpm: 6500,
      gear: 5,
      statusFlags: 0x10,
    })
    expect(p.cars[1]!.gas).toBeUndefined()
  })

  it("reports a known packet that doesn't fit its layout instead of throwing", () => {
    // A session update too short to hold even its trailing start time.
    const short = Buffer.from([0x4a, 1, 0x50, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(decodeServerPacket(short)).toMatchObject({ kind: "malformed", id: 0x4a })
    expect(decodeServerPacket(Buffer.alloc(0))).toMatchObject({ kind: "malformed" })
  })

  it("reads the leaderboard refresh a join triggers", () => {
    const p = decodeServerPacket(LEADERBOARD)
    if (p.kind !== "lapCompleted") throw new Error(p.kind)
    expect(p.carId).toBe(255)
    expect(p.standings).toEqual(
      [0, 1, 2, 3].map((carId) => ({ carId, time: 999999999, laps: 0, completed: false })),
    )
  })
})

describe("TcpDeframer", () => {
  it("splits coalesced packets and reassembles split ones", () => {
    const a = frame(Buffer.from([0x4d, 1]))
    const b = frame(Buffer.from([0x4d, 2]))
    const both = Buffer.concat([a, b])
    const d = new TcpDeframer()
    expect(d.push(both.subarray(0, 5)).map((p) => p[1])).toEqual([1])
    expect(d.push(both.subarray(5))).toEqual([Buffer.from([0x4d, 2])])
  })
})

describe("isPlausibleTimestamp", () => {
  it.each([
    ["a sample from just now", 100_000, 99_950, true],
    ["a sample slightly ahead of our clock", 100_000, 100_400, true],
    ["across our clock's 32-bit wrap", 20, 2 ** 32 - 30, true],
    ["one still in the server's clock, behind", 100_000, 100_000 + 545_232, false],
    ["one still in the server's clock, wrapped", 100_000, 2 ** 32 - 545_232, false],
  ])("%s", (_, now, timestamp, expected) => {
    expect(isPlausibleTimestamp(now, timestamp)).toBe(expected)
  })
})
