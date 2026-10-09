/**
 * Writes an Assetto Corsa `.acreplay` (version 16) from a recorder journal.
 *
 * Built from published notes on the format, then checked against a 26-car
 * race replay the game itself wrote; what that settled is noted where it's
 * used. The network carries no wheel positions, so they come from each car's
 * own data (`cardata.ts`), or an R32's when a car's data can't be read.
 * Still unmeasured:
 *
 * - **Sun angle, wing data and track objects,** written as zero and none,
 *   which the game accepts.
 */

import { createReadStream, createWriteStream, type WriteStream } from "node:fs"
import { finished } from "node:stream/promises"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { carWheels } from "./cardata.js"
import { readJournal, type JournalRecord } from "./journal.js"
import { BRAKE_LIGHTS, type CarState, type Vec3 } from "./protocol.js"

export const REPLAY_VERSION = 16
const FRAME_BYTES = 256
const FRAME_HEADER_BYTES = 20
/** Longer than any gap between two samples of a car that is still connected. */
const MAX_GAP_MS = 1000

/** Body-local wheel centers, meters: x across, y up, z forward. FL, FR, RL, RR. */
export type WheelOffsets = [Vec3, Vec3, Vec3, Vec3]

/** A Nissan R32's, measured from a replay the game wrote: x is the car's left. */
export const DEFAULT_WHEEL_OFFSETS: WheelOffsets = [
  [0.79, -0.15, 1.07],
  [-0.79, -0.15, 1.07],
  [0.76, -0.14, -1.54],
  [-0.76, -0.14, -1.54],
]

/** Front wheel angle per degree of steering wheel: 1/14.4, the median over 7,344 cornering frames of that replay. */
const STEERING_RATIO = 14.4
/** Rolling radius, meters: the same replay's wheels turned at speed / 0.33. */
const WHEEL_RADIUS_M = 0.33

export interface ReplayOptions {
  /** Frame spacing in ms. Defaults to 1000/18, the usual server send rate. */
  intervalMs?: number
  /** An AC `content/cars` folder to read each car's wheel positions from. */
  carsDir?: string
  weather?: string
}

export interface ReplaySummary {
  frames: number
  /** `ownWheels` is false where a car's data couldn't be read and the R32's stood in. */
  cars: { carId: number; model: string; driver: string; samples: number; ownWheels: boolean }[]
  durationMs: number
}

interface CarMeta {
  model: string
  skin: string
  driver: string
  nation: string
  team: string
}

// One spooled sample: time f64, pos/rot/vel 9×f32, steer i8, gear u8, rpm u16,
// flags u32, gas u8, pad.
const SAMPLE_BYTES = 8 + 36 + 1 + 1 + 2 + 4 + 1 + 3

function encodeSample(c: CarState): Buffer {
  const b = Buffer.alloc(SAMPLE_BYTES)
  b.writeDoubleLE(c.timestamp, 0)
  ;[...c.pos, ...c.rot, ...c.vel].forEach((v, i) => {
    b.writeFloatLE(v, 8 + i * 4)
  })
  b.writeInt8(Math.max(-128, Math.min(127, c.steer)), 44)
  b.writeUInt8(c.gear, 45)
  b.writeUInt16LE(Math.min(c.rpm, 0xffff), 46)
  b.writeUInt32LE(c.statusFlags >>> 0, 48)
  b.writeUInt8(Math.round((c.gas ?? 0) * 255), 52)
  return b
}

interface Samples {
  t: Float64Array
  /** 9 floats per sample: pos, rot, vel. */
  f: Float32Array
  steer: Int8Array
  gear: Uint8Array
  rpm: Uint16Array
  flags: Uint32Array
  gas: Uint8Array
}

