/**
 * The server's UDP plugin feed: the one place car-to-car collisions are
 * reported. Game clients are never told about contact between other cars, so
 * the spectator alone can see two cars meet but not that they touched.
 *
 * ACSM 2.4.8+ runs any number of plugin listeners side by side, so this sits
 * next to whatever else a league already has plugged in rather than in front
 * of it.
 */

import { createSocket, type Socket } from "node:dgram"
import { lookup } from "node:dns/promises"
import type { Vec3 } from "./protocol.js"
import { WireReader, WireWriter } from "./wire.js"

export const PluginPacket = {
  NewSession: 0x32,
  NewConnection: 0x33,
  ClosedConnection: 0x34,
  CarUpdate: 0x35,
  CarInfo: 0x36,
  EndSession: 0x37,
  Version: 0x38,
  Chat: 0x39,
  ClientLoaded: 0x3a,
  SessionInfo: 0x3b,
  Error: 0x3c,
  LapCompleted: 0x49,
  ClientEvent: 0x82,
  SetRealtimePosInterval: 0xc8,
  GetSessionInfo: 0xcc,
} as const

export const COLLISION_WITH_CAR = 0x0a
export const COLLISION_WITH_ENV = 0x0b

export type PluginEvent =
  | {
      kind: "session"
      /** True for a session starting, false for an answer to GetSessionInfo. */
      isNew: boolean
      index: number
      currentIndex: number
      count: number
      serverName: string
      track: string
      trackConfig: string
      name: string
      type: number
      minutes: number
      laps: number
      ambient: number
      road: number
      weather: string
      elapsedMs: number
    }
  | { kind: "endSession"; resultsFile: string }
  | {
      kind: "connection"
      connected: boolean
      name: string
      guid: string
      carId: number
      model: string
      skin: string
    }
  | {
      kind: "carUpdate"
      carId: number
      pos: Vec3
      vel: Vec3
      gear: number
      rpm: number
      spline: number
    }
  | {
      kind: "collision"
      carId: number
      /** Absent for a collision with the environment. */
      otherCarId?: number
      impactSpeed: number
      worldPos: Vec3
      /** Contact point in the first car's own frame. */
      relPos: Vec3
    }
  | { kind: "lapCompleted"; carId: number; lapMs: number; cuts: number }
  | { kind: "clientLoaded"; carId: number }
  | { kind: "version"; version: number }
  | { kind: "chat"; carId: number; text: string }
  | { kind: "error"; message: string }
  | { kind: "unknown"; id: number; length: number }
  | { kind: "malformed"; id: number; length: number; error: string }

export function decodePluginPacket(body: Buffer): PluginEvent {
  if (body.length === 0) return { kind: "malformed", id: -1, length: 0, error: "empty packet" }
  try {
    return decodeKnown(body)
  } catch (e) {
    return { kind: "malformed", id: body[0]!, length: body.length, error: String(e) }
  }
}

function decodeKnown(body: Buffer): PluginEvent {
  const r = new WireReader(body)
  const id = r.u8()
  switch (id) {
    case PluginPacket.NewSession:
    case PluginPacket.SessionInfo: {
      r.u8() // protocol version
      const index = r.u8()
      const currentIndex = r.u8()
      const count = r.u8()
      const serverName = r.utf32()
      const track = r.ascii()
      const trackConfig = r.ascii()
      const name = r.ascii()
      const type = r.u8()
      const minutes = r.u16()
      const laps = r.u16()
      r.u16() // wait time
      const ambient = r.u8()
      const road = r.u8()
      // 8-bit text, measured on ACSM 2.4.15; AssettoServer writes UTF-32.
      const weather = r.ascii()
      const elapsedMs = r.i32()
      return {
        kind: "session",
        isNew: id === PluginPacket.NewSession,
        index,
        currentIndex,
        count,
        serverName,
        track,
        trackConfig,
        name,
        type,
        minutes,
        laps,
        ambient,
        road,
        weather,
        elapsedMs,
      }
    }
    case PluginPacket.EndSession:
      return { kind: "endSession", resultsFile: r.utf32() }
    case PluginPacket.NewConnection:
    case PluginPacket.ClosedConnection:
      return {
        kind: "connection",
        connected: id === PluginPacket.NewConnection,
        name: r.utf32(),
        guid: r.utf32(),
        carId: r.u8(),
        model: r.ascii(),
        skin: r.ascii(),
      }
    case PluginPacket.CarUpdate:
      return {
        kind: "carUpdate",
        carId: r.u8(),
        pos: r.vec3(),
        vel: r.vec3(),
        gear: r.u8(),
        rpm: r.u16(),
        spline: r.f32(),
      }
    case PluginPacket.ClientEvent: {
      const type = r.u8()
      const carId = r.u8()
      if (type !== COLLISION_WITH_CAR && type !== COLLISION_WITH_ENV) {
        return { kind: "unknown", id, length: body.length }
      }
      const otherCarId = type === COLLISION_WITH_CAR ? r.u8() : undefined
      const impactSpeed = r.f32()
      const worldPos = r.vec3()
      const relPos = r.vec3()
      return {
        kind: "collision",
        carId,
        ...(otherCarId === undefined ? {} : { otherCarId }),
        impactSpeed,
        worldPos,
        relPos,
      }
    }
    case PluginPacket.LapCompleted:
      return { kind: "lapCompleted", carId: r.u8(), lapMs: r.u32(), cuts: r.u8() }
    case PluginPacket.ClientLoaded:
      return { kind: "clientLoaded", carId: r.u8() }
    case PluginPacket.Version:
      return { kind: "version", version: r.u8() }
    case PluginPacket.Chat:
      return { kind: "chat", carId: r.u8(), text: r.utf32() }
    case PluginPacket.Error:
      return { kind: "error", message: r.utf32() }
    default:
      return { kind: "unknown", id, length: body.length }
  }
}

