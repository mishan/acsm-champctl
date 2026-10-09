/**
 * The Assetto Corsa client protocol, as far as a car parked in its pit box
 * needs it: join, prove its files, keep the connection alive, and decode what
 * the server says about every other car.
 *
 * Written from a description of the protocol, not from any implementation's
 * source. Packets this does not know are surfaced as `unknown` rather than
 * dropped, because an unknown packet on a live server is the most useful thing
 * a recording can contain while the protocol is still being learned.
 */

import { WireReader, WireWriter } from "./wire.js"

export const PROTOCOL_VERSION = 202

export const Packet = {
  P2PUpdate: 0x0d,
  MandatoryPit: 0x0e,
  Blacklisted: 0x3b,
  WrongPassword: 0x3c,
  Handshake: 0x3d,
  HandshakeOk: 0x3e,
  CarListRequest: 0x3f,
  CarList: 0x40,
  ServerRunning: 0x41,
  UnsupportedProtocol: 0x42,
  CleanExit: 0x43,
  Checksum: 0x44,
  NoSlots: 0x45,
  Position: 0x46,
  Chat: 0x47,
  MegaPacket: 0x48,
  LapCompleted: 0x49,
  SessionUpdate: 0x4a,
  RaceOver: 0x4b,
  CarDisconnected: 0x4d,
  UdpAssociate: 0x4e,
  SessionRequest: 0x4f,
  TyreCompound: 0x50,
  Welcome: 0x51,
  DamageUpdate: 0x56,
  RaceStart: 0x57,
  SectorSplit: 0x58,
  CarConnected: 0x5a,
  DriverInfo: 0x5b,
  KickCar: 0x68,
  SessionClosed: 0x6e,
  AuthFailed: 0x6f,
  Weather: 0x78,
  ClientEvent: 0x82,
  Extended: 0xab,
  Pong: 0xf8,
  Ping: 0xf9,
} as const

const REJECTIONS: Record<number, string> = {
  [Packet.Blacklisted]: "this GUID is blacklisted",
  [Packet.WrongPassword]: "the password was wrong",
  [Packet.UnsupportedProtocol]: "the server speaks a different protocol version",
  [Packet.NoSlots]: "no free entry-list slot for the requested car",
  [Packet.SessionClosed]: "the session is closed to new joins",
  [Packet.ServerRunning]: "no session is running",
}

export interface HandshakeRequest {
  guid: string
  name: string
  team: string
  nation: string
  car: string
  password: string
}

export function encodeHandshake(r: HandshakeRequest): Buffer {
  return new WireWriter()
    .u8(Packet.Handshake)
    .u16(PROTOCOL_VERSION)
    .ascii(r.guid)
    .utf32(r.name)
    .ascii(r.team)
    .ascii(r.nation)
    .ascii(r.car)
    .ascii(r.password)
    .build()
}

export interface SessionSummary {
  type: number
  laps: number
  minutes: number
}

export interface HandshakeOk {
  serverName: string
  udpPort: number
  refreshHz: number
  track: string
  trackConfig: string
  car: string
  skin: string
  carId: number
  sessions: SessionSummary[]
  currentSession: { name: string; index: number; type: number; minutes: number; laps: number }
  elapsedMs: number
  checksumPaths: string[]
}

export type HandshakeReply =
  | { ok: true; value: HandshakeOk }
  | { ok: false; id: number; reason: string }

/** `body` starts at the packet id. */
export function decodeHandshakeReply(body: Buffer): HandshakeReply {
  const r = new WireReader(body)
  const id = r.u8()
  if (id === Packet.AuthFailed)
    return { ok: false, id, reason: `authentication failed: ${r.utf32()}` }
  if (id !== Packet.HandshakeOk) {
    return { ok: false, id, reason: REJECTIONS[id] ?? `unexpected packet 0x${id.toString(16)}` }
  }
  const serverName = r.utf32()
  const udpPort = r.u16()
  const refreshHz = r.u8()
  const track = r.ascii()
  const trackConfig = r.ascii()
  const car = r.ascii()
  const skin = r.ascii()
  // sun angle, tyres out, blankets, TC, ABS, stability, autoclutch, jump start,
  // damage, fuel, wear, mirror, contacts/km, race-over, result screen, extra
  // lap, gas penalty, pit window ×2, inverted grid
  r.skip(4 + 2 + 1 + 1 + 1 + 1 + 1 + 1 + 4 + 4 + 4 + 1 + 1 + 4 + 4 + 1 + 1 + 2 + 2 + 2)
  const carId = r.u8()
  const sessions: SessionSummary[] = []
  for (let n = r.u8(); n > 0; n--) sessions.push({ type: r.u8(), laps: r.u16(), minutes: r.u16() })
  const currentSession = {
    name: r.ascii(),
    index: r.u8(),
    type: r.u8(),
    minutes: r.u16(),
    laps: r.u16(),
  }
  r.skip(4 + 1) // grip, a second car-id-shaped byte whose meaning differs by server
  const elapsedMs = Number(r.bytes(8).readBigInt64LE())
  const checksumPaths: string[] = []
  for (let n = r.u8(); n > 0; n--) checksumPaths.push(r.ascii())
  return {
    ok: true,
    value: {
      serverName,
      udpPort,
      refreshHz,
      track,
      trackConfig,
      car,
      skin,
      carId,
      sessions,
      currentSession,
      elapsedMs,
      checksumPaths,
    },
  }
}

