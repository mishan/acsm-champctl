/**
 * Packets captured from ACSM 2.4.15's plugin feed while two scripted cars
 * joined an Imola qualifying and one reported hitting the other at 12.5 m/s,
 * at world (10, 0, 20) with contact point (0.5, 0, 2).
 */

import { createSocket } from "node:dgram"
import { describe, expect, it } from "vitest"

import { decodePluginPacket, PluginListener } from "../src/spectator/plugin.js"

const hex = (s: string): Buffer => Buffer.from(s, "hex")

const SESSION_INFO = hex(
  "3b040000021c4100000073000000730000006500000074000000740000006f00000020000000430000006f0000007200" +
    "0000730000006100000020000000530000006500000072000000760000006500000072000000200000002d000000200000" +
    "00490000006d0000006f0000006c0000006100000005696d6f6c6100075175616c696679021e00000000001a2407335f63" +
    "6c65617291cd0100",
)

const COLLISION = hex("820a01000000484100002041000000000000a0410000003f0000000000000040")

const NEW_CONNECTION = hex(
  "33106300000068000000610000006d0000007000000063000000740000006c000000200000007300000070000000690000" +
    "006b00000065000000200000003100000011370000003600000035000000360000003100000031000000390000003800" +
    "000030000000300000003000000030000000300000003000000030000000300000003100000000106b735f6d617a6461" +
    "5f6d78355f63757000",
)

describe("decodePluginPacket", () => {
  it("reads a car-to-car collision", () => {
    expect(decodePluginPacket(COLLISION)).toEqual({
      kind: "collision",
      carId: 1,
      otherCarId: 0,
      impactSpeed: 12.5,
      worldPos: [10, 0, 20],
      relPos: [0.5, 0, 2],
    })
  })

  it("reads a collision with the environment, which has no other car", () => {
    const env = Buffer.concat([Buffer.from([0x82, 0x0b, 4]), COLLISION.subarray(4)])
    expect(decodePluginPacket(env)).toEqual({
      kind: "collision",
      carId: 4,
      impactSpeed: 12.5,
      worldPos: [10, 0, 20],
      relPos: [0.5, 0, 2],
    })
  })

  it("reads session info through to the elapsed time after the weather", () => {
    expect(decodePluginPacket(SESSION_INFO)).toMatchObject({
      kind: "session",
      isNew: false,
      serverName: "Assetto Corsa Server - Imola",
      track: "imola",
      trackConfig: "",
      name: "Qualify",
      type: 2,
      minutes: 30,
      laps: 0,
      ambient: 26,
      road: 36,
      weather: "3_clear",
      elapsedMs: 118161,
    })
  })

  it("reads who connected to which car", () => {
    expect(decodePluginPacket(NEW_CONNECTION)).toEqual({
      kind: "connection",
      connected: true,
      name: "champctl spike 1",
      guid: "76561198000000001",
      carId: 0,
      model: "ks_mazda_mx5_cup",
      skin: "",
    })
  })

  it("reports a packet that doesn't fit its layout instead of throwing", () => {
    expect(decodePluginPacket(SESSION_INFO.subarray(0, 100))).toMatchObject({
      kind: "malformed",
      id: 0x3b,
    })
  })
})

describe("PluginListener", () => {
  it("drops the feed from any address but the server's", async () => {
    const events: string[] = []
    const listener = new PluginListener({
      listenPort: 0,
      serverHost: "127.0.0.1",
      serverPort: 9,
      allowedSources: ["127.0.0.2"],
      onEvent: (e) => events.push(e.kind),
    })
    await listener.start()
    const port = listener.address()!.port
    const send = async (from: string): Promise<void> => {
      const s = createSocket("udp4")
      await new Promise<void>((r) => s.bind(0, from, r))
      await new Promise<void>((r) => s.send(COLLISION, port, "127.0.0.1", () => r()))
      s.close()
    }
    await send("127.0.0.1")
    await send("127.0.0.2")
    await new Promise((r) => setTimeout(r, 100))
    listener.close()
    expect(events).toEqual(["collision"])
  })
})
