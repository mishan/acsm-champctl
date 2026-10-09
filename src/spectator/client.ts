/**
 * A car that joins an Assetto Corsa server and never leaves its pit box.
 *
 * The server only starts telling a client about other cars once that client
 * has sent a position of its own, so "just listen" is not an option. After
 * that it keeps reporting at the server's refresh rate, because real clients
 * do and nobody has measured what the Kunos server does with one that stops.
 */

import { createHash } from "node:crypto"
import { createSocket, type Socket as UdpSocket } from "node:dgram"
import { lookup } from "node:dns/promises"
import { readFile } from "node:fs/promises"
import { connect, type Socket } from "node:net"
import { isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path"
import {
  type CarListEntry,
  type HandshakeOk,
  type HandshakeRequest,
  type OwnPosition,
  type ServerPacket,
  TcpDeframer,
  decodeHandshakeReply,
  decodeServerPacket,
  encodeAssociate,
  encodeCarListRequest,
  encodeChecksum,
  encodeCleanExit,
  encodeHandshake,
  encodeOwnPosition,
  encodePong,
  frame,
} from "./protocol.js"

export interface SpectatorOptions {
  host: string
  port: number
  identity: HandshakeRequest
  /** Assetto Corsa install root, for the files the server asks to checksum. */
  acRoot: string
  /**
   * Where the car is, asked once per tick. Required, because every other
   * client draws this car as something solid: the world origin is on the
   * racing surface at plenty of tracks.
   */
  pose: (now: number) => Pose
  onPacket: (packet: ServerPacket, receivedAt: number) => void
  onClose?: (reason: string) => void
  /** This client's millisecond clock; the server converts car timestamps into it. */
  now?: () => number
  /** How long the server may say nothing before it counts as gone. */
  silenceMs?: number
}

/** A parked recorder needs the first three; a scripted test car uses the rest. */
export type Pose = Pick<OwnPosition, "pos" | "rot" | "vel"> &
  Partial<Pick<OwnPosition, "rpm" | "gear" | "steer" | "gas" | "statusFlags">>

export class SpectatorError extends Error {}

const HANDSHAKE_TIMEOUT_MS = 10_000
// The server pings about once a second and drops a client after 15 s without
// an answer, so 15 s of silence the other way means the server is gone.
const SILENCE_MS = 15_000
const ASSOCIATE_TRIES = 10
const ASSOCIATE_RETRY_MS = 500
const MAX_SKEW_MS = 5000
const IDLE_RPM = 900
const NEUTRAL = 1

export class SpectatorClient {
  readonly #opts: SpectatorOptions
  readonly #now: () => number
  #tcp: Socket | undefined
  #udp: UdpSocket | undefined
  /** The server's IPv4 address, looked up once so TCP, UDP and the filter agree. */
  #address: string | undefined
  #timer: NodeJS.Timeout | undefined
  #watchdog: NodeJS.Timeout | undefined
  #lastHeard = 0
  #seq = 0
  #closed = false
  session: HandshakeOk | undefined
  cars: CarListEntry[] = []

  constructor(opts: SpectatorOptions) {
    this.#opts = opts
    const start = performance.now()
    this.#now = opts.now ?? (() => Math.floor(performance.now() - start))
  }

  /**
   * Resolves once the car is in and reporting. On any failure the sockets are
   * closed before it rejects: a half-joined car still holds its slot, and a
   * server that waits for every client to spawn before changing session would
   * wait on this one.
   */
  async connect(): Promise<HandshakeOk> {
    try {
      return await this.#connect()
    } catch (e) {
      this.#shutdown(e instanceof Error ? e.message : String(e))
      throw e
    }
  }

  async #connect(): Promise<HandshakeOk> {
    const { host, port } = this.#opts
    // Looked up once: a name with an IPv6 address would take TCP over IPv6
    // while the udp4 socket's replies came back over IPv4, from an address
    // the filter below didn't expect.
    const { address } = await lookup(host, { family: 4 }).catch((e: Error) => {
      throw new SpectatorError(`can't find an IPv4 address for ${host}: ${e.message}`)
    })
    this.#address = address
    this.#assertOpen()
    const tcp = connect({ host: address, port })
    this.#tcp = tcp
    tcp.setNoDelay(true)
    tcp.setTimeout(HANDSHAKE_TIMEOUT_MS, () =>
      tcp.destroy(new SpectatorError(`no answer from ${host}:${port} during the handshake`)),
    )
    const packets = tcpPackets(tcp)

    await new Promise<void>((resolve, reject) => {
      tcp.once("connect", resolve)
      tcp.once("error", reject)
    })
    tcp.write(frame(encodeHandshake(this.#opts.identity)))

    const first = await packets.next()
    // ACSM refuses a GUID with no slot by hanging up rather than saying so.
    if (first === undefined) {
      throw packets.failure(
        "the server closed the connection during the handshake; check that a slot for this car is locked to this GUID, and the password",
      )
    }
    const reply = decodeHandshakeReply(first)
    if (!reply.ok) throw new SpectatorError(`the server refused the join: ${reply.reason}`)
    const session = reply.value
    if (session.refreshHz < 1)
      throw new SpectatorError(`the server asked for updates at ${session.refreshHz} Hz`)
    this.session = session

    for (let offset = 0; ; offset += 10) {
      tcp.write(frame(encodeCarListRequest(offset)))
      const page = await packets.until(
        (p) => p.kind === "carList",
        (p) => this.#deliver(p),
      )
      if (page?.kind !== "carList")
        throw packets.failure("the connection closed while reading the car list")
      this.cars.push(...page.cars)
      if (page.cars.length < 10) break
    }

    const checksums = await this.#checksums(session)
    this.#assertOpen()
    tcp.write(frame(encodeChecksum(checksums)))

    const udp = createSocket("udp4")
    this.#udp = udp
    udp.on("error", (e) => this.#shutdown(`UDP error: ${e.message}`))
    // Binding an ephemeral port fails only when the host is out of sockets,
    // which no test here can arrange.
    await new Promise<void>((resolve, reject) => {
      udp.once("error", reject)
      udp.bind(0, () => {
        udp.off("error", reject)
        resolve()
      })
    })
    this.#assertOpen()
    // The game's UDP port takes datagrams from anywhere; one from elsewhere
    // could kick the recorder or write a car that wasn't there into the journal.
    let ignored: { from: string; n: number } | undefined
    const associated = new Promise<void>((resolve) => {
      udp.on("message", (msg, from) => {
        if (from.address !== address || from.port !== session.udpPort) {
          ignored = { from: `${from.address}:${from.port}`, n: (ignored?.n ?? 0) + 1 }
          return
        }
        this.#lastHeard = this.#now()
        const p = decodeServerPacket(msg)
        if (p.kind === "associated") resolve()
        else if (p.kind === "ping") this.#udpSend(encodePong(p.serverTime, this.#now()))
        this.#deliver(p.kind === "position" ? this.#plausible(p) : p)
      })
    })
    for (let tries = 0; ; tries++) {
      this.#assertOpen()
      if (tries === ASSOCIATE_TRIES) {
        throw new SpectatorError(
          `the server never acknowledged the UDP association from ${address}:${session.udpPort}` +
            (ignored
              ? `; ignored ${ignored.n} datagrams from elsewhere, last ${ignored.from}`
              : ""),
        )
      }
      this.#udpSend(encodeAssociate(session.carId))
      if (await raceTimeout(associated, ASSOCIATE_RETRY_MS)) break
    }

    tcp.setTimeout(0)
    this.#timer = setInterval(() => this.#sendPosition(), 1000 / session.refreshHz)
    this.#sendPosition()
    // A server that restarts for the next event doesn't always close the TCP
    // connection on its way out (measured with ACSM behind Docker's port
    // proxy), and a connection nobody closes stays open forever.
    this.#lastHeard = this.#now()
    const silenceMs = this.#opts.silenceMs ?? SILENCE_MS
    this.#watchdog = setInterval(
      () => {
        if (this.#now() - this.#lastHeard > silenceMs) this.#shutdown("the server went silent")
      },
      Math.min(1000, silenceMs),
    )

    void (async () => {
      for (let p = await packets.next(); p !== undefined; p = await packets.next()) {
        this.#deliver(decodeServerPacket(p))
      }
      this.#shutdown(packets.failure("the server closed the TCP connection").message)
    })()

    return session
  }

  #assertOpen(): void {
    if (this.#closed) throw new SpectatorError("closed while joining")
  }

  /** For scripted test drivers that need to say things a recorder never would. */
  protected sendTcp(payload: Buffer): void {
    this.#tcp?.write(frame(payload))
  }

  get closed(): boolean {
    return this.#closed
  }

  close(): void {
    if (this.#tcp?.writable) this.#tcp.write(frame(encodeCleanExit()))
    this.#shutdown("closed by us")
  }

  #plausible(p: ServerPacket & { kind: "position" }): ServerPacket {
    const now = this.#now()
    return { kind: "position", cars: p.cars.filter((c) => isPlausibleTimestamp(now, c.timestamp)) }
  }

  #deliver(p: ServerPacket): void {
    if (this.#closed) return
    try {
      this.#opts.onPacket(p, this.#now())
    } catch (e) {
      // A recorder that cannot write what it receives should stop holding a
      // slot, not keep a car on the grid that records nothing.
      this.#shutdown(`onPacket threw: ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    if (p.kind === "kick" && p.carId === this.session?.carId) this.#shutdown(kickReason(p.reason))
  }

  async #checksums(session: HandshakeOk): Promise<Buffer[]> {
    const md5 = (b: Buffer): Buffer => createHash("md5").update(b).digest()
    const out: Buffer[] = []
    const root = resolvePath(this.#opts.acRoot)
    // The server names the files; it doesn't get to learn about any outside
    // the AC root.
    const inside = (path: string): boolean => {
      const rel = relative(root, resolvePath(root, path))
      return !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    }
    for (const path of session.checksumPaths) {
      if (!inside(path)) {
        throw new SpectatorError(`the server wants a checksum of ${path}, outside the AC root`)
      }
      // A missing file would be hashed as something, fail the check, and get
      // the car kicked a few seconds later with nothing to say why.
      const bytes = await readFile(join(root, path)).catch(() => {
        throw new SpectatorError(
          `the server wants a checksum of ${path}, which is not under ${this.#opts.acRoot}`,
        )
      })
      out.push(md5(bytes))
    }
    // The car's own data.acd. A server without one accepts anything here.
    const acdPath = join("content/cars", session.car, "data.acd")
    const acd = inside(acdPath)
      ? await readFile(join(root, acdPath)).catch(() => undefined)
      : undefined
    out.push(acd ? md5(acd) : Buffer.alloc(16))
    return out
  }

  #sendPosition(): void {
    const now = this.#now()
    this.#udpSend(
      encodeOwnPosition({
        seq: this.#seq++,
        timestamp: now,
        rpm: IDLE_RPM,
        gear: NEUTRAL,
        ...this.#opts.pose(now),
      }),
    )
  }

  #udpSend(b: Buffer): void {
    if (this.#closed || !this.session) return
    if (!this.#address) return
    this.#udp?.send(b, this.session.udpPort, this.#address, (e) => {
      if (e) this.#shutdown(`UDP send failed: ${e.message}`)
    })
  }

  #shutdown(reason: string): void {
    if (this.#closed) return
    this.#closed = true
    clearInterval(this.#timer)
    clearInterval(this.#watchdog)
    this.#udp?.close()
    const tcp = this.#tcp
    tcp?.end()
    // end() waits for the other side, which may be gone.
    setTimeout(() => tcp?.destroy(), 1000).unref()
    this.#opts.onClose?.(reason)
  }
}

/** Why the server removed this car, as the KickCar packet's reason byte says. */
export function kickReason(reason: number): string {
  switch (reason) {
    case 0:
    case 1:
    case 2:
      return "kicked by a vote of the other drivers"
    case 3:
      // The one an operator can fix: the copies of the car and track files
      // the car answers checksums from aren't the server's.
      return "kicked because a checksum didn't match: the car and track files under the AC root differ from the server's"
    case 4:
      return "kicked by an admin"
    default:
      return `kicked (reason ${reason})`
  }
}

/**
 * The server translates a car's timestamp through two clock offsets, its own
 * to that car's and its own to ours, and each is zero until that client has
 * answered a ping. Until both exist the timestamp is off by about the server's
 * uptime, in either direction and modulo 2^32, so a car's first second or so
 * lands far from the rest of its samples. Anything not near our clock is out.
 */
export function isPlausibleTimestamp(now: number, timestamp: number): boolean {
  return Math.abs((now - timestamp) | 0) < MAX_SKEW_MS
}

async function raceTimeout(p: Promise<void>, ms: number): Promise<boolean> {
  let t: NodeJS.Timeout | undefined
  const timeout = new Promise<boolean>((r) => {
    t = setTimeout(() => r(false), ms)
  })
  try {
    return await Promise.race([p.then(() => true), timeout])
  } finally {
    clearTimeout(t)
  }
}

interface PacketQueue {
  next(): Promise<Buffer | undefined>
  /** Why the stream ended: the socket's own error if it had one, else `fallback`. */
  failure(fallback: string): Error
  /** Read until `want` matches, handing everything else to `other`. */
  until(
    want: (p: ServerPacket) => boolean,
    other: (p: ServerPacket) => void,
  ): Promise<ServerPacket | undefined>
}

function tcpPackets(tcp: Socket): PacketQueue {
  const deframer = new TcpDeframer()
  const ready: Buffer[] = []
  let waiting: ((b: Buffer | undefined) => void) | undefined
  let ended = false
  let error: Error | undefined
  tcp.on("error", (e) => {
    error = e
  })
  tcp.on("data", (chunk) => {
    ready.push(...deframer.push(chunk))
    if (waiting && ready.length) {
      const w = waiting
      waiting = undefined
      w(ready.shift())
    }
  })
  tcp.on("close", () => {
    ended = true
    waiting?.(undefined)
  })
  const next = (): Promise<Buffer | undefined> => {
    if (ready.length) return Promise.resolve(ready.shift())
    if (ended) return Promise.resolve(undefined)
    return new Promise((r) => {
      waiting = r
    })
  }
  return {
    next,
    failure: (fallback) => error ?? new SpectatorError(fallback),
    async until(want, other) {
      for (let b = await next(); b !== undefined; b = await next()) {
        const p = decodeServerPacket(b)
        if (want(p)) return p
        other(p)
      }
      return undefined
    },
  }
}
