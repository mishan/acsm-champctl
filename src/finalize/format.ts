/**
 * Race format as a league argues about it, and how it maps onto ACSM.
 *
 * Plan §4.2. Three separate representations meet here, and keeping them
 * straight is most of what this module is for:
 *
 * 1. **The domain** — `RaceFormat`. What a poll decides. "18 laps, reversed
 *    grid 5, mandatory pit."
 * 2. **The export** — `RaceSetup`, typed JSON, read-only, the source of truth
 *    for what the event *currently* is.
 * 3. **The event form** — flat `name=value` pairs with their own spellings.
 *    `Race.Laps`, not `Sessions.RACE.Laps`. This is the only thing that can be
 *    written, and it must be round-tripped rather than assembled
 *    (docs/acsm-write-path.md §1).
 *
 * The diff a person reads is computed in (1). The write happens in (3). Going
 * straight from (1) to (3) without reading (2) is how you show someone a
 * confident preview of a change that was already true.
 */

import type { ChampionshipEvent, RaceSetup } from "../acsm/types.js"
import { session } from "../acsm/view.js"

/** Laps or minutes; both are legitimate and both get voted on. */
export type RaceLength = { kind: "laps"; laps: number } | { kind: "minutes"; minutes: number }

export interface RaceFormat {
  length: RaceLength
  /** 0 = single race. BATL uses 5 for a 2x20. */
  reversedGridPositions: number
  /** A league rule, expressed through `RacePitWindowStart`. See below. */
  mandatoryPit: boolean
  extraLap: boolean
  /** Audit trail — "voted 22 laps, 8/25". Never written to ACSM. */
  note?: string
}

/**
 * `mandatoryPit` is not a boolean in ACSM. It is `RacePitWindowStart`, the lap
 * the pit window opens, and BATL's convention is 1 for a mandatory stop and 0
 * for none — confirmed across two championships (plan §4.2).
 *
 * Exported because the mapping is a league convention rather than a fact about
 * ACSM, and a reader deserves to see the number rather than infer it.
 */
export const PIT_WINDOW_OPEN = 1
export const PIT_WINDOW_CLOSED = 0

export function pitWindowStartFor(mandatoryPit: boolean): number {
  return mandatoryPit ? PIT_WINDOW_OPEN : PIT_WINDOW_CLOSED
}

/**
 * Reads the format currently configured on an event.
 *
 * `session()` rather than a direct key lookup: ACSM's session map is keyed by
 * a Go string type whose constants are `PRACTICE`/`QUALIFY`/`RACE`, but
 * exports have also carried the friendly spellings, and guessing wrong yields
 * a confident answer about a session that isn't there.
 *
 * A race with neither laps nor time set reads as 0 laps, which is what ACSM
 * itself means by it — and what gridmom's `format.no-race-length` reports.
 */
export function readFormat(ev: ChampionshipEvent): RaceFormat {
  const rs: RaceSetup = ev.RaceSetup ?? {}
  const race = session(ev, "Race")

  const laps = numberOr(race?.Laps, 0)
  const minutes = numberOr(race?.Time, 0)

  // Laps win when both are set. ACSM treats a non-zero lap count as the race
  // length and ignores Time, so reporting minutes here would describe a race
  // that isn't going to happen.
  const length: RaceLength = laps > 0 ? { kind: "laps", laps } : { kind: "minutes", minutes }

  return {
    length,
    reversedGridPositions: numberOr(rs.ReversedGridRacePositions, 0),
    mandatoryPit: numberOr(rs.RacePitWindowStart, 0) > 0,
    extraLap: rs.RaceExtraLap === true,
  }
}

/** True when the two formats describe the same race. `note` is not compared. */
export function sameFormat(a: RaceFormat, b: RaceFormat): boolean {
  return (
    sameLength(a.length, b.length) &&
    a.reversedGridPositions === b.reversedGridPositions &&
    a.mandatoryPit === b.mandatoryPit &&
    a.extraLap === b.extraLap
  )
}

export function sameLength(a: RaceLength, b: RaceLength): boolean {
  if (a.kind !== b.kind) return false
  return a.kind === "laps"
    ? a.laps === (b as { laps: number }).laps
    : a.minutes === (b as { minutes: number }).minutes
}

/** "18 laps" / "40 minutes", for a diff a person reads. */
export function describeLength(l: RaceLength): string {
  return l.kind === "laps"
    ? `${l.laps} ${l.laps === 1 ? "lap" : "laps"}`
    : `${l.minutes} ${l.minutes === 1 ? "minute" : "minutes"}`
}

/**
 * The event-form field names this module writes.
 *
 * Captured from a real rendered form, not guessed — `fixtures/recon/`. Note
 * `Race.Laps` and not `Sessions.RACE.Laps`: the form flattens the session map
 * using the *friendly* spellings even on a build whose export uses
 * `PRACTICE`/`QUALIFY`/`RACE`. The two vocabularies genuinely differ, and this
 * is the seam.
 */
