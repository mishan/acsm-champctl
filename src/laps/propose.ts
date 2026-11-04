/**
 * The race's lap count from the week's practice: race minutes over the fastest
 * valid lap, rounded half up. The league's own rule, so no trimming of fast
 * outliers and no allowance for a pit stop.
 */

import type { Championship, ChampionshipEvent, SessionResults } from "../acsm/types.js"
import { availableCars, events, isZeroTime, raceSetupCars } from "../acsm/view.js"
import { readFormat } from "../finalize/format.js"

export type Proposal =
  | {
      kind: "laps"
      laps: number
      minutes: number
      best: { lapMs: number; driver: string; car: string; sessionFile: string }
      sessions: number
      validLaps: number
      drivers: number
    }
  | { kind: "none"; reason: string }

export function proposeLaps(
  sessions: readonly SessionResults[],
  { cars, minutes }: { cars: ReadonlySet<string>; minutes: number },
): Proposal {
  let best: (Proposal & { kind: "laps" })["best"] | undefined
  let validLaps = 0
  const drivers = new Set<string>()
  for (const s of sessions) {
    for (const lap of s.Laps ?? []) {
      const ms = lap.LapTime ?? 0
      if (ms <= 0 || (lap.Cuts ?? 0) !== 0 || !cars.has(lap.CarModel ?? "")) continue
      validLaps++
      drivers.add(lap.DriverGuid ?? lap.DriverName ?? "")
      if (!best || ms < best.lapMs) {
        best = {
          lapMs: ms,
          driver: lap.DriverName ?? "",
          car: lap.CarModel ?? "",
          sessionFile: s.SessionFile ?? "",
        }
      }
    }
  }
  if (!best) {
    return {
      kind: "none",
      reason:
        sessions.length === 0
          ? "nobody has run this round's practice yet"
          : `none of the ${sessions.length} practice sessions has a clean lap in the round's cars`,
    }
  }
  const laps = Math.round((minutes * 60_000) / best.lapMs)
  return {
    kind: "laps",
    laps,
    minutes,
    best,
    sessions: sessions.length,
    validLaps,
    drivers: drivers.size,
  }
}

/**
 * Minutes per race: the round's own while it is still timed, which is what the
 * 1x40 and 2x20 presets write; the league's once laps have replaced them.
 */
export function raceMinutes(ev: ChampionshipEvent, leagueMinutes: number): number {
  const { length } = readFormat(ev)
  return length.kind === "minutes" && length.minutes > 0 ? length.minutes : leagueMinutes
}

/** Models whose laps count: the round's cars, less the league's always-present ones. */
export function roundCars(
  c: Championship,
  ev: ChampionshipEvent,
  excluded: readonly string[],
): Set<string> {
  const named = raceSetupCars(ev.RaceSetup)
  const cars = new Set(named.length > 0 ? named : availableCars(c))
  for (const m of excluded) cars.delete(m)
  return cars
}

/**
 * From the end of the previous round to this one's practice start. A first
 * round has no previous round in its championship, so its start is left to the
 * results list.
 */
export function practiceWindow(c: Championship, round: number): { since?: Date; until: Date } {
  const all = events(c)
  const ev = all[round]
  const until = new Date(ev?.Scheduled && !isZeroTime(ev.Scheduled) ? ev.Scheduled : Number.NaN)
  if (Number.isNaN(until.getTime())) {
    throw new Error(`Round ${round + 1} has no practice start, so there is no week to read.`)
  }
  const previous = all[round - 1]?.CompletedTime
  return previous && !isZeroTime(previous) ? { since: new Date(previous), until } : { until }
}