export function encodeChecksum(md5s: readonly Buffer[]): Buffer {
  const w = new WireWriter().u8(Packet.Checksum)
  for (const m of md5s) w.bytes(m)
  return w.build()
}

export function encodeCarListRequest(offset: number): Buffer {
  return new WireWriter().u8(Packet.CarListRequest).u8(offset).build()
}

export interface CarListEntry {
  carId: number
  model: string
  skin: string
  driver: string
  team: string
  nation: string
  spectator: boolean
}

export function decodeCarList(body: Buffer): CarListEntry[] {
  const r = new WireReader(body, 1)
  r.u8() // offset
  const out: CarListEntry[] = []
  for (let n = r.u8(); n > 0; n--) {
    out.push({
      carId: r.u8(),
      model: r.ascii(),
      skin: r.ascii(),
      driver: r.ascii(),
      team: r.ascii(),
      nation: r.ascii(),
      spectator: r.u8() !== 0,
    })
    r.skip(20) // damage zones
  }
  return out
}

export type Vec3 = [number, number, number]

export interface OwnPosition {
  seq: number
  timestamp: number
  pos: Vec3
  rot: Vec3
  vel: Vec3
  rpm: number
  gear: number
  steer?: number
  gas?: number
  statusFlags?: number
}

/** 62 bytes: what this client says about its own car. */
export function encodeOwnPosition(p: OwnPosition): Buffer {
  return new WireWriter()
    .u8(Packet.Position)
    .u8(p.seq & 0xff)
    .u32(p.timestamp >>> 0)
    .vec3(p.pos)
    .vec3(p.rot)
    .vec3(p.vel)
    .bytes(Buffer.from([100, 100, 100, 100]))
    .u8(127 + Math.round(p.steer ?? 0))
    .u8(127)
    .u16(p.rpm)
    .u8(p.gear)
    .u32(p.statusFlags ?? 0)
    .u16(0)
    .u8(Math.round((p.gas ?? 0) * 255))
    .f32(0)
    .build()
}

export const BRAKE_LIGHTS = 0x10

export interface CarState {
  carId: number
  seq: number
  /** Sample time in this client's clock, ms, wrapping at 2^32. */
  timestamp: number
  ping: number
  pos: Vec3
  /** Yaw, pitch, roll in radians. */
  rot: Vec3
  vel: Vec3
  /** Signed steering byte, 0 when centered. Its unit is not yet measured. */
  steer: number
  rpm: number
  gear: number
  statusFlags: number
  /** 0–1. Absent from the batched form. */
  gas?: number
}

function readCarState(r: WireReader, carId: number, batched: boolean): CarState {
  const seq = r.u8()
  const timestamp = r.u32()
  const ping = r.u16()
  const pos = r.vec3()
  const rot = r.vec3()
  const vel = r.vec3()
  r.skip(4) // tyre angular speeds
  const steer = r.u8() - 127
  r.skip(1) // wheel angle
  const rpm = r.u16()
  const gear = r.u8()
  const statusFlags = r.u32()
  const state: CarState = {
    carId,
    seq,
    timestamp,
    ping,
    pos,
    rot,
    vel,
    steer,
    rpm,
    gear,
    statusFlags,
  }
  if (!batched) {
    r.skip(2) // performance delta
    state.gas = r.u8() / 255
  }
  return state
}

export type ServerPacket =
  | { kind: "position"; cars: CarState[] }
  | { kind: "ping"; serverTime: number; ping: number }
  | { kind: "associated" }
  | { kind: "carList"; cars: CarListEntry[] }
  | { kind: "carConnected"; carId: number; name: string; nation: string }
  | { kind: "carDisconnected"; carId: number }
  | { kind: "driverInfo"; drivers: { carId: number; name: string }[] }
  | {
      kind: "lapCompleted"
      carId: number
      lapMs: number
      cuts: number
      standings: { carId: number; time: number; laps: number; completed: boolean }[]
    }
  | { kind: "sectorSplit"; carId: number; split: number; ms: number; cuts: number }
  | {
      kind: "session"
      name: string
      index: number
      type: number
      minutes: number
      laps: number
      grid: number[]
      startTime: number
    }
  | { kind: "raceOver"; rows: { carId: number; time: number; laps: number }[] }
  | { kind: "raceStart"; startTime: number; now: number }
  | { kind: "damage"; carId: number; zones: number[] }
  | { kind: "chat"; carId: number; text: string }
  | { kind: "kick"; carId: number; reason: number }
  | { kind: "unknown"; id: number; length: number }
  | { kind: "malformed"; id: number; length: number; error: string }

