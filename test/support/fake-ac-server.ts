/**
 * Just enough of an Assetto Corsa server to let a spectator join: the
 * handshake reply captured from acServer (UDP port rewritten to this fake's),
 * an empty car list, the UDP association ack, and pings on demand. Everything
 * else is whatever the test sends with `sendTcp`.
 */

import { createSocket, type Socket } from "node:dgram"
import { mkdir, writeFile } from "node:fs/promises"
import { createServer, type Server, type Socket as TcpSocket } from "node:net"
import { dirname, join } from "node:path"

import { frame, TcpDeframer } from "../../src/spectator/protocol.js"

export const HANDSHAKE_OK = Buffer.from(
  "3e0e6300000068000000610000006d0000007000000063000000740000006c0000002000000073000000700000006900" +
    "00006b00000065000000e4251205696d6f6c6100106b735f6d617a64615f6d78355f6375700b30305f6f666669636961" +
    "6c0428994102000101010001000000803f0000803f0000803f000060ea00001027000000000000000000000001010000" +
    "3c0008507261637469636500013c0000000000803f00ade70a0000000000031873797374656d2f646174612f73757266" +
    "616365732e696e6926636f6e74656e742f747261636b732f696d6f6c612f646174612f73757266616365732e696e691f" +
    "636f6e74656e742f747261636b732f696d6f6c612f6d6f64656c732e696e6900070bc6e5aee70a00",
  "hex",
)
// After the id and the 14-character UTF-32 server name.
const UDP_PORT_OFFSET = 1 + 1 + 14 * 4

/** The files the captured handshake asks to checksum, created under `root`. */
export async function fakeAcRoot(root: string): Promise<void> {
  for (const f of [
    "system/data/surfaces.ini",
    "content/tracks/imola/data/surfaces.ini",
    "content/tracks/imola/models.ini",
  ]) {
    await mkdir(dirname(join(root, f)), { recursive: true })
    await writeFile(join(root, f), "x")
  }
}

export interface FakeAcServer {
  port: number
  udpPort: number
  /** Where the joined client listens for UDP. */
  clientUdp(): { port: number; address: string } | undefined
  /** Resolves once `n` joins in total have associated over UDP. */
  joins(n: number): Promise<void>
  /** Drops every TCP connection, the way a server process exiting would. */
  dropAll(): void
  /** Several payloads go in one write, so they arrive together. */
  sendTcp(...payloads: Buffer[]): void
  ping(): void
  close(): Promise<void>
}

/**
 * `checksumPath` replaces the first file the handshake asks for, at the same
 * length. `tcpHost` is where TCP listens; "::" takes IPv6 as well.
 */
export async function fakeAcServer(
  o: { checksumPath?: string; tcpHost?: string } = {},
): Promise<FakeAcServer> {
  const udp: Socket = createSocket("udp4")
  await new Promise<void>((r) => udp.bind(0, "127.0.0.1", r))
  const reply = Buffer.from(HANDSHAKE_OK)
  reply.writeUInt16LE(udp.address().port, UDP_PORT_OFFSET)
  const first = "system/data/surfaces.ini"
  if (o.checksumPath !== undefined) {
    if (o.checksumPath.length !== first.length) throw new Error(`must be ${first.length} long`)
    reply.write(o.checksumPath, reply.indexOf(first), "latin1")
  }

  let client: { port: number; address: string } | undefined
  let count = 0
  const waiting: { n: number; resolve: () => void }[] = []
  udp.on("message", (m, from) => {
    if (m[0] !== 0x4e) return
    client = from
    udp.send(Buffer.from([0x4e]), from.port, from.address)
    count++
    for (const w of waiting.filter((w) => w.n <= count)) w.resolve()
  })

  const sockets = new Set<TcpSocket>()
  const tcp: Server = createServer((sock) => {
    sockets.add(sock)
    sock.on("close", () => sockets.delete(sock))
    sock.on("error", () => {})
    const d = new TcpDeframer()
    sock.on("data", (c) => {
      for (const p of d.push(c)) {
        if (p[0] === 0x3d) sock.write(frame(reply))
        if (p[0] === 0x3f) sock.write(frame(Buffer.from([0x40, 0, 0])))
      }
    })
  })
  await new Promise<void>((r) => tcp.listen(0, o.tcpHost ?? "127.0.0.1", r))

  return {
    port: (tcp.address() as { port: number }).port,
    udpPort: udp.address().port,
    clientUdp: () => client,
    joins: (n) =>
      count >= n ? Promise.resolve() : new Promise((resolve) => waiting.push({ n, resolve })),
    dropAll: () => {
      for (const s of sockets) s.destroy()
    },
    sendTcp: (...payloads) => {
      for (const s of sockets) s.write(Buffer.concat(payloads.map(frame)))
    },
    ping: () => {
      if (client) udp.send(Buffer.from([0xf9, 0, 0, 0, 0, 0, 0]), client.port, client.address)
    },
    close: async () => {
      for (const s of sockets) s.destroy()
      udp.close()
      await new Promise<void>((r) => tcp.close(() => r()))
    },
  }
}
