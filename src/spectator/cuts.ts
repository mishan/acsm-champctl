/**
 * Track skips: a car that leaves the track and comes back on further round,
 * having covered that stretch faster than it does on the track.
 *
 * Measured against the driver's own laps, not a reference: their usual time
 * from where they left the track to where they came back, on every other pass
 * they made through that stretch on it. A car that runs wide and loses time
 * isn't one; one that gains seconds across the grass is. The server's own cut
 * count says a lap had a cut, not where or what it was worth.
 */

import { readJournal } from "./journal.js"
import type { Track } from "./track.js"

export interface TrackSkip {
  carId: number
  driver: string
  /** Seconds into the session, as the replay shows them. */
  offS: number
  backS: number
  /** Where along the lap the car left the track and came back on, meters. */
  offAt: number
  backAt: number
  skippedM: number
  tookS: number
  /** The middle of the driver's times over the same stretch on the track. */
  usualS: number
  /** How many on-track passes `usualS` is the middle of. */
  passes: number
  /** The passes are other drivers': this one never drove that stretch on the track. */
  field?: true
  savedS: number
}

interface Sample {
  at: number
  s: number
  off: number
  /** The car jumped here, faster than any car drives: a reset, not a lap. */
  jump: boolean
}

/** Beyond the edge by more than this, the car's center is off the track, not on a kerb. */
const OFF_M = 1
/** And it's back once it's within this of the edge. */
const BACK_M = 0.3
/** Further than this from the line and the projection has lost the car: a reset, the pits. */
const LOST_M = 20
/** Off for longer than this is a car stopped or in the pits, not a skip. */
const LONGEST_MS = 60_000
/** Fewer meters of track than this skipped is a kerb taken wide. */
const SHORTEST_M = 30
/** An on-track pass through the stretch slower than this is a car that stopped. */
const SLOWEST_PASS_MS = 120_000
/**
 * Further than this between two samples, and faster than JUMP_PER_MS, is a car
 * put somewhere, not driven there. A floor as well as a speed because samples
 * arrive in bunches a few ms apart, and a reset moves a car hundreds of meters.
 */
const JUMP_M = 30
const JUMP_PER_MS = 100 / 1000

export async function findTrackSkips(
  journal: string,
  track: Track,
  minSavedS = 1,
): Promise<TrackSkip[]> {
  const names = new Map<number, string>()
  // By slot and driver: a slot can change hands, and one driver's skip isn't
  // timed against another's laps.
  const samples = new Map<string, { carId: number; driver: string; list: Sample[] }>()
  const hints = new Map<number, number>()
  const last = new Map<number, { at: number; x: number; z: number }>()
  let start = 0
  let recorder = -1
  for await (const r of readJournal(journal)) {
    if (r.t === "session") {
      start = r.at
      recorder = r.recorderCarId
    } else if (r.t === "car" && r.driver) names.set(r.carId, r.driver)
    else if (r.t === "pos" && r.car.carId !== recorder) {
      const id = r.car.carId
      const [x, , z] = r.car.pos
      const prev = last.get(id)
      last.set(id, { at: r.at, x, z })
      const jump =
        prev !== undefined &&
        Math.hypot(x - prev.x, z - prev.z) > Math.max(JUMP_M, JUMP_PER_MS * (r.at - prev.at))
      // The hint keeps a car on its own stretch where the circuit runs close to
      // itself. After a jump, or far from the line, the car is somewhere else.
      let p = track.project(r.car.pos, jump ? undefined : hints.get(id))
      if (p.offTrack > LOST_M) p = track.project(r.car.pos)
      hints.set(id, p.index)
      const driver = names.get(id) ?? `car ${id}`
      const key = `${id}#${driver}`
      const entry = samples.get(key) ?? { carId: id, driver, list: [] }
      entry.list.push({ at: r.at, s: p.s, off: p.offTrack, jump })
      samples.set(key, entry)
    }
  }

  const skips: TrackSkip[] = []
  for (const { carId, driver, list } of samples.values()) {
    for (let i = 0; i < list.length; i++) {
      if (list[i]!.off <= OFF_M) continue
      let a = i
      while (a > 0 && list[a - 1]!.off > BACK_M) a--
      let b = i
      while (b < list.length - 1 && list[b]!.off > BACK_M) b++
      i = b
      // Off from the start of the recording: no telling where it left the track.
      if (a === 0) continue
      const out = list[a - 1]!
      const back = list[b]!
      // Still off when the recording ends, or put back rather than driven back.
      if (back.off > BACK_M || list.slice(a, b + 1).some((p) => p.jump)) continue
      const tookMs = back.at - out.at
      const skippedM = track.gap(out.s, back.s)
      if (tookMs > LONGEST_MS || skippedM < SHORTEST_M) continue
      let passes = onTrackPasses(list, track, out.s, back.s, [out.at, back.at])
      // Cutting it every lap leaves nothing of their own to compare with.
      const field = passes.length === 0
      if (field) {
        passes = [...samples.values()]
          .filter((e) => e.list !== list)
          .flatMap((e) => onTrackPasses(e.list, track, out.s, back.s, [1, 0]))
      }
      if (passes.length === 0) continue
      // The lower middle of an even count: the slower one could be a lap from
      // the grid or the one after the flag.
      const usualMs = passes.sort((x, y) => x - y)[(passes.length - 1) >> 1]!
      const savedS = (usualMs - tookMs) / 1000
      if (savedS < minSavedS) continue
      skips.push({
        carId,
        driver,
        offS: (out.at - start) / 1000,
        backS: (back.at - start) / 1000,
        offAt: out.s,
        backAt: back.s,
        skippedM,
        tookS: tookMs / 1000,
        usualS: usualMs / 1000,
        passes: passes.length,
        ...(field ? { field } : {}),
        savedS,
      })
    }
  }
  return skips.sort((x, y) => x.offS - y.offS)
}

/** The car's times from s0 to s1 on each pass it made through that stretch on the track. */
function onTrackPasses(
  list: readonly Sample[],
  track: Track,
  s0: number,
  s1: number,
  skip: [number, number],
): number[] {
  const length = track.gap(s0, s1)
  const into = (p: Sample): number => track.gap(s0, p.s)
  const out: number[] = []
  for (let i = 1; i < list.length; i++) {
    const p = list[i]!
    if (p.at >= skip[0] && p.at <= skip[1]) continue
    // Crossing s0 going forward.
    if (!(into(list[i - 1]!) < 0 && into(p) >= 0 && into(p) < length)) continue
    let j = i
    while (
      j < list.length &&
      into(list[j]!) >= 0 &&
      into(list[j]!) < length &&
      list[j]!.off <= BACK_M &&
      !list[j]!.jump
    )
      j++
    const end = list[j]
    if (
      end &&
      !end.jump &&
      into(end) >= length &&
      end.off <= BACK_M &&
      end.at - p.at < SLOWEST_PASS_MS
    )
      out.push(end.at - p.at)
  }
  return out
}
