/**
 * The replay is read back by offset from the published format table, not by
 * anything the writer exports, so a layout mistake shows up as a wrong value.
 * Whether the game accepts these files is a separate question these tests
 * cannot answer; see the header of src/spectator/acreplay.ts.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { toHalfBits, writeReplay } from "../src/spectator/acreplay.js"
import { JournalWriter, type JournalRecord } from "../src/spectator/journal.js"
import type { CarState, Vec3 } from "../src/spectator/protocol.js"

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "acreplay-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("toHalfBits", () => {
  it.each([
    [1, 0x3c00],
    [-2, 0xc000],
    [0.5, 0x3800],
    [Math.PI, 0x4248],
    [65504, 0x7bff],
    [1e6, 0x7bff],
    [2 ** -24, 0x0001],
    [0, 0x0000],
  ])("%s", (value, bits) => {
    expect(toHalfBits(value)).toBe(bits)
  })
})

const half = (b: Buffer, at: number): number => {
  const h = b.readUInt16LE(at)
  const exp = (h >> 10) & 0x1f
  const mant = h & 0x3ff
  const v = exp === 0 ? mant * 2 ** -24 : (1 + mant / 1024) * 2 ** (exp - 15)
  return h & 0x8000 ? -v : v
}

/** Minimal reader for the parts these tests look at. */
function parse(b: Buffer) {
  let o = 0
  const u32 = (): number => {
    o += 4
    return b.readUInt32LE(o - 4)
  }
  const str = (): string => {
    const n = u32()
    o += n
    return b.subarray(o - n, o).toString("utf8")
  }
  const version = u32()
  const interval = b.readDoubleLE(o)
  o += 8
  const weather = str()
  const track = str()
  const config = str()
  const cars = u32()
  u32()
  const frames = u32()
  const objects = u32()
  o += frames * (4 + 12 * objects)
  const out = []
  for (let c = 0; c < cars; c++) {
    const model = str()
    const driver = str()
    str()
    str()
    const skin = str()
    const n = u32()
    const wings = u32()
    const f = []
    for (let i = 0; i < n; i++) {
      if (i > 0) o += wings * 4
      const at = o + 20
      f.push({
        at,
        pos: [b.readFloatLE(at), b.readFloatLE(at + 4), b.readFloatLE(at + 8)],
        yaw: half(b, at + 12),
        wheelSpin: half(b, at + 172),
        rpm: half(b, at + 170),
        currentLapMs: b.readUInt32LE(at + 220),
        lastLapMs: b.readUInt32LE(at + 224),
        gear: b.readUInt8(at + 234),
        gas: b.readUInt8(at + 244),
        brake: b.readUInt8(at + 245),
        lap: b.readUInt8(at + 246),
        last: b.readUInt8(at + 255),
      })
      o += 276
    }
    o += wings * 4
    o += 4 + u32() * 8
    out.push({ model, driver, skin, frames: f })
  }
  const groups = u32()
  o += groups * cars * 20
  return { version, interval, weather, track, config, frames, cars: out, trailing: b.length - o }
}

const state = (carId: number, timestamp: number, over: Partial<CarState> = {}): CarState => ({
  carId,
  seq: 0,
  timestamp,
  ping: 0,
  pos: [0, 0, 0],
  rot: [0, 0, 0],
  vel: [0, 0, 0],
  steer: 0,
  rpm: 3000,
  gear: 3,
  statusFlags: 0,
  gas: 0.5,
  ...over,
})

async function journal(records: JournalRecord[]): Promise<string> {
  const w = new JournalWriter(join(dir, "s.ndjson.gz"))
  for (const r of records) w.write(r)
  await w.close()
  return w.path
}

const session: JournalRecord = {
  t: "session",
  at: 0,
  serverName: "test",
  track: "imola",
  trackConfig: "",
  name: "Race",
  type: 3,
  recorderCarId: 0,
}

