/**
 * A fake server that lets a car join and then stops talking, the way an ACSM
 * event restart looked from behind Docker's port proxy: no FIN, no RST, just
 * nothing. The handshake reply is the one captured from acServer, with its
 * UDP port pointed at the fake.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { createSocket } from "node:dgram"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { kickReason, SpectatorClient } from "../src/spectator/client.js"
import { type FakeAcServer, fakeAcRoot, fakeAcServer } from "./support/fake-ac-server.js"

let acRoot: string
let server: FakeAcServer

beforeEach(async () => {
  acRoot = await mkdtemp(join(tmpdir(), "acroot-"))
  await fakeAcRoot(acRoot)
  server = await fakeAcServer()
})
afterEach(async () => {
  await server.close()
  await rm(acRoot, { recursive: true, force: true })
})

const identity = {
  guid: "76561198000000001",
  name: "t",
  team: "",
  nation: "",
  car: "ks_mazda_mx5_cup",
  password: "",
}

function client(port: number, o: { host?: string; acRoot?: string } = {}): SpectatorClient {
  return new SpectatorClient({
    host: o.host ?? "127.0.0.1",
    port,
    acRoot: o.acRoot ?? acRoot,
    identity,
    pose: () => ({ pos: [0, 0, 0], rot: [0, 0, 0], vel: [0, 0, 0] }),
    onPacket: () => {},
    onClose: () => {},
  })
}

describe("SpectatorClient", () => {
  it("ignores game datagrams from anywhere but the server", async () => {
    const c = client(server.port)
    const { carId } = await c.connect()
    const to = server.clientUdp()!
    // A kick naming the recorder, by an admin: from another address on the
    // server's own port, and from the server's address on another port.
    const kick = Buffer.from([0x68, carId, 4])
    for (const [address, port] of [
      ["127.0.0.2", server.udpPort],
      ["127.0.0.1", 0],
    ] as const) {
      const forger = createSocket("udp4")
      await new Promise<void>((r) => forger.bind(port, address, r))
      await new Promise((r) => forger.send(kick, to.port, to.address, r))
      forger.close()
    }
    await new Promise((r) => setTimeout(r, 100))
    expect(c.closed).toBe(false)
    c.close()
  })

  it("joins by a name that has an IPv6 address too", async () => {
    // TCP to localhost went over ::1 while the game's UDP came back from
    // 127.0.0.1, which the filter then threw away.
    await server.close()
    server = await fakeAcServer({ tcpHost: "::" })
    const c = client(server.port, { host: "localhost" })
    await c.connect()
    c.close()
  })

  it("refuses to checksum a file outside the AC root", async () => {
    await server.close()
    server = await fakeAcServer({ checksumPath: "../../../../../etc/hosts" })
    await expect(client(server.port).connect()).rejects.toThrow(/outside the AC root/)
  })

  it("takes / as an AC root like any other", async () => {
    // Everything under it used to count as outside: "/" + sep is "//".
    await server.close()
    server = await fakeAcServer({ checksumPath: "etc//../etc/../etc/hosts" })
    await expect(client(server.port, { acRoot: "/" }).connect()).rejects.toThrow(
      /imola.*which is not under/,
    )
  })

  it("gives up on a server that stops talking without closing the connection", async () => {
    const closed = new Promise<string>((resolve) => {
      const client = new SpectatorClient({
        host: "127.0.0.1",
        port: server.port,
        acRoot,
        identity: {
          guid: "76561198000000001",
          name: "t",
          team: "",
          nation: "",
          car: "ks_mazda_mx5_cup",
          password: "",
        },
        pose: () => ({ pos: [0, 0, 0], rot: [0, 0, 0], vel: [0, 0, 0] }),
        onPacket: () => {},
        onClose: resolve,
        silenceMs: 300,
      })
      void client.connect()
    })
    expect(await closed).toBe("the server went silent")
  })
})

describe("kickReason", () => {
  it.each([
    [3, /checksum didn't match: the car and track files under the AC root differ/],
    [4, /by an admin/],
    [1, /by a vote/],
    [9, /reason 9/],
  ])("explains reason %i", (reason, words) => {
    expect(kickReason(reason)).toMatch(words)
  })
})