function decodeSamples(raw: Buffer): Samples {
  const n = raw.length / SAMPLE_BYTES
  const s: Samples = {
    t: new Float64Array(n),
    f: new Float32Array(n * 9),
    steer: new Int8Array(n),
    gear: new Uint8Array(n),
    rpm: new Uint16Array(n),
    flags: new Uint32Array(n),
    gas: new Uint8Array(n),
  }
  for (let i = 0; i < n; i++) {
    const o = i * SAMPLE_BYTES
    s.t[i] = raw.readDoubleLE(o)
    for (let k = 0; k < 9; k++) s.f[i * 9 + k] = raw.readFloatLE(o + 8 + k * 4)
    s.steer[i] = raw.readInt8(o + 44)
    s.gear[i] = raw.readUInt8(o + 45)
    s.rpm[i] = raw.readUInt16LE(o + 46)
    s.flags[i] = raw.readUInt32LE(o + 48)
    s.gas[i] = raw.readUInt8(o + 52)
  }
  return s
}

/**
 * Car timestamps are this recorder's u32 millisecond clock. A session never
 * runs 49 days, but it can straddle the wrap, so times are unwrapped against
 * the first sample seen.
 */
function unwrapper(): (ts: number) => number {
  let base: number | undefined
  return (ts) => {
    base ??= ts
    return base + ((ts - base) | 0)
  }
}

