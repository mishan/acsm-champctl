/**
 * Just enough of ACSM's race-control websocket for the feed to connect to:
 * the upgrade handshake, then text frames the test sends. Unmasked frames,
 * as a server sends them; nothing the client says is read.
 */

import { createHash } from "node:crypto"
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { Duplex } from "node:stream"

export interface FakeRaceControl {
  url: string
  /** Resolves once `n` connections in total have opened. */
  connections(n: number): Promise<void>
  send(message: unknown): void
  /** Drops every connection, the way ACSM restarting would. */
  dropAll(): void
  close(): Promise<void>
}

function frame(text: string): Buffer {
  const body = Buffer.from(text)
  const head =
    body.length < 126
      ? Buffer.from([0x81, body.length])
      : body.length < 65536
        ? Buffer.from([0x81, 126, body.length >> 8, body.length & 0xff])
        : (() => {
            const h = Buffer.alloc(10)
            h[0] = 0x81
            h[1] = 127
            h.writeBigUInt64BE(BigInt(body.length), 2)
            return h
          })()
  return Buffer.concat([head, body])
}

export async function fakeRaceControl(): Promise<FakeRaceControl> {
  const sockets = new Set<Duplex>()
  let count = 0
  const waiting: { n: number; resolve: () => void }[] = []
  const server: Server = createServer((_, res) => res.writeHead(404).end())
  server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
    if (req.url !== "/acsm/api/race-control") {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n")
      return
    }
    const accept = createHash("sha1")
      .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64")
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    socket.on("error", () => {})
    socket.on("close", () => sockets.delete(socket))
    sockets.add(socket)
    count++
    for (const w of waiting.filter((w) => w.n <= count)) w.resolve()
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const { port } = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${port}/acsm/`,
    connections: (n) =>
      count >= n ? Promise.resolve() : new Promise((resolve) => waiting.push({ n, resolve })),
    send: (message) => {
      for (const s of sockets) s.write(frame(JSON.stringify(message)))
    },
    dropAll: () => {
      for (const s of sockets) s.destroy()
    },
    close: async () => {
      for (const s of sockets) s.destroy()
      await new Promise<void>((r) => server.close(() => r()))
    },
  }
}