export const FIELD = {
  raceLaps: "Race.Laps",
  raceTime: "Race.Time",
  pitWindowStart: "RacePitWindowStart",
  reversedGrid: "ReversedGridRacePositions",
  extraLap: "RaceExtraLap",
  practiceTime: "Practice.Time",
  qualifyingTime: "Qualifying.Time",
} as const

/**
 * The form fields a format implies, as name → value.
 *
 * Both `Race.Laps` and `Race.Time` are always written, because they are two
 * halves of one decision: switching a 40-minute race to 18 laps has to zero
 * the minutes, or ACSM is left with both set and the reader of the export
 * can't tell which applies.
 *
 * `RaceExtraLap` is written as `"1"`/`"0"` rather than by adding and removing
 * the key. It looks like a checkbox, and browser semantics would say an
 * unchecked box is absent — but the recon capture shows the field present
 * exactly once while the seed championship has `RaceExtraLap: false`, so
 * presence here does not mean checked. Treating it as a checkbox would have
 * silently inverted the setting. See docs/acsm-write-path.md §14.
 */
export function formFieldsFor(format: RaceFormat): Record<string, string> {
  const laps = format.length.kind === "laps" ? format.length.laps : 0
  const minutes = format.length.kind === "minutes" ? format.length.minutes : 0

  return {
    [FIELD.raceLaps]: String(laps),
    [FIELD.raceTime]: String(minutes),
    [FIELD.pitWindowStart]: String(pitWindowStartFor(format.mandatoryPit)),
    [FIELD.reversedGrid]: String(format.reversedGridPositions),
    [FIELD.extraLap]: format.extraLap ? "1" : "0",
  }
}

/**
 * Applies a format to an event, returning a new event.
 *
 * Used to build the *would-be* championship that gridmom checks, so the person
 * sees the findings for what they are about to create rather than for what is
 * already there. Never mutates its argument, and never posted — the write goes
 * through the form.
 */
export function applyFormat(ev: ChampionshipEvent, format: RaceFormat): ChampionshipEvent {
  const rs = ev.RaceSetup ?? {}
  const sessions = { ...(rs.Sessions ?? {}) }

  // Write back under whichever key this export actually uses, so we don't
  // leave a stale RACE beside a fresh Race — and *create* one when there is
  // none.
  //
  // Skipping the length when no race session exists was a real bug in both
  // directions. For a preview, gridmom would be handed a would-be event still
  // reading zero laps and report `format.no-race-length` for a race the write
  // is about to set — blocking a push that fixes the very thing complained
  // about. For `emitMonth`, which applies a format for real rather than for
  // preview, the month would simply be emitted without its race length.
  const raceKey =
    Object.keys(sessions).find((k) => k.toUpperCase() === "RACE") ?? newRaceKey(sessions)
  const existing = sessions[raceKey] ?? { Name: "Race" }
  sessions[raceKey] = {
    ...existing,
    Laps: format.length.kind === "laps" ? format.length.laps : 0,
    Time: format.length.kind === "minutes" ? format.length.minutes : 0,
  }

  // Turning the window *on* keeps whichever lap it already opened at.
  //
  // `mandatoryPit` is a boolean because that is the league-facing question —
  // is there a compulsory stop — but `RacePitWindowStart` is a lap number, and
  // collapsing one into the other loses the lap. A championship whose window
  // opens at lap 5 round-tripped through `readFormat` (5 → true) and back
  // through here (true → 1), so cloning last month silently moved the window
  // four laps earlier and left `RacePitWindowEnd` where it was — a 1-to-12
  // window nobody chose. Silent, because `derived` never mentioned it.
  //
  // So the boolean only decides *whether* there is a window; an existing lap
  // survives, and 1 is the default for a window being switched on from off.
  const currentWindowStart = numberOr(rs.RacePitWindowStart, 0)
  const pitWindowStart = format.mandatoryPit
    ? currentWindowStart > 0
      ? currentWindowStart
      : PIT_WINDOW_OPEN
    : PIT_WINDOW_CLOSED

  return {
    ...ev,
    RaceSetup: {
      ...rs,
      Sessions: sessions,
      RacePitWindowStart: pitWindowStart,
      ReversedGridRacePositions: format.reversedGridPositions,
      RaceExtraLap: format.extraLap,
    },
  }
}

/**
 * The key to file a newly-created race session under.
 *
 * ACSM's `SessionType` constants are `PRACTICE`/`QUALIFY`/`RACE` and that is
 * what a real export uses, so `RACE` is the default. But exports have also
 * carried the friendly spellings, and an event whose other sessions are
 * `Practice`/`Qualifying` should get `Race` rather than a `RACE` sitting oddly
 * beside them — `lookupSession` finds either, so this is about not leaving a
 * mess for a human reading the JSON.
 */
function newRaceKey(sessions: Record<string, unknown>): string {
  const friendly = Object.keys(sessions).some((k) => k !== k.toUpperCase() && /^[A-Z]/.test(k))
  return friendly ? "Race" : "RACE"
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback
}