describe("writeReplay", () => {
  it("writes every car but the recorder, on one frame grid, ending where the game expects", async () => {
    const path = await journal([
      session,
      { t: "car", at: 0, carId: 1, model: "ks_mazda_mx5_cup", skin: "red", driver: "Ana" },
      { t: "car", at: 0, carId: 2, model: "ks_mazda_mx5_cup", skin: "blue", driver: "Bo" },
      { t: "pos", at: 0, car: state(0, 1000) },
      ...[0, 100, 200, 300].map(
        (dt): JournalRecord => ({ t: "pos", at: dt, car: state(1, 1000 + dt) }),
      ),
      ...[50, 150].map((dt): JournalRecord => ({ t: "pos", at: dt, car: state(2, 1000 + dt) })),
    ])
    const out = join(dir, "s.acreplay")
    await writeReplay(path, out, { intervalMs: 50, weather: "3_clear" })
    const r = parse(await readFile(out))
    expect(r).toMatchObject({
      version: 16,
      interval: 50,
      weather: "3_clear",
      track: "imola",
      frames: 7,
    })
    expect(r.cars.map((c) => [c.model, c.driver, c.skin, c.frames.length])).toEqual([
      ["ks_mazda_mx5_cup", "Ana", "red", 7],
      ["ks_mazda_mx5_cup", "Bo", "blue", 7],
    ])
    expect(r.cars[0]!.frames.every((f) => f.last === 1)).toBe(true)
    expect(r.trailing).toBe(0)
  })

  it("interpolates position between samples and turns yaw the short way across ±π", async () => {
    const path = await journal([
      session,
      { t: "pos", at: 0, car: state(1, 0, { pos: [0, 0, 0], rot: [3.0, 0, 0] }) },
      { t: "pos", at: 100, car: state(1, 100, { pos: [10, 0, 20], rot: [-3.0, 0, 0] }) },
    ])
    const out = join(dir, "s.acreplay")
    await writeReplay(path, out, { intervalMs: 50 })
    const [a, mid, b] = parse(await readFile(out)).cars[0]!.frames
    expect(mid!.pos).toEqual([5, 0, 10])
    // Halfway from 3.0 to -3.0 the short way is π, not 0.
    expect(Math.abs(mid!.yaw)).toBeCloseTo(Math.PI, 2)
    expect([a!.yaw, b!.yaw].map((y) => Number(y.toFixed(2)))).toEqual([3, -3])
  })

  // A recorder up for 49.7 days has a clock past 2^32 ms; the samples carry
  // it cut to 32 bits.
  it.each([0, 2 ** 32])("carries gear, gas, brake lights and lap timing, %i ms in", async (up) => {
    const path = await journal([
      session,
      { t: "pos", at: up, car: state(1, 0, { gear: 4, gas: 1 }) },
      { t: "pos", at: up + 100, car: state(1, 100, { statusFlags: 0x10, gas: 0 }) },
      { t: "lap", at: up + 100, carId: 1, lapMs: 90_000, cuts: 0 },
      { t: "pos", at: up + 200, car: state(1, 200) },
      { t: "lap", at: up + 200, carId: 1, lapMs: 100, cuts: 0 },
    ])
    const out = join(dir, "s.acreplay")
    await writeReplay(path, out, { intervalMs: 50 })
    const f = parse(await readFile(out)).cars[0]!.frames
    expect([f[0]!.gear, f[0]!.gas, f[0]!.brake]).toEqual([4, 255, 0])
    expect([f[2]!.gas, f[2]!.brake]).toEqual([0, 255])
    expect(f.map((x) => x.lap)).toEqual([0, 0, 1, 1, 2])
    expect(f[3]!.currentLapMs).toBe(50)
    expect(f.map((x) => x.lastLapMs)).toEqual([0, 0, 90_000, 90_000, 100])
  })

  it("holds a car where it was, stopped, across a gap, and shows it only while it's in the game", async () => {
    const moving = { vel: [30, 0, 0] as Vec3 }
    const path = await journal([
      session,
      // Car 1 goes unheard for 5 s but never leaves; car 3 leaves at 0.5 s
      // and is back at 5 s; car 2 joins at 7 s.
      { t: "pos", at: 0, car: state(1, 0, { pos: [0, 0, 0], ...moving }) },
      { t: "pos", at: 0, car: state(3, 0, moving) },
      { t: "connection", at: 500, carId: 3, connected: false },
      { t: "pos", at: 5000, car: state(1, 5000, { pos: [100, 0, 0], ...moving }) },
      { t: "pos", at: 5000, car: state(3, 5000, moving) },
      { t: "pos", at: 7000, car: state(2, 7000) },
    ])
    const out = join(dir, "s.acreplay")
    await writeReplay(path, out, { intervalMs: 1000 })
    const [one, two, three] = parse(await readFile(out)).cars
    const flags = (
      car: typeof one,
      on: (f: NonNullable<typeof one>["frames"][number]) => boolean,
    ) => car!.frames.map((f) => (on(f) ? "x" : ".")).join("")
    expect(one!.frames.map((f) => f.pos[0])).toEqual([0, 0, 0, 0, 0, 100, 100, 100])
    // Moving, spinning and revving only where there's a sample.
    expect(flags(one, (f) => f.wheelSpin > 0)).toBe("x....x..")
    expect(flags(one, (f) => f.rpm > 0)).toBe("x....x..")
    expect(flags(one, (f) => f.last === 1)).toBe("xxxxxxx.")
    expect(flags(three, (f) => f.last === 1)).toBe("x....xx.")
    expect(flags(two, (f) => f.last === 1)).toBe("......xx")
  })

  it("puts samples that arrived out of order back in time order", async () => {
    // A rotation rather than a swap, so a sort that applied the inverse
    // permutation would come out wrong too.
    const path = await journal([
      session,
      ...[0, 300, 100, 200].map(
        (ts, at): JournalRecord => ({ t: "pos", at, car: state(1, ts, { pos: [ts / 10, 0, 0] }) }),
      ),
    ])
    const out = join(dir, "s.acreplay")
    await writeReplay(path, out, { intervalMs: 50 })
    expect(parse(await readFile(out)).cars[0]!.frames.map((f) => f.pos[0])).toEqual([
      0, 5, 10, 15, 20, 25, 30,
    ])
  })

  it("names the car after whoever drove it most when the slot changed hands", async () => {
    const pos = (at: number): JournalRecord => ({ t: "pos", at, car: state(1, at) })
    const path = await journal([
      session,
      { t: "car", at: 0, carId: 1, model: "m", skin: "s", driver: "Ana" },
      ...[0, 50, 100, 150].map(pos),
      { t: "car", at: 200, carId: 1, model: "other", skin: "s", driver: "Bo" },
      pos(200),
      { t: "lap", at: 200, carId: 1, lapMs: 90_000, cuts: 0 },
    ])
    const out = join(dir, "s.acreplay")
    await writeReplay(path, out, { intervalMs: 50 })
    const [car] = parse(await readFile(out)).cars
    // Ana's car, and none of Bo's laps.
    expect([car!.driver, car!.model, car!.frames.at(-1)!.lap]).toEqual(["Ana", "m", 0])
  })

  it("rejects, and leaves the file alone, when the replay already exists", async () => {
    const path = await journal([session, { t: "pos", at: 0, car: state(1, 0) }])
    const out = join(dir, "s.acreplay")
    await writeFile(out, "keep")
    await expect(writeReplay(path, out)).rejects.toThrow(/EEXIST/)
    expect(await readFile(out, "utf8")).toBe("keep")
  })

  it("places the wheels where the game does on a car pitched, rolled and steering", async () => {
    // One frame of a replay the game wrote: a Nissan R32 cornering at
    // Okayama, nose down and leaning, and the wheel centers it stored.
    const pos: [number, number, number] = [89.3013916015625, 21.879091262817383, -65.1578369140625]
    const rot: [number, number, number] = [1.0546875, -0.1015625, -0.062103271484375]
    const stored = [
      [88.8006362915039, 21.66899299621582, -63.96014404296875],
      [87.98043823242188, 21.584306716918945, -65.30681610107422],
      [91.02418518066406, 21.937702178955078, -65.25155639648438],
      [90.28025817871094, 21.87651252746582, -66.57445526123047],
    ]
    const path = await journal([
      session,
      { t: "pos", at: 0, car: state(1, 0, { pos, rot, steer: -120 }) },
      { t: "pos", at: 50, car: state(1, 50, { pos, rot, steer: -120 }) },
    ])
    const out = join(dir, "s.acreplay")
    await writeReplay(path, out, { intervalMs: 50 })
    const b = await readFile(out)
    const frame = parse(b).cars[0]!.frames[0]!.at
    for (let w = 0; w < 4; w++) {
      const got = [0, 1, 2].map((i) => b.readFloatLE(frame + 20 + w * 12 + i * 4))
      // Within suspension travel, which the network doesn't carry.
      expect(Math.hypot(...got.map((v, i) => v - stored[w]![i]!))).toBeLessThan(0.05)
    }
    // Front wheels turned by the steering, at the measured ratio.
    expect(half(b, frame + 68)).toBeCloseTo(rot[0] + ((-120 / 14.4) * Math.PI) / 180, 2)
    expect(half(b, frame + 68 + 12)).toBeCloseTo(rot[0], 2)
  })

  it("lists the running order after the last car, pointing at the right cars", async () => {
    const path = await journal([
      session,
      ...[1, 2, 3].map((carId): JournalRecord => ({ t: "pos", at: 0, car: state(carId, 0) })),
      ...[1, 2, 3].map((carId): JournalRecord => ({ t: "pos", at: 300, car: state(carId, 300) })),
      { t: "lap", at: 100, carId: 3, lapMs: 90_000, cuts: 0 },
      { t: "lap", at: 110, carId: 1, lapMs: 90_500, cuts: 0 },
      { t: "lap", at: 200, carId: 3, lapMs: 89_000, cuts: 0 },
    ])
    const out = join(dir, "s.acreplay")
    await writeReplay(path, out, { intervalMs: 100 })
    const b = await readFile(out)
    // The table is the last thing in the file: u32 group count, then rows.
    const rows = 3
    const count = b.readUInt32LE(b.length - 4 - 20 * rows * 3)
    expect(count).toBe(3)
    const table = (g: number) =>
      [0, 1, 2].map((r) => {
        const at = b.length - 20 * rows * 3 + (g * rows + r) * 20
        return [b.readUInt32LE(at), b.readUInt32LE(at + 12), b.readFloatLE(at + 16)]
      })
    // Cars 1, 2, 3 are replay indices 0, 1, 2. The grid, then after each of
    // the leader's laps, sorted by laps and then time.
    expect(table(0)).toEqual([
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
    ])
    expect(table(1)).toEqual([
      [2, 1, 90_000],
      [0, 0, 0],
      [1, 0, 0],
    ])
    expect(table(2)).toEqual([
      [2, 2, 179_000],
      [0, 1, 90_500],
      [1, 0, 0],
    ])
  })

  it("places each car's wheels from its own data, and says when it couldn't", async () => {
    const cars = join(dir, "cars")
    await mkdir(join(cars, "wide", "data"), { recursive: true })
    await writeFile(
      join(cars, "wide", "data", "suspensions.ini"),
      "[BASIC]\nWHEELBASE=3\nCG_LOCATION=0.5\n[FRONT]\nBASEY=-0.2\nTRACK=2.4\n[REAR]\nBASEY=-0.2\nTRACK=2.4\n",
    )
    const path = await journal([
      session,
      { t: "car", at: 0, carId: 1, model: "wide", skin: "s", driver: "Ana" },
      { t: "car", at: 0, carId: 2, model: "unknown", skin: "s", driver: "Bo" },
      ...[1, 2].map((carId): JournalRecord => ({ t: "pos", at: 0, car: state(carId, 0) })),
      ...[1, 2].map((carId): JournalRecord => ({ t: "pos", at: 50, car: state(carId, 50) })),
    ])
    const out = join(dir, "s.acreplay")
    const summary = await writeReplay(path, out, { intervalMs: 50, carsDir: cars })
    expect(summary.cars.map((c) => [c.model, c.ownWheels])).toEqual([
      ["wide", true],
      ["unknown", false],
    ])
    const b = await readFile(out)
    const fl = (car: number) => {
      const at = parse(b).cars[car]!.frames[0]!.at
      return [0, 1, 2].map((i) => b.readFloatLE(at + 20 + i * 4))
    }
    // Facing +z with no rotation, the car's left is +x.
    expect(fl(0).map((v) => Number(v.toFixed(3)))).toEqual([1.2, -0.2, 1.5])
    expect(fl(1).map((v) => Number(v.toFixed(3)))).toEqual([0.79, -0.15, 1.07])
  })

  it("refuses a journal with nobody moving rather than writing an empty replay", async () => {
    const path = await journal([session, { t: "pos", at: 0, car: state(0, 0) }])
    await expect(writeReplay(path, join(dir, "s.acreplay"))).rejects.toThrow(/no cars moving/)
  })
})
