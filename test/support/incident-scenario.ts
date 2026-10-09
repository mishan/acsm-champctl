/**
 * Journals for incident tests, written from functions of time: where each car
 * is along the lap and across the track, and when its brake lights are on.
 */

import { join } from "node:path"

import { JournalWriter, type JournalRecord } from "../../src/spectator/journal.js"
import { BRAKE_LIGHTS } from "../../src/spectator/protocol.js"
import type { Track } from "../../src/spectator/track.js"

export interface ScriptedCar {
  carId: number
  driver: string
  /** Meters along the lap at t ms. */
  s(t: number): number
  /** Meters from the middle of the track at t ms, positive left. */
  across(t: number): number
  braking?(t: number): boolean
  /** Sample times to leave out, as [from, to) ms. */
  gap?: [number, number]
}

/** Where a car at (s, across) is in the world, using the track's own edges. */
export function place(track: Track, s: number, across: number): [number, number, number] {
  const p = track.pointAt(s)
  const mid: [number, number] = [
    (p.leftEdge[0] + p.rightEdge[0]) / 2,
    (p.leftEdge[1] + p.rightEdge[1]) / 2,
  ]
  const w = Math.hypot(p.leftEdge[0] - p.rightEdge[0], p.leftEdge[1] - p.rightEdge[1]) || 1
  const [lx, lz] = [(p.leftEdge[0] - p.rightEdge[0]) / w, (p.leftEdge[1] - p.rightEdge[1]) / w]
  return [mid[0] + lx * across, 0, mid[1] + lz * across]
}

export async function writeScenario(
  dir: string,
  name: string,
  track: Track,
  cars: readonly ScriptedCar[],
  collision: { at: number; carId: number; otherCarId: number },
  durationMs = 12_000,
): Promise<string> {
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
    ...cars.map(
      (c): JournalRecord => ({
        t: "car",
        at: 0,
        carId: c.carId,
        model: "m",
        skin: "s",
        driver: c.driver,
      }),
    ),
  ]
  for (let t = 0; t <= durationMs; t += 55) {
    for (const c of cars) {
      if (c.gap && t >= c.gap[0] && t < c.gap[1]) continue
      const pos = place(track, c.s(t), c.across(t))
      const ahead = place(track, c.s(t) + 1, c.across(t + 30))
      const [dx, dz] = [ahead[0] - pos[0], ahead[2] - pos[2]]
      const speed = (c.s(t + 100) - c.s(t)) * 10
      const len = Math.hypot(dx, dz) || 1
      records.push({
        t: "pos",
        at: t,
        car: {
          carId: c.carId,
          seq: 0,
          timestamp: t,
          ping: 0,
          pos,
          rot: [Math.atan2(-dx, dz), 0, 0],
          vel: [(dx / len) * speed, 0, (dz / len) * speed],
          steer: 0,
          rpm: 5000,
          gear: 4,
          statusFlags: c.braking?.(t) ? BRAKE_LIGHTS : 0,
          gas: c.braking?.(t) ? 0 : 1,
        },
      })
    }
  }
  records.push({
    t: "collision",
    ...collision,
    impactSpeed: 4,
    worldPos: [0, 0, 0],
    relPos: [0.7, 0, 0.8],
  })
  const w = new JournalWriter(join(dir, `${name}.ndjson.gz`))
  for (const r of records.sort((a, b) => a.at - b.at)) w.write(r)
  await w.close()
  return w.path
}