export async function writeReplay(
  journalPath: string,
  outPath: string,
  options: ReplayOptions = {},
): Promise<ReplaySummary> {
  const intervalMs = options.intervalMs ?? 1000 / 18

  const spoolDir = await mkdtemp(join(tmpdir(), "acreplay-"))
  const spools = new Map<number, Sink>()
  let out: Sink | undefined
  try {
    let session: (JournalRecord & { t: "session" }) | undefined
    const meta = new Map<number, CarMeta>()
    // Samples per driver name per car: a slot can change hands mid-session,
    // and the replay has room for one car and name, so it goes to whoever
    // drove most, with their car and their laps.
    const driven = new Map<number, Map<string, { n: number; meta: CarMeta }>>()
    const laps = new Map<number, { at: number; lapMs: number; driver: string }[]>()
    /** When each car's driver left, which the game shows at once. */
    const drops = new Map<number, number[]>()
    const counts = new Map<number, number>()
    const unwrap = unwrapper()
    let start = Infinity
    let end = -Infinity

    for await (const r of readJournal(journalPath)) {
      switch (r.t) {
        case "session":
          session ??= r
          break
        case "car": {
          const prev = meta.get(r.carId)
          meta.set(r.carId, {
            model: r.model || prev?.model || "",
            skin: r.skin || prev?.skin || "",
            driver: r.driver || prev?.driver || "",
            nation: r.nation ?? prev?.nation ?? "",
            team: r.team ?? prev?.team ?? "",
          })
          break
        }
        case "pos": {
          const id = r.car.carId
          if (id === session?.recorderCarId) break
          let spool = spools.get(id)
          if (!spool) {
            spool = new Sink(createWriteStream(join(spoolDir, `${id}.bin`)))
            spools.set(id, spool)
          }
          const t = unwrap(r.car.timestamp)
          start = Math.min(start, t)
          end = Math.max(end, t)
          await spool.write(encodeSample({ ...r.car, timestamp: t }))
          counts.set(id, (counts.get(id) ?? 0) + 1)
          const m = meta.get(id)
          const driver = m?.driver ?? ""
          const byDriver = driven.get(id) ?? new Map()
          const seen = byDriver.get(driver)
          if (seen) seen.n++
          else if (m) byDriver.set(driver, { n: 1, meta: { ...m } })
          driven.set(id, byDriver)
          break
        }
        case "connection":
          if (!r.connected) {
            const list = drops.get(r.carId) ?? []
            list.push(unwrap(r.at))
            drops.set(r.carId, list)
          }
          break
        case "lap": {
          const list = laps.get(r.carId) ?? []
          // Lap times are the recorder's clock in full; samples carry it cut
          // to 32 bits, so they part ways after 49.7 days of recording.
          list.push({
            at: unwrap(r.at),
            lapMs: r.lapMs,
            driver: meta.get(r.carId)?.driver ?? "",
          })
          laps.set(r.carId, list)
          break
        }
        default:
          break
      }
    }
    if (!session) throw new Error(`${journalPath} has no session record`)
    for (const spool of spools.values()) await spool.end()

    const carIds = [...spools.keys()].sort((a, b) => a - b)
    if (carIds.length === 0) throw new Error(`${journalPath} recorded no cars moving`)
    for (const [id, byDriver] of driven) {
      const mostly = [...byDriver.values()].sort((a, b) => b.n - a.n)[0]
      if (!mostly) continue
      meta.set(id, mostly.meta)
      laps.set(
        id,
        (laps.get(id) ?? []).filter((l) => l.driver === mostly.meta.driver),
      )
    }
    const frames = Math.max(1, Math.floor((end - start) / intervalMs) + 1)

    const ownWheels = new Set<number>()
    out = new Sink(createWriteStream(outPath, { flags: "wx" }))
    await out.write(
      Buffer.concat([
        u32(REPLAY_VERSION),
        f64(intervalMs),
        lstring(options.weather ?? ""),
        lstring(session.track),
        lstring(session.trackConfig),
        u32(carIds.length),
        u32(frames),
        u32(frames),
        u32(0), // track objects
      ]),
    )
    // Global frame data: sun angle and two unknown bytes per frame.
    await out.write(Buffer.alloc(4 * frames))

    for (const id of carIds) {
      // Decoded one car at a time: a car's session is a few MB, the grid's is
      // a few hundred, and this runs beside a recorder that is still working.
      const s = decodeSamples(await readAll(join(spoolDir, `${id}.bin`)))
      sortByTime(s)
      const m = meta.get(id)
      await out.write(
        Buffer.concat([
          lstring(m?.model ?? ""),
          lstring(m?.driver ?? ""),
          lstring(m?.nation ?? ""),
          lstring(m?.team ?? ""),
          lstring(m?.skin ?? ""),
          u32(frames),
          u32(0), // wings
        ]),
      )
      const own =
        options.carsDir && m?.model
          ? await carWheels(options.carsDir, m.model).catch(() => undefined)
          : undefined
      if (own) ownWheels.add(id)
      const wheels = own ?? DEFAULT_WHEEL_OFFSETS
      const lapTimes = laps.get(id) ?? []
      const cursor = { i: 0 }
      const spin = { angle: 0, t: start }
      const frameHeader = Buffer.alloc(FRAME_HEADER_BYTES)
      for (let f = 0; f < frames; f++) {
        const t = start + f * intervalMs
        await out.write(frameHeader)
        await out.write(
          physicsFrame(s, t, cursor, wheels, lapState(lapTimes, t), spin, drops.get(id) ?? []),
        )
      }
      await out.write(u32(0)) // trailing count
    }

    await out.write(standings(carIds, laps))
    await out.end()
    out = undefined

    return {
      frames,
      durationMs: end - start,
      cars: carIds.map((carId) => ({
        carId,
        model: meta.get(carId)?.model ?? "",
        driver: meta.get(carId)?.driver ?? "",
        samples: counts.get(carId) ?? 0,
        ownWheels: ownWheels.has(carId),
      })),
    }
  } finally {
    for (const spool of spools.values()) spool.destroy()
    // A half-written replay is worse than none, but a file this never opened
    // (the wx refusal) belongs to someone else.
    if (out?.opened) {
      out.destroy()
      await rm(outPath, { force: true })
    }
    await rm(spoolDir, { recursive: true, force: true })
  }
}

/**
 * A file being written whose errors arrive as rejections at the next call,
 * never as an error event nobody is listening for: that event would take the
 * recording daemon down with it.
 */
class Sink {
  readonly #stream: WriteStream
  #error: Error | undefined
  opened = false

