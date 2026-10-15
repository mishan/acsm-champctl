/**
 * A car lapping the synthetic loop at a steady 40 m/s, three times, with one
 * lap changed: through T1 it either drives the straight line across the
 * corner, off the track and quicker, or runs wide around it and slower.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { findTrackSkips } from "../src/spectator/cuts.js"
import { JournalWriter, type JournalRecord } from "../src/spectator/journal.js"
import type { CarState, Vec3 } from "../src/spectator/protocol.js"
import { parseFastLane, Track } from "../src/spectator/track.js"
import { fastLane, loop } from "./support/synthetic-track.js"

const track = new Track(parseFastLane(fastLane(loop("left"))))
const SPEED = 40
let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cuts-"))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const at = (s: number, across = 0): Vec3 => {
  const p = track.pointAt(s)
  const [lx, lz] = [(p.leftEdge[0] - p.rightEdge[0]) / 12, (p.leftEdge[1] - p.rightEdge[1]) / 12]
  return [p.x + lx * across, 0, p.z + lz * across]
}
const state = (timestamp: number, pos: Vec3): CarState => ({
  carId: 1,
  seq: 0,
  timestamp,
  ping: 0,
  pos,
  rot: [0, 0, 0],
  vel: [SPEED, 0, 0],
  steer: 0,
  rpm: 5000,
  gear: 4,
  statusFlags: 0,
})

/**
 * Positions every 50 ms. On lap 2, between `from` and `to` along the lap, the
 * car follows `detour` instead, a path of points it covers at the same speed.
 */
async function laps(name: string, from: number, to: number, detour: Vec3[]): Promise<string> {
  const records: JournalRecord[] = [
    {
      t: "session",
      at: 0,
      serverName: "s",
      track: "loop",
      trackConfig: "",
      name: "Race",
      type: 3,
      recorderCarId: 0,
    },
    { t: "car", at: 0, carId: 1, model: "m", skin: "s", driver: "Cutter" },
  ]
  let t = 0
  const put = (pos: Vec3) => {
    records.push({ t: "pos", at: t, car: state(t, pos) })
    t += 50
  }
  const step = (SPEED * 50) / 1000
  for (let lap = 0; lap < 3; lap++) {
    for (let s = 0; s < track.length; s += step) {
      if (lap === 1 && s >= from && s < to) continue
      if (lap === 1 && s >= to && s - step < to) {
        // The detour, walked point to point at the same speed.
        for (let k = 1; k < detour.length; k++) {
          const [a, b] = [detour[k - 1]!, detour[k]!]
          const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[2] - a[2]) / step))
          for (let i = 0; i < n; i++)
            put([a[0] + ((b[0] - a[0]) * i) / n, 0, a[2] + ((b[2] - a[2]) * i) / n])
        }
      }
      put(at(s))
    }
  }
  const w = new JournalWriter(join(dir, `${name}.ndjson.gz`))
  for (const r of records) w.write(r)
  await w.close()
  return w.path
}

const t1 = track.corners[0]!

describe("findTrackSkips", () => {
  it("finds a straight line across a corner, and what it gained", async () => {
    // From 20 m before T1's entry to 20 m past its exit, straight across.
    const [from, to] = [t1.entry - 20, t1.exit + 20]
    const path = await laps("chord", from, to, [at(from), at(to)])
    // A small corner: the chord saves about 0.6 s, under the default second.
    const [skip, ...rest] = await findTrackSkips(path, track, 0.2)
    expect(rest).toEqual([])
    const arc = track.gap(from, to)
    expect(skip).toMatchObject({ driver: "Cutter", passes: 2 })
    expect(skip!.skippedM).toBeGreaterThan(arc - 20)
    // The corner at 40 m/s against the chord at 40 m/s.
    const chord = Math.hypot(at(to)[0] - at(from)[0], at(to)[2] - at(from)[2])
    expect(skip!.savedS).toBeCloseTo((arc - chord) / SPEED, 0)
  })

  it("doesn't count running wide, which loses time", async () => {
    // 4 m beyond the right edge, the outside of a left-hander, all the way round.
    const [from, to] = [t1.entry, t1.exit]
    const wide: Vec3[] = []
    for (let s = from; s <= to; s += 2) wide.push(at(s, -10))
    const path = await laps("wide", from, to, [at(from), ...wide, at(to)])
    expect(await findTrackSkips(path, track, 0.2)).toEqual([])
  })
})
