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

/**
 * One human-readable difference. "Race length: 40 minutes → 18 laps."
 *
 * Here rather than in `plan.ts`, which is where it is produced and used, for a
 * reason that is entirely about dependencies: the browser needs this type, and
 * `plan.ts` imports `node:crypto` and the write session. This module reaches
 * no further than the export's own types and `acsm/view.ts`, neither of which
 * touches a Node-only module — so a client can follow the type here and stop.
 * That is the constraint to preserve: not "types only", but nothing a browser
 * bundle cannot resolve.
 */
export interface Change {
  label: string
  before: string
  after: string
}

/**
 * One form field that will be posted with a different value.
 *
 * `before` is optional rather than `string | null` because a field the form
 * doesn't currently carry is genuinely absent; `postedField` in `web/view.ts`
 * is where that becomes JSON's `null`.
 */
export interface FormFieldChange {
  name: string
  before: string | undefined
  after: string
}

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
 * Bounds that are absurd for a race and safe for `String()`.
 *
 * 2000 laps is longer than any endurance race a league runs weekly, and 2000
 * minutes is a day and a half. Neither is a judgement about what a league might
 * want; they are the point past which the value is a mistake or an attack, and
 * having *a* bound is what keeps an integer out of exponential notation before
 * it becomes a form value.
 *
 * Here rather than in the web layer because more than one place has to enforce
 * them and they must not drift. `formFieldsFor` below is the backstop — it is
 * where a number becomes a form value, so nothing can reach ACSM in
 * exponential notation whatever route it arrived by. Profile validation
 * rejects a *preset* past them at load, which is earlier and kinder: a profile
 * carrying `laps: 1e30` would otherwise start the service cleanly and present
 * a preset button whose only possible outcome was a refusal — configuration
 * that fails at the moment someone clicks it rather than at the moment it is
 * read.
 */
export const MAX_LAPS = 2000
export const MAX_MINUTES = 2000
export const MAX_REVERSED = 1000

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
    extraLap: readExtraLap(rs.RaceExtraLap),
  }
}

/**
 * `RaceExtraLap` as a yes/no, from whatever the export happens to carry.
 *
 * This was `=== true`, which is false for the `1` a real ACSM export sends —
 * so champctl read every championship that had the extra lap *on* as having it
 * off, and a finalize or a clone would then quietly turn it off for real. Only
 * a live import caught it; a synthetic fixture written with `false` agreed
 * with the bug.
 */
function readExtraLap(value: unknown): boolean {
  if (typeof value === "number") return value !== 0
  if (typeof value === "string") return value !== "" && value !== "0"
  return value === true
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
    [FIELD.raceLaps]: formNumber(laps, MAX_LAPS, "Race length in laps"),
    [FIELD.raceTime]: formNumber(minutes, MAX_MINUTES, "Race length in minutes"),
    [FIELD.pitWindowStart]: String(pitWindowStartFor(format.mandatoryPit)),
    [FIELD.reversedGrid]: formNumber(
      format.reversedGridPositions,
      MAX_REVERSED,
      "Reversed grid positions",
    ),
    [FIELD.extraLap]: format.extraLap ? "1" : "0",
  }
}

/** Whether an overrides object actually asks for something. */
function namesAnything(over: FormatOverrides): boolean {
  return (
    over.laps !== undefined ||
    over.minutes !== undefined ||
    over.reversedGridPositions !== undefined ||
    over.mandatoryPit !== undefined ||
    over.extraLap !== undefined
  )
}

/**
 * A number on its way to becoming a form value, or a refusal.
 *
 * The last point at which a bad number is still a number rather than a string
 * in an HTTP body. `String(1e30)` is `"1e+30"`, which ACSM parses as 1 — so a
 * value that slipped past validation would not fail, it would quietly set a
 * one-lap race. Every caller today validates first; this exists so that
 * staying true is not a thing anyone has to remember.
 */
