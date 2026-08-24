/**
 * Race format checks (plan §6.3).
 *
 * The pit window pair is really one check asked twice: does `RacePitWindowStart`
 * agree with the declared format? BATL sets it to 1 for a mandatory stop and 0
 * otherwise, so a 1x40 with the window at 0 is a 1x40 quietly running without
 * its stop — the likeliest way this goes wrong.
 */

import type { ChampionshipEvent } from "../../acsm/types.js"
import { eventHasStarted, eventLabel, events, session } from "../../acsm/view.js"
import type { Check } from "../context.js"
import { pluralize } from "../finding.js"

/**
 * Whether the event is meant to have a mandatory stop.
 *
 * There is no such flag in ACSM — the intent is inferred. A single long race
 * is BATL's mandatory-pit format (1x40); a two-part race with a reversed grid
 * is not (2x20). This is a heuristic and only ever produces a WARN.
 */
function looksLikeMandatoryPitFormat(ev: ChampionshipEvent): boolean | undefined {
  const race = session(ev, "Race")
  if (!race) return undefined
  const reversed = ev.RaceSetup?.ReversedGridRacePositions ?? 0
  if (reversed > 0) return false
  const laps = race.Laps ?? 0
  const minutes = race.Time ?? 0
  if (laps === 0 && minutes === 0) return undefined
  // A long single race is the case where a stop is the point.
  return laps >= 30 || minutes >= 35
}

export const raceLengthAmbiguous: Check = {
  id: "format.race-length",
  section: "6.3",
  run(ctx, emit) {
    events(ctx.championship).forEach((ev, i) => {
      const race = session(ev, "Race")
      if (!race) return
      const laps = race.Laps ?? 0
      const minutes = race.Time ?? 0
      const label = eventLabel(ev, i + 1)
      const loc = { round: i + 1, event: label, path: `Events[${i}].RaceSetup.Sessions.Race` }

      if (laps > 0 && minutes > 0) {
        emit(
          "ERROR",
          "format.race-length-both",
          `${cap(label)} is set to both ${laps} ${pluralize(laps, "lap")} and ${minutes} minutes; it needs to be one or the other.`,
          loc,
          { laps, minutes },
        )
        return
      }
      if (laps === 0 && minutes === 0) {
        emit(
          "ERROR",
          "format.race-length-missing",
          `Nobody set the race length for ${label}.`,
          loc,
          { laps, minutes },
        )
      }
    })
  },
}

export const pitWindowDisagreesWithFormat: Check = {
  id: "format.pit-window",
  section: "6.3",
  run(ctx, emit) {
    events(ctx.championship).forEach((ev, i) => {
      if (eventHasStarted(ev)) return
      const intent = looksLikeMandatoryPitFormat(ev)
      if (intent === undefined) return

      const windowStart = ev.RaceSetup?.RacePitWindowStart ?? 0
      const label = eventLabel(ev, i + 1)
      const loc = { round: i + 1, event: label, path: `Events[${i}].RaceSetup.RacePitWindowStart` }
      const race = session(ev, "Race")
      const lengthText = describeLength(race?.Laps ?? 0, race?.Time ?? 0)

      if (intent && windowStart === 0) {
        emit(
          "WARN",
          "format.pit-window-missing",
          `${cap(label)} is a ${lengthText} single race but the pit window never opens, so there's no mandatory stop.`,
          loc,
          { windowStart, laps: race?.Laps ?? 0, minutes: race?.Time ?? 0 },
        )
      } else if (!intent && windowStart > 0) {
        const reversed = ev.RaceSetup?.ReversedGridRacePositions ?? 0
        const why = reversed > 0 ? `a two-part race with a reversed grid` : `a short race`
        emit(
          "WARN",
          "format.pit-window-unexpected",
          `${cap(label)} has a pit window opening at lap ${windowStart}, which is unusual for ${why}.`,
          loc,
          { windowStart, reversedGridRacePositions: reversed },
        )
      }
    })
  },
}

function describeLength(laps: number, minutes: number): string {
  if (laps > 0) return `${laps} lap`
  if (minutes > 0) return `${minutes} minute`
  return "long"
}

export const reversedGridWithoutMultiplier: Check = {
  id: "format.reversed-grid-multiplier",
  section: "6.3",
  run(ctx, emit) {
    events(ctx.championship).forEach((ev, i) => {
      const reversed = ev.RaceSetup?.ReversedGridRacePositions ?? 0
      if (reversed === 0) return
      const multiplier =
        ev.RaceSetup?.SecondRaceMultiplier ??
        ctx.championship.Classes?.[0]?.Points?.SecondRaceMultiplier ??
        0
      if (multiplier !== 0) return

      const label = eventLabel(ev, i + 1)
      emit(
        "WARN",
        "format.reversed-grid-multiplier",
        `${cap(label)} runs a second race with a reversed grid, but the second race is worth no points.`,
        { round: i + 1, event: label, path: `Events[${i}].RaceSetup.SecondRaceMultiplier` },
        { reversedGridRacePositions: reversed, secondRaceMultiplier: multiplier },
      )
    })
  },
}

/** Baseline drift. Never blocking — this league votes on everything. */
export const differsFromBaseline: Check = {
  id: "format.baseline",
  section: "6.3",
  run(ctx, emit) {
    const baseline = ctx.profile.baseline.raceSetup
    if (!baseline) return

    events(ctx.championship).forEach((ev, i) => {
      const rs = ev.RaceSetup
      if (!rs) return
      const label = eventLabel(ev, i + 1)

      for (const [key, expected] of Object.entries(baseline)) {
        const actual = (rs as Record<string, unknown>)[key]
        if (actual === undefined) continue
        if (Object.is(actual, expected)) continue
        emit(
          "INFO",
          "format.baseline",
          `${cap(label)} has ${key} set to ${format(actual)} rather than the league's usual ${format(expected)}.`,
          { round: i + 1, event: label, path: `Events[${i}].RaceSetup.${key}` },
          { field: key, actual, expected },
        )
      }

      const quali = session(ev, "Qualifying")
      const expectedQuali = ctx.profile.schedule.qualiMinutes
      const actualQuali = quali?.Time ?? 0
      if (actualQuali > 0 && expectedQuali > 0 && actualQuali !== expectedQuali) {
        emit(
          "INFO",
          "format.quali-length",
          `${cap(label)} has a ${actualQuali} minute quali rather than the usual ${expectedQuali}.`,
          { round: i + 1, event: label, path: `Events[${i}].RaceSetup.Sessions.Qualifying.Time` },
          { actual: actualQuali, expected: expectedQuali },
        )
      }
    })
  },
}

function format(v: unknown): string {
  if (typeof v === "boolean") return v ? "on" : "off"
  return String(v)
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export const formatChecks: readonly Check[] = [
  raceLengthAmbiguous,
  pitWindowDisagreesWithFormat,
  reversedGridWithoutMultiplier,
  differsFromBaseline,
]