export function encodeRealtimeInterval(ms: number): Buffer {
  return new WireWriter().u8(PluginPacket.SetRealtimePosInterval).u16(ms).build()
}

export function encodeGetSessionInfo(): Buffer {
  // -1 asks for the current session.
  return new WireWriter().u8(PluginPacket.GetSessionInfo).u16(0xffff).build()
}

export interface PluginListenerOptions {
  /** Where the server sends the feed: its plugin "Send Address". */
  listenPort: number
  /** Defaults to loopback: nothing but the server should reach this. */
  listenHost?: string
  /**
   * Addresses the feed may come from; anything else is dropped. Defaults to
   * wherever `serverHost` resolves. A spoofed packet here would be a
   * collision nobody had, written into the evidence.
   */
  allowedSources?: readonly string[]
  /** Where the server takes commands: its plugin "Listen Address". */
  serverHost: string
  serverPort: number
  /**
   * Car update interval to ask for, in ms. The feed's car updates carry the
   * spline position the game protocol lacks; 0 leaves the server's setting.
   */
  realtimeIntervalMs?: number
  onEvent: (event: PluginEvent, receivedAt: number) => void
  onError?: (e: Error) => void
  now?: () => number
}

export class PluginListener {
  readonly #opts: PluginListenerOptions
  readonly #now: () => number
  #socket: Socket | undefined

  constructor(opts: PluginListenerOptions) {
    this.#opts = opts
    this.#now = opts.now ?? (() => Date.now())
  }

  async start(): Promise<void> {
    const { listenPort, listenHost = "127.0.0.1" } = this.#opts
    const allowed = new Set(
      this.#opts.allowedSources ??
        (await lookup(this.#opts.serverHost, { all: true, family: 4 })).map((a) => a.address),
    )
    const socket = createSocket("udp4")
    this.#socket = socket
    socket.on("error", (e) => this.#opts.onError?.(e))
    socket.on("message", (msg, from) => {
      if (!allowed.has(from.address)) return
      const event = decodePluginPacket(msg)
      // ACSM starts a fresh server process for each event, and a fresh
      // process has never heard of the interval, so it is asked again.
      if (event.kind === "session" && event.isNew) this.#askForInterval()
      this.#opts.onEvent(event, this.#now())
    })
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject)
      socket.bind(listenPort, listenHost, () => {
        socket.off("error", reject)
        resolve()
      })
    })
    this.#askForInterval()
    this.#send(encodeGetSessionInfo())
  }

  address(): { address: string; port: number } | undefined {
    return this.#socket?.address()
  }

  close(): void {
    this.#socket?.close()
    this.#socket = undefined
  }

  #askForInterval(): void {
    const ms = this.#opts.realtimeIntervalMs ?? 0
    if (ms > 0) this.#send(encodeRealtimeInterval(ms))
  }

  #send(b: Buffer): void {
    this.#socket?.send(b, this.#opts.serverPort, this.#opts.serverHost)
  }
}
