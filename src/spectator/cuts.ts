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
  savedS: number
}

interface Sample {
  at: number
  s: number
  off: number
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

export async function findTrackSkips(
  journal: string,
  track: Track,
  minSavedS = 1,
): Promise<TrackSkip[]> {
  const names = new Map<number, string>()
  const samples = new Map<number, Sample[]>()
  const hints = new Map<number, number>()
  let start = 0
  let recorder = -1
  for await (const r of readJournal(journal)) {
    if (r.t === "session") {
      start = r.at
      recorder = r.recorderCarId
    } else if (r.t === "car" && r.driver) names.set(r.carId, r.driver)
    else if (r.t === "pos" && r.car.carId !== recorder) {
      const id = r.car.carId
      let p = track.project(r.car.pos, hints.get(id))
      // The hint keeps a car on its own stretch where the circuit runs close to
      // itself, and a car reset to the pits is far from where it last was.
      if (p.offTrack > LOST_M) p = track.project(r.car.pos)
      hints.set(id, p.index)
      const list = samples.get(id) ?? []
      list.push({ at: r.at, s: p.s, off: p.offTrack })
      samples.set(id, list)
    }
  }

  const skips: TrackSkip[] = []
  for (const [carId, list] of samples) {
    for (let i = 0; i < list.length; i++) {
      if (list[i]!.off <= OFF_M) continue
      let a = i
      while (a > 0 && list[a - 1]!.off > BACK_M) a--
      let b = i
      while (b < list.length - 1 && list[b]!.off > BACK_M) b++
      i = b
      const out = list[Math.max(0, a - 1)]!
      const back = list[b]!
      const tookMs = back.at - out.at
      const skippedM = track.gap(out.s, back.s)
      if (tookMs > LONGEST_MS || skippedM < SHORTEST_M) continue
      const passes = onTrackPasses(list, track, out.s, back.s, [out.at, back.at])
      if (passes.length === 0) continue
      const usualMs = passes.sort((x, y) => x - y)[Math.floor(passes.length / 2)]!
      const savedS = (usualMs - tookMs) / 1000
      if (savedS < minSavedS) continue
      skips.push({
        carId,
        driver: names.get(carId) ?? `car ${carId}`,
        offS: (out.at - start) / 1000,
        backS: (back.at - start) / 1000,
        offAt: out.s,
        backAt: back.s,
        skippedM,
        tookS: tookMs / 1000,
        usualS: usualMs / 1000,
        passes: passes.length,
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
      list[j]!.off <= BACK_M
    )
      j++
    const end = list[j]
    if (end && into(end) >= length && end.off <= BACK_M && end.at - p.at < SLOWEST_PASS_MS)
      out.push(end.at - p.at)
  }
  return out
}
