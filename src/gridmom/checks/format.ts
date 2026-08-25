/**
 * Race format checks (plan §6.3).
 *
 * The pit window pair is really one check asked twice: does `RacePitWindowStart`
 * agree with the declared format? BATL sets it to 1 for a mandatory stop and 0
 * otherwise, so a 1x40 with the window at 0 is a 1x40 quietly running without
 * its stop — the likeliest way this goes wrong.
 */

import { SESSION_KEY_ALIASES, type ChampionshipEvent } from "../../acsm/types.js"
import { classes, eventHasStarted, eventLabel, events, session } from "../../acsm/view.js"
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

/**
 * Length as an adjective, for use before a noun: "a 40-lap single race".
 * Hyphenated, because "a 40 lap single race" reads as a typo.
 */
function describeLength(laps: number, minutes: number): string {
  if (laps > 0) return `${laps}-lap`
  if (minutes > 0) return `${minutes}-minute`
  return "long"
}

export const reversedGridWithoutMultiplier: Check = {
  id: "format.reversed-grid-multiplier",
  section: "6.3",
  run(ctx, emit) {
    events(ctx.championship).forEach((ev, i) => {
      const reversed = ev.RaceSetup?.ReversedGridRacePositions ?? 0
      if (reversed === 0) return

      const eventMultiplier = ev.RaceSetup?.SecondRaceMultiplier
      // The event-level value wins when it is set. Otherwise fall back to the
      // classes — but to *all* of them, not just the first: in a multi-class
      // championship one class scoring the second race means the format is
      // doing its job, even if another doesn't.
      const classMultipliers = classes(ctx.championship).map(
        (cls) => cls.Points?.SecondRaceMultiplier ?? 0,
      )
      const multiplier =
        eventMultiplier ?? (classMultipliers.length > 0 ? Math.max(...classMultipliers) : 0)
      if (multiplier !== 0) return

      const label = eventLabel(ev, i + 1)
      // Say which classes when there is more than one, since "the second race
      // is worth no points" is otherwise ambiguous about who it applies to.
      const scope =
        eventMultiplier === undefined && classMultipliers.length > 1
          ? ` for any of the ${classMultipliers.length} classes`
          : ""
      emit(
        "WARN",
        "format.reversed-grid-multiplier",
        `${cap(label)} runs a second race with a reversed grid, but the second race is worth no points${scope}.`,
        { round: i + 1, event: label, path: `Events[${i}].RaceSetup.SecondRaceMultiplier` },
        {
          reversedGridRacePositions: reversed,
          secondRaceMultiplier: multiplier,
          eventMultiplier,
          classMultipliers,
        },
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

/**
 * ACSM keys `RaceSetup.Sessions` by its `SessionType` constants — `PRACTICE`,
 * `QUALIFY`, `RACE`, `BOOK` — and looks them up by exactly those strings.
 *
 * A championship keyed with the friendly spellings survives a round trip
 * looking perfectly healthy: the map is `map[SessionType]SessionConfig` and
 * `SessionType` is a Go string type, so any key unmarshals and comes back out
 * of the export unchanged. But ACSM's own editor finds nothing under the key it
 * looks up, renders the event form with default lengths and every session
 * disabled, and a save then writes that blankness back — the sessions are gone.
 *
 * ERROR rather than WARN because it is not cosmetic and not recoverable by
 * looking: the JSON reads correctly, the UI shows an empty event, and the first
 * person to open and save it loses the configuration. Blocking a push is
 * exactly right for a championship nobody can edit.
 *
 * champctl's own reads accept either spelling (`SESSION_KEY_ALIASES`), which is
 * why this went unnoticed — every internal check agreed with the fixture while
 * ACSM disagreed with both.
 */
export const nonCanonicalSessionKeys: Check = {
  id: "format.session-keys",
  section: "6.3",
  run(ctx, emit) {
    events(ctx.championship).forEach((ev, i) => {
      const sessions = ev.RaceSetup?.Sessions
      if (!sessions) return
      const label = eventLabel(ev, i + 1)

      const wrong = Object.keys(sessions).filter((k) => !CANONICAL_SESSION_KEYS.has(k))
      if (wrong.length === 0) return

      // Listed from the canonical set rather than written out, so a key added
      // there cannot go missing from the advice — which is how BOOK came to be
      // named as valid one sentence and omitted from the suggestion the next.
      const anyOf = `one of ${[...CANONICAL_SESSION_KEYS].join(", ")}`
      const suggestions = wrong.map((k) => `${k} should be ${canonicalise(k) ?? anyOf}`)

      emit(
        "ERROR",
        "format.session-keys",
        `${cap(label)} keys its sessions as ${humanKeys(wrong)}, which ACSM does not read — ` +
          `it expects ${humanKeys([...CANONICAL_SESSION_KEYS])}. The export looks right, but the ` +
          `event opens blank in Server Manager and saving it there wipes the sessions. ` +
          `${suggestions.join("; ")}.`,
        { round: i + 1, event: label, path: `Events[${i}].RaceSetup.Sessions` },
        { keys: wrong },
      )
    })
  },
}

/** What ACSM's `SessionType` constants actually are. */
const CANONICAL_SESSION_KEYS = new Set(["PRACTICE", "QUALIFY", "RACE", "BOOK"])

/** The canonical spelling for a key champctl recognises, if it recognises it. */
function canonicalise(key: string): string | undefined {
  const k = key.trim().toLowerCase()
  for (const [canonical, aliases] of Object.entries(SESSION_KEY_ALIASES)) {
    if (!aliases.includes(k)) continue
    return canonical === "Booking"
      ? "BOOK"
      : canonical === "Qualifying"
        ? "QUALIFY"
        : canonical.toUpperCase()
  }
  return undefined
}

function humanKeys(keys: readonly string[]): string {
  return keys.map((k) => `\`${k}\``).join(", ")
}

export const formatChecks: readonly Check[] = [
  raceLengthAmbiguous,
  pitWindowDisagreesWithFormat,
  reversedGridWithoutMultiplier,
  differsFromBaseline,
  nonCanonicalSessionKeys,
]