/**
 * Decode one server packet, TCP payload or UDP datagram. `body` starts at the
 * id. A known id whose body doesn't fit its layout comes back as `malformed`
 * rather than throwing: on a live server that is a protocol difference worth
 * recording, not a reason to drop the connection.
 */
export function decodeServerPacket(body: Buffer): ServerPacket {
  if (body.length === 0) return { kind: "malformed", id: -1, length: 0, error: "empty packet" }
  try {
    return decodeKnown(body)
  } catch (e) {
    return { kind: "malformed", id: body[0]!, length: body.length, error: String(e) }
  }
}

function decodeKnown(body: Buffer): ServerPacket {
  const r = new WireReader(body)
  const id = r.u8()
  switch (id) {
    case Packet.Position: {
      const carId = r.u8()
      return { kind: "position", cars: [readCarState(r, carId, false)] }
    }
    case Packet.MegaPacket: {
      r.skip(4 + 2) // server now, own ping
      const cars: CarState[] = []
      for (let n = r.u8(); n > 0; n--) cars.push(readCarState(r, r.u8(), true))
      return { kind: "position", cars }
    }
    case Packet.Ping:
      return { kind: "ping", serverTime: r.u32(), ping: r.u16() }
    case Packet.UdpAssociate:
      return { kind: "associated" }
    case Packet.CarList:
      return { kind: "carList", cars: decodeCarList(body) }
    case Packet.CarConnected:
      return { kind: "carConnected", carId: r.u8(), name: r.ascii(), nation: r.ascii() }
    case Packet.CarDisconnected:
      return { kind: "carDisconnected", carId: r.u8() }
    case Packet.DriverInfo: {
      const drivers: { carId: number; name: string }[] = []
      for (let n = r.u8(); n > 0; n--) drivers.push({ carId: r.u8(), name: r.utf32() })
      return { kind: "driverInfo", drivers }
    }
    case Packet.LapCompleted: {
      const carId = r.u8()
      const lapMs = r.u32()
      const cuts = r.u8()
      const standings: { carId: number; time: number; laps: number; completed: boolean }[] = []
      for (let n = r.u8(); n > 0; n--) {
        standings.push({ carId: r.u8(), time: r.u32(), laps: r.u16(), completed: r.u8() !== 0 })
      }
      return { kind: "lapCompleted", carId, lapMs, cuts, standings }
    }
    case Packet.SectorSplit:
      return { kind: "sectorSplit", carId: r.u8(), split: r.u8(), ms: r.u32(), cuts: r.u8() }
    case Packet.SessionUpdate: {
      const name = r.ascii()
      const index = r.u8()
      const type = r.u8()
      const minutes = r.u16()
      const laps = r.u16()
      r.skip(4) // grip
      // The grid has no count: it is whatever sits between here and the
      // trailing i64 start time.
      const grid = [...r.bytes(r.remaining - 8)]
      const startTime = Number(r.bytes(8).readBigInt64LE())
      return { kind: "session", name, index, type, minutes, laps, grid, startTime }
    }
    case Packet.RaceOver: {
      const rows: { carId: number; time: number; laps: number }[] = []
      while (r.remaining >= 7) rows.push({ carId: r.u8(), time: r.u32(), laps: r.u16() })
      return { kind: "raceOver", rows }
    }
    case Packet.RaceStart:
      return { kind: "raceStart", startTime: r.i32(), now: r.u32() }
    case Packet.DamageUpdate:
      return { kind: "damage", carId: r.u8(), zones: [r.f32(), r.f32(), r.f32(), r.f32(), r.f32()] }
    case Packet.Chat:
      return { kind: "chat", carId: r.u8(), text: r.utf32() }
    case Packet.KickCar:
      return { kind: "kick", carId: r.u8(), reason: r.u8() }
    default:
      return { kind: "unknown", id, length: body.length }
  }
}

export function encodePong(serverTime: number, clientTime: number): Buffer {
  return new WireWriter()
    .u8(Packet.Pong)
    .u32(serverTime >>> 0)
    .u32(clientTime >>> 0)
    .build()
}

export function encodeAssociate(carId: number): Buffer {
  return new WireWriter().u8(Packet.UdpAssociate).u8(carId).build()
}

export function encodeCleanExit(): Buffer {
  return Buffer.from([Packet.CleanExit])
}

/** Frame a TCP payload with its u16 little-endian length. */
export function frame(payload: Buffer): Buffer {
  const head = Buffer.alloc(2)
  head.writeUInt16LE(payload.length)
  return Buffer.concat([head, payload])
}

/** Accumulates TCP bytes and yields whole packets. */
export class TcpDeframer {
  #pending: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): Buffer[] {
    this.#pending = this.#pending.length ? Buffer.concat([this.#pending, chunk]) : chunk
    const out: Buffer[] = []
    while (this.#pending.length >= 2) {
      const len = this.#pending.readUInt16LE(0)
      if (this.#pending.length < 2 + len) break
      out.push(this.#pending.subarray(2, 2 + len))
      this.#pending = this.#pending.subarray(2 + len)
    }
    return out
  }
}
