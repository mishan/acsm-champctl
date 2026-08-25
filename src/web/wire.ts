/**
 * The API contract, as types, in one file.
 *
 * Every response shape the browser sees is declared here and nowhere else. The
 * client imports these directly rather than restating them, because a
 * hand-written mirror of a response is a second definition that starts out
 * correct and stops being correct the first time a field is renamed — and the
 * failure surfaces at runtime, in a browser, on the screen someone is using to
 * change a race that starts in an hour.
 *
 * **This module's import list is a constraint, not an accident.** It may only
 * import from leaves: `acsm/types`, `finalize/format`, `gridmom/finding`,
 * `profile/types`, and Luxon's types. Reach for anything that touches
 * `node:crypto`, `node:fs` or the write session and the whole server graph
 * becomes part of the client's typecheck, where it fails on the difference
 * between Node's `Uint8Array` and the DOM's `BlobPart`. That failure is a
 * nuisance; the design it is protecting is not. Keeping the contract in a file
 * with nothing behind it is what lets both sides share it.
 *
 * The functions that *build* these live in `view.ts`, which is under no such
 * restriction.
 */

import type { Change, FormFieldChange, RaceFormat } from "../finalize/format.js"
import type { CheckReport } from "../gridmom/finding.js"
import type { FormatPreset } from "../profile/types.js"

export type { Change, CheckReport, FormatPreset, FormFieldChange, RaceFormat }

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** `GET /api/config`. Public — a login screen has to render before there is one. */
export interface ConfigResponse {
  league: { id: string; name: string }
  /** The ACSM these credentials will be forwarded to. Shown on the login form. */
  baseUrl: string
  /** IANA zone. Every wall clock in these types is expressed in it. */
  timezone: string
  /** League default quali start, `HH:mm`. */
  qualiStart: string
  practiceMinutes: number
  /** The league's named shorthands — "1x40", "2x20" — from its profile. */
  formats: FormatPreset[]
}

/** `GET /api/session`. 200 either way; not being logged in is not an error. */
export type SessionResponse =
  | { authenticated: false }
  | { authenticated: true; username: string; expiresAt: number }

export interface LoginResponse {
  username: string
  expiresAt: number
}

// ---------------------------------------------------------------------------
// Championships and rounds
// ---------------------------------------------------------------------------

/** A wall clock in the league's zone, plus something to print. */
export interface LocalTimeView {
  /** `YYYY-MM-DD`, ready to go straight into a date input. */
  date: string
  /** `HH:mm`, ready to go straight into a time input. */
  time: string
  /** `2026-09-09 20:00 PDT` — the offset spelled out, because it changes. */
  display: string
}

export interface RoundView {
  /** 1-based, as a league counts rounds. */
  round: number
  eventId: string
  /** `suzuka` or `ks_silverstone/international`. Empty if the event has none. */
  track: string
  label: string
  /**
   * True once anything in the round has run.
   *
   * The UI greys these out rather than hiding them. A finished round is still
   * worth seeing in the list — and offering to set the lap count on a race that
   * already happened is how someone edits the wrong week.
   */
  started: boolean
  format: RaceFormat
  /** Minutes of practice this event runs; what `Scheduled` is offset by. */
  practiceMinutes: number
  /** League-local quali start, or null when the event is unscheduled. */
  quali: LocalTimeView | null
  /** `Scheduled` — practice start, before quali. Null if unscheduled. */
  practiceStart: LocalTimeView | null
}

export interface ChampionshipView {
  id: string
  name: string
  /** The league zone every time above is expressed in. */
  timezone: string
  rounds: RoundView[]
}

export interface ChampionshipListItem {
  id: string
  name: string
}

export interface ChampionshipListResponse {
  championships: ChampionshipListItem[]
}

export interface ChampionshipResponse {
  championship: ChampionshipView
  /** The championship as it stands, before anyone edits anything. */
  gridmom: CheckReport
}

// ---------------------------------------------------------------------------
// Preview and push
// ---------------------------------------------------------------------------

/** What a preview asks for. Every field optional: naming one is a promise about the rest. */
export interface PlanRequest {
  laps?: number
  minutes?: number
  reversedGridPositions?: number
  mandatoryPit?: boolean
  extraLap?: boolean
  /** League-local wall clock. Omit to leave the schedule alone. */
  quali?: { date: string; time: string }
}

/** One field that will be posted. `null` is JSON for "the form doesn't carry it". */
export interface PostedField {
  name: string
  before: string | null
  after: string
}

export interface PlanView {
  /** Hand this back to push. It is the only thing the push endpoint takes. */
  planId: string
  championshipId: string
  eventId: string
  round: number
  current: RaceFormat
  desired: RaceFormat
  /** The diff a person reads. "Race length: 40 minutes → 18 laps." */
  changes: Change[]
  /** What the event save will actually post, field by field. */
  formChanges: PostedField[]
  /**
   * Present only when quali moves, and it is a second request — the event
   * submit form doesn't carry `Scheduled` (plan §5.2). Kept separate from
   * `formChanges` so the UI can say so; a push that half-lands is a state
   * someone needs to have been warned was possible.
   */
  schedule: {
    from: string | null
    to: string
    fields: { name: string; value: string }[]
  } | null
  /** gridmom against the championship as it *would* be, not as it is. */
  gridmom: CheckReport
  /** An ERROR. Nothing overrides this. */
  blocked: boolean
  /** Warnings exist, so the push will need an acknowledgement. */
  needsAcknowledgement: boolean
  /** Nothing to do — the round already matches. */
  noop: boolean
}

export interface PlanResponse {
  plan: PlanView
  /** The round as it stands, so the screen has a "before" without a second request. */
  round: RoundView
}

export interface ApplyResponse {
  eventSaved: boolean
  /** A separate request, and it can fail on its own. */
  scheduleSaved: boolean
  changes: Change[]
}

/** The body of every non-2xx response. */
export interface ErrorResponse {
  error: {
    /** Stable machine code, so the UI branches without matching on prose. */
    code: string
    /** One plain sentence champctl wrote, safe to render as-is. */
    message: string
  }
}
