/**
 * One round's lap count proposal, start to finish: the window, the practice,
 * the count, and what gridmom makes of the championship with it set. Shared by
 * `gridmom laps` and the bot, so it reads and never writes; nothing here may
 * import the write path, which the bot's import-graph test will hold it to
 * once the bot uses it.
 */

import type { Championship } from "../acsm/types.js"
import { events, trackLabel } from "../acsm/view.js"
import { applyFormat, readFormat } from "../finalize/format.js"
import type { CheckReport, Finding } from "../gridmom/finding.js"
import { check } from "../gridmom/index.js"
import type { PitTable } from "../pits/table.js"
import type { LeagueProfile } from "../profile/types.js"
import { practiceSessions, type ResultsReader } from "./practice.js"
import { type Proposal, practiceWindow, proposeLaps, raceMinutes, roundCars } from "./propose.js"

export interface RoundLaps {
  /** 1-based. */
  round: number
  label: string
  eventId: string
  window: { since?: Date; until: Date }
  /** The round's laps now; 0 while it is timed. */
  currentLaps: number
  /** The round's minutes now; 0 once laps are set. */
  currentMinutes: number
  proposal: Proposal
  /** The championship with the proposed count set. Absent when there is nothing to propose. */
  gridmom?: CheckReport
}

export interface RoundLapsOptions {
  /** Instead of the round's own minutes or the league's. */
  minutes?: number
  pits?: PitTable
  now?: Date
  /** Finding codes the league doesn't want, as for `gridmom check`. */
  suppress?: string[]
}

export async function lapsForRound(
  reader: ResultsReader,
  c: Championship,
  championshipId: string,
  round: number,
  profile: LeagueProfile,
  options: RoundLapsOptions = {},
): Promise<RoundLaps> {
  const all = events(c)
  const ev = all[round - 1]
  if (!ev) throw new Error(`The championship has no round ${round}; it has ${all.length}.`)

  const minutes = options.minutes ?? raceMinutes(ev, profile.lapCount?.raceMinutes ?? 0)
  if (minutes <= 0) {
    throw new Error(
      `Round ${round} is set in laps, so it doesn't say how long a race is: ` +
        "set lapCount.raceMinutes in the profile, or give the minutes.",
    )
  }
  const rs = ev.RaceSetup ?? {}
  // Without one, no practice file matches and the week reads as empty.
  if (!rs.Track) throw new Error(`Round ${round} has no track, so there is no practice to read.`)

  const window = practiceWindow(c, round - 1)
  const sessions = await practiceSessions(reader, {
    championshipId,
    track: rs.Track,
    layout: rs.TrackLayout ?? "",
    ...window,
  })
  const proposal = proposeLaps(sessions, {
    cars: roundCars(c, ev, profile.excludedCarModels ?? []),
    minutes,
  })
  const current = readFormat(ev)

  const out: RoundLaps = {
    round,
    label: trackLabel(rs),
    eventId: ev.ID ?? "",
    window,
    currentLaps: current.length.kind === "laps" ? current.length.laps : 0,
    currentMinutes: current.length.kind === "minutes" ? current.length.minutes : 0,
    proposal,
  }
  if (proposal.kind === "laps") {
    const list = [...all]
    list[round - 1] = applyFormat(ev, {
      ...current,
      length: { kind: "laps", laps: proposal.laps },
    })
    out.gridmom = check({ ...c, Events: list }, profile, {
      ...(options.pits ? { pits: options.pits } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.suppress ? { suppress: options.suppress } : {}),
    })
  }
  return out
}

/**
 * gridmom's warnings and errors that bear on this round: its own, its
 * track's and the championship's. Other rounds' are no reason to doubt this
 * round's count, and listed in full they bury the ones that are, so they are
 * only counted. A track's findings come once per track, on its first round, so
 * a round revisiting a track is matched by the track instead.
 */
export function roundFindings(r: RoundLaps): { here: Finding[]; elsewhere: number } {
  const serious = r.gridmom?.findings.filter((f) => f.severity !== "INFO") ?? []
  const here = serious.filter(
    (f) =>
      f.location?.round === undefined ||
      f.location.round === r.round ||
      f.data?.["track"] === r.label,
  )
  return { here, elsewhere: serious.length - here.length }
}