function formNumber(value: number, max: number, what: string): string {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(
      `${what} must be a whole number between 0 and ${max}, and this one is ${value}. ` +
        `Nothing was written. This is a bug rather than a bad request — every path here ` +
        `checks its input first.`,
    )
  }
  return String(value)
}

/**
 * A partial answer to "what did the vote change?".
 *
 * Every field optional, because that is the whole semantic: naming one is an
 * instruction about that field and a promise about none of the others.
 */
export interface FormatOverrides {
  laps?: number
  minutes?: number
  reversedGridPositions?: number
  mandatoryPit?: boolean
  extraLap?: boolean
}

/**
 * The current format with whatever was asked for laid over it.
 *
 * Starting from the current format rather than from defaults is the point:
 * "18 laps" means "make it 18 laps", not "make it 18 laps and reset everything
 * I didn't mention". That rule is documented in the README as CLI behaviour,
 * but it is not a CLI concern — the web UI sends exactly the same kind of
 * partial answer, and two implementations of "only the fields you name change"
 * is one that gets fixed and one that doesn't.
 *
 * `laps` wins over `minutes` when both arrive. Callers are expected to have
 * rejected that combination already, with a message about why a race is
 * measured one way or the other; this only makes the fallthrough match
 * `readFormat`, which also prefers laps, rather than inventing a third rule.
 */
export function withOverrides(current: RaceFormat, over: FormatOverrides): RaceFormat {
  // Nothing named, nothing to do — and `current` itself rather than a copy of
  // it. `--yes` with no format flags parses to an object of undefineds rather
  // than to an empty one, so this is the ordinary shape of "confirm what is
  // already there", not an edge case. Returning the same reference lets a
  // caller compare with `===` to answer "did the vote change anything?"
  // without walking the fields.
  if (!namesAnything(over)) return current

  const length: RaceLength =
    over.laps !== undefined
      ? { kind: "laps", laps: over.laps }
      : over.minutes !== undefined
        ? { kind: "minutes", minutes: over.minutes }
        : current.length

  // Spread `current` first so anything not named in `FormatOverrides` survives.
  // `note` is the one that exists today — the audit trail of how a format was
  // decided, "voted 22 laps, 8/25" — and rebuilding the object field by field
  // dropped it, so overriding the laps silently threw away why the laps were
  // what they were. Listing the fields explicitly would go wrong again the next
  // time RaceFormat grows one.
  return {
    ...current,
    length,
    reversedGridPositions: over.reversedGridPositions ?? current.reversedGridPositions,
    mandatoryPit: over.mandatoryPit ?? current.mandatoryPit,
    extraLap: over.extraLap ?? current.extraLap,
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
  const raceKey = Object.keys(sessions).find((k) => k.toUpperCase() === "RACE") ?? newRaceKey()
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
      // A number, not the boolean the league-facing format uses. ACSM's struct
      // field is an int and Go's unmarshal rejects the whole championship on a
      // bool — so emitting one made every generated month unimportable, which
      // is the sharpest possible version of this bug: the JSON looked right and
      // the server refused all of it. See `RaceExtraLap` in acsm/types.ts.
      RaceExtraLap: format.extraLap ? 1 : 0,
    },
  }
}

/**
 * The key to file a newly-created race session under. Always `RACE`.
 *
 * This used to prefer the friendly `Race` when the event's other sessions were
 * spelled that way, on the reasoning that a mixed map is a mess for whoever
 * reads the JSON next. That was tidiness applied to the wrong thing: ACSM keys
 * `RaceSetup.Sessions` by its `SessionType` constants and looks them up by
 * exactly those strings, so a session filed under `Race` is one ACSM cannot
 * see. It survives the export unchanged, opens blank in Server Manager, and is
 * wiped by the first save.
 *
 * So matching the neighbours was actively making the championship worse when
 * the neighbours were already wrong. `format.session-keys` reports the ones
 * that are; this stops champctl adding more.
 */
function newRaceKey(): string {
  return "RACE"
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback
}