  constructor(stream: WriteStream) {
    this.#stream = stream
    stream.on("error", (e) => {
      this.#error ??= e
    })
    stream.once("open", () => {
      this.opened = true
    })
  }

  async write(b: Buffer): Promise<void> {
    if (this.#error) throw this.#error
    if (this.#stream.write(b)) return
    await new Promise<void>((resolve, reject) => {
      const onDrain = (): void => {
        this.#stream.off("error", onError)
        resolve()
      }
      const onError = (e: Error): void => {
        this.#stream.off("drain", onDrain)
        reject(e)
      }
      this.#stream.once("drain", onDrain)
      this.#stream.once("error", onError)
    })
  }

  async end(): Promise<void> {
    if (this.#error) throw this.#error
    this.#stream.end()
    await finished(this.#stream)
  }

  destroy(): void {
    this.#stream.destroy()
  }
}

async function readAll(path: string): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of createReadStream(path)) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

/** UDP can reorder; the spool is in arrival order. */
function sortByTime(s: Samples): void {
  const n = s.t.length
  let sorted = true
  for (let i = 1; i < n && sorted; i++) sorted = s.t[i - 1]! <= s.t[i]!
  if (sorted) return
  const order = [...s.t.keys()].sort((a, b) => s.t[a]! - s.t[b]!)
  const copy = <
    T extends Float64Array | Float32Array | Int8Array | Uint8Array | Uint16Array | Uint32Array,
  >(
    a: T,
    width = 1,
  ): T => {
    const b = a.slice() as T
    order.forEach((from, to) => {
      for (let k = 0; k < width; k++) b[to * width + k] = a[from * width + k]!
    })
    return b
  }
  s.t = copy(s.t)
  s.f = copy(s.f, 9)
  s.steer = copy(s.steer)
  s.gear = copy(s.gear)
  s.rpm = copy(s.rpm)
  s.flags = copy(s.flags)
  s.gas = copy(s.gas)
}

interface LapState {
  currentMs: number
  lastMs: number
  bestMs: number
  lap: number
}

/** Lap timing at `t`, from the server's own lap times rather than our clock. */
function lapState(completions: readonly { at: number; lapMs: number }[], t: number): LapState {
  let lap = 0
  let lastMs = 0
  let bestMs = 0
  let lapStart: number | undefined
  for (const c of completions) {
    if (c.at > t) break
    lastMs = c.lapMs
    bestMs = bestMs ? Math.min(bestMs, c.lapMs) : c.lapMs
    lapStart = c.at
    lap++
  }
  return { currentMs: lapStart === undefined ? 0 : t - lapStart, lastMs, bestMs, lap }
}

const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a))

/**
 * The body pose at `t`: positions and velocities interpolated between the two
 * samples either side, yaw interpolated the short way round and wrapped into
 * [-π, π] (the game ignores a yaw outside it), and everything else taken from
 * the earlier sample. Before a car's first sample, after its last, and across
 * a gap it is held where it was, stopped.
 *
 * It's out of the game, as the game shows a driver who dropped, from the
 * moment its driver left until its next sample; and, where the journal says
 * nothing of leaving, more than a gap's length before its first sample or
 * after its last. A gap with no one leaving is a car still connected.
 */
function poseAt(
  s: Samples,
  t: number,
  cursor: { i: number },
  drops: readonly number[],
): { pos: Vec3; rot: Vec3; vel: Vec3; k: number; held: boolean; present: boolean } {
  const n = s.t.length
  while (cursor.i < n - 1 && s.t[cursor.i + 1]! <= t) cursor.i++
  const a = cursor.i
  const b = Math.min(a + 1, n - 1)
  const ta = s.t[a]!
  const tb = s.t[b]!
  // Across a gap, such as a disconnect, the car waits where it was last seen
  // rather than gliding through whatever lies between.
  const held = t < ta || (t > ta && (b === a || tb - ta > MAX_GAP_MS))
  const left = drops.some((d) => d > ta && d <= t)
  const present = !left && (t < ta ? ta - t <= MAX_GAP_MS : b !== a || t - ta <= MAX_GAP_MS)
  const w = held || b === a || t <= ta ? 0 : Math.min(1, (t - ta) / (tb - ta))
  const lerp = (k: number): number => s.f[a * 9 + k]! + (s.f[b * 9 + k]! - s.f[a * 9 + k]!) * w
  const angle = (k: number): number => {
    const from = s.f[a * 9 + k]!
    return wrapAngle(from + wrapAngle(s.f[b * 9 + k]! - from) * w)
  }
  return {
    pos: [lerp(0), lerp(1), lerp(2)],
    rot: [angle(3), angle(4), angle(5)],
    // A held car with the last sample's speed would sit there with its
    // wheels spinning and its engine revving.
    vel: held ? [0, 0, 0] : [lerp(6), lerp(7), lerp(8)],
    k: a,
    held,
    present,
  }
}

function physicsFrame(
  s: Samples,
  t: number,
  cursor: { i: number },
  wheels: WheelOffsets,
  lap: LapState,
  spin: { angle: number; t: number },
  drops: readonly number[],
): Buffer {
  const { pos, rot, vel, k, held, present } = poseAt(s, t, cursor, drops)
  const b = Buffer.alloc(FRAME_BYTES)
  pos.forEach((v, i) => {
    b.writeFloatLE(v, i * 4)
  })
  rot.forEach((v, i) => {
    writeHalf(b, v, 12 + i * 2)
  })
  const [yaw, pitch, roll] = rot
  const speed = Math.hypot(vel[0], vel[1], vel[2])
  const omega = speed / WHEEL_RADIUS_M
  spin.angle = wrapAngle(spin.angle + omega * ((t - spin.t) / 1000))
  spin.t = t
  const steerYaw = ((s.steer[k]! / STEERING_RATIO) * Math.PI) / 180
  for (let w = 0; w < 4; w++) {
    const world = toWorld(wheels[w]!, pos, rot)
    world.forEach((v, i) => {
      b.writeFloatLE(v, 20 + w * 12 + i * 4) // static
      b.writeFloatLE(v, 92 + w * 12 + i * 4) // rolling
    })
    // Front wheels point where they're steered; rolling wheels also turn
    // about their axle, the middle angle of the stored Y-X-Z order.
    const wheelYaw = wrapAngle(yaw + (w < 2 ? steerYaw : 0))
    ;[wheelYaw, pitch, roll].forEach((v, i) => {
      writeHalf(b, v, 68 + w * 6 + i * 2)
    })
    ;[wheelYaw, spin.angle, roll].forEach((v, i) => {
      writeHalf(b, v, 140 + w * 6 + i * 2)
    })
    writeHalf(b, omega, 172 + w * 2)
  }
  vel.forEach((v, i) => {
    writeHalf(b, v, 164 + i * 2)
  })
  writeHalf(b, held ? 0 : s.rpm[k]!, 170)
  writeHalf(b, s.steer[k]!, 212)
  b.writeUInt32LE(Math.round(lap.currentMs), 220)
  b.writeUInt32LE(Math.round(lap.lastMs), 224)
  b.writeUInt32LE(Math.round(lap.bestMs), 228)
  b.writeUInt8(s.gear[k]!, 234)
  b.writeUInt8(s.gas[k]!, 244)
  b.writeUInt8(s.flags[k]! & BRAKE_LIGHTS ? 255 : 0, 245)
  b.writeUInt8(Math.min(lap.lap, 255), 246)
  b.writeUInt8(255, 253) // engine health
  // 1 while the car is in the session. The game writes 0 for a car that
  // dropped, from then on, and for one that never joined, and hides it.
  b.writeUInt8(present ? 1 : 0, 255)
  return b
}

/**
 * Body-local to world. Forward is (-sin yaw, cos yaw) and left is +x; pitch
 * and roll are applied negated, then yaw. Measured: those signs put a real
 * replay's wheels within 2 cm of where the game stored them, where the other
 * three combinations miss by 6 to 26 cm.
 */
function toWorld(local: Vec3, pos: Vec3, [yaw, pitch, roll]: Vec3): Vec3 {
  let [x, y, z] = local
  const cr = Math.cos(-roll)
  const sr = Math.sin(-roll)
  ;[x, y] = [x * cr - y * sr, x * sr + y * cr]
  const cp = Math.cos(-pitch)
  const sp = Math.sin(-pitch)
  ;[y, z] = [y * cp - z * sp, y * sp + z * cp]
  const cy = Math.cos(yaw)
  const sy = Math.sin(yaw)
  return [pos[0] + x * cy - z * sy, pos[1] + y, pos[2] + x * sy + z * cy]
}

/**
 * The table after the last car: the running order, once for the grid and
 * again each time the leader completes a lap. Each entry is the car's index
 * in the replay, -1.0 (meaning unknown), 1, laps completed and total time in
 * ms as a float, sorted by position: read from a replay the game wrote.
 *
 * The game takes the names it shows from it, so an entry has to point at the
 * right car: a table of zeros named every car after the first.
 */
function standings(
  carIds: readonly number[],
  laps: ReadonlyMap<number, readonly { at: number; lapMs: number }[]>,
): Buffer {
  const index = new Map(carIds.map((id, i) => [id, i]))
  const state = new Map(carIds.map((id) => [id, { laps: 0, totalMs: 0 }]))
  const snapshot = (): Buffer[] =>
    [...carIds]
      .sort((a, b) => {
        const x = state.get(a)!
        const y = state.get(b)!
        return y.laps - x.laps || (x.laps > 0 ? x.totalMs - y.totalMs : 0)
      })
      .map((id) => {
        const row = Buffer.alloc(20)
        row.writeUInt32LE(index.get(id)!, 0)
        row.writeFloatLE(-1, 4)
        row.writeUInt32LE(1, 8)
        row.writeUInt32LE(state.get(id)!.laps, 12)
        row.writeFloatLE(state.get(id)!.totalMs, 16)
        return row
      })
  const completions = carIds
    .flatMap((id) => (laps.get(id) ?? []).map((l) => ({ id, ...l })))
    .sort((a, b) => a.at - b.at)
  const groups: Buffer[][] = [snapshot()]
  let leaderLaps = 0
  for (const c of completions) {
    const st = state.get(c.id)!
    st.laps++
    st.totalMs += c.lapMs
    if (st.laps > leaderLaps) {
      leaderLaps = st.laps
      groups.push(snapshot())
    }
  }
  return Buffer.concat([u32(groups.length), ...groups.flat()])
}

/** IEEE 754 binary16, round to nearest with ties away from zero, saturating to ±65504. */
export function writeHalf(b: Buffer, value: number, offset: number): void {
  b.writeUInt16LE(toHalfBits(value), offset)
}

export function toHalfBits(value: number): number {
  if (Number.isNaN(value)) return 0x7e00
  const sign = value < 0 || Object.is(value, -0) ? 0x8000 : 0
  const v = Math.min(Math.abs(value), 65504)
  if (v < 2 ** -24 / 2) return sign
  if (v < 2 ** -14) return sign | Math.round(v / 2 ** -24)
  let exp = Math.floor(Math.log2(v))
  let mant = Math.round((v / 2 ** exp - 1) * 1024)
  if (mant === 1024) {
    exp++
    mant = 0
  }
  return sign | ((exp + 15) << 10) | mant
}

function u32(v: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(v)
  return b
}

function f64(v: number): Buffer {
  const b = Buffer.alloc(8)
  b.writeDoubleLE(v)
  return b
}

function lstring(s: string): Buffer {
  const body = Buffer.from(s, "utf8")
  return Buffer.concat([u32(body.length), body])
}
