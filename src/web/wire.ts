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

import type { InstalledItem } from "../acsm/types.js"
import type { Change, FormFieldChange, RaceFormat } from "../finalize/format.js"
import type { CheckReport } from "../gridmom/finding.js"
import type { FormatPreset } from "../profile/types.js"

export type { Change, CheckReport, FormatPreset, FormFieldChange, InstalledItem, RaceFormat }

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
  /**
   * `yyyy-MM-dd HH:mm ZZZZ`, so `2024-01-15 20:00 PST` — and the same wall
   * clock in July is `PDT`. The zone is spelled out precisely because it
   * changes twice a year, and a race night an hour out is a race night
   * somebody misses.
   */
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
  /**
   * The class car list, as folder names.
   *
   * Here so the create screen can show what a clone would inherit instead of
   * carrying it silently. Off the first class: champctl builds one class per
   * championship, and a hand-made multi-class one is not something this screen
   * can represent anyway.
   */
  cars: string[]
  /**
   * The blurb ACSM shows on the championship page. Here for the same reason.
   *
   * Verbatim, whitespace and all: a clone starts from this, so normalising it
   * here would edit somebody's prose on the way past.
   */
  description: string
  rounds: RoundView[]
}

export interface ChampionshipListItem {
  id: string
  name: string
}

export interface ChampionshipListResponse {
  championships: ChampionshipListItem[]
}

/**
 * Cars and tracks installed on the league's manager.
 *
 * `id` is the folder name a championship stores; `name` is what the manager
 * calls it. The screen searches the name and submits the id, which is the
 * entire point of carrying both.
 */
export interface ContentResponse {
  cars: InstalledItem[]
  tracks: InstalledItem[]
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

// ---------------------------------------------------------------------------
// Creating a championship (plan §5.1)
// ---------------------------------------------------------------------------

/** What the browser asks for when cloning a past championship into a new one. */
export interface NewChampionshipRequest {
  /** The championship to clone. Both the template and the source of the spec. */
  sourceId: string
  /** The new championship's name. Without one, the source's name is reused. */
  name?: string
  /** `YYYY-MM-DD`, the first race night. Later rounds follow the weekday rule. */
  startDate?: string
  /**
   * The class car list, as folder names, replacing the source's outright.
   *
   * Absent means the source's cars, which is what a clone has always done —
   * and doing it invisibly is what let the screen ask which tracks a
   * championship runs at without ever mentioning what anyone would drive.
   */
  cars?: string[]
  /**
   * The championship's blurb.
   *
   * Sent whenever the screen has one to send, *including* an empty string —
   * which is why this is checked against `undefined` rather than for
   * truthiness on the way through. Absent means "inherit the source's", and a
   * clone inheriting one silently is how a September championship ends up
   * describing August's tracks.
   */
  description?: string
  /**
   * The track list, in order, replacing the source's outright.
   *
   * Replaced rather than merged, matching `cloneChampionship`: someone who sends four
   * tracks means four rounds, and merging would silently keep a fifth from
   * the source.
   */
  tracks?: TrackRequest[]
}

export interface TrackRequest {
  track: string
  layout?: string
  /**
   * What to call this round, or absent for the track's own name.
   *
   * Absent and empty mean the same thing here and both reach the emitter as
   * "no name", which is what ACSM writes for an event it creates — the manager
   * then shows the track. There is deliberately no default: champctl inventing
   * a label would go stale the moment somebody changed the track under it.
   */
  name?: string
}

/** One race night, as the review screen shows it. */
export interface PlannedRoundView {
  round: number
  track: string
  layout?: string
  /**
   * `brands_hatch/indy` — the identifier form, as `acsm/view.ts` spells it and
   * as the pit table is keyed. Not the sentence form: `grid.summary` is where
   * a track gets named inside a sentence, and one label doing both is how
   * "capped at 24 by brands_hatch/indy" reached a person.
   */
  label: string
  /** League-local quali start. */
  quali: LocalTimeView
  /** True when a per-round override moved it off the weekday rule. */
  moved: boolean
  note?: string
}

/**
 * The championship as it would be, for a screen to check before anything is written.
 *
 * Deliberately not the championship export. That is a large document full of
 * ACSM's own bookkeeping, and a review screen that renders it invites reading
 * the wrong field. What is here is what §5.1 step 5 asks for: the rounds, the
 * grid cap and what set it, and what the emitter chose rather than inherited.
 */
export interface NewChampionshipPlan {
  /** Hand this back to import. It is the only thing the import endpoint takes. */
  planId: string
  /** The championship this was cloned from. */
  sourceId: string
  name: string
  rounds: PlannedRoundView[]
  /** The grid cap, and the track that bound it. */
  grid: {
    /**
     * The cap the pit counts imply, or **0 meaning none was derived**.
     *
     * 0 is not a grid of nobody: it is what `gridCap` returns when no track on
     * the list has a pit count on file, and the emitter then leaves
     * `MaxClients` as the template had it rather than writing a number derived
     * from nothing. So this is not always what ACSM ends up storing — read
     * `summary`, which says which of the two happened in a sentence, and
     * `bindingTrack`, which is set exactly when a track supplied the number.
     */
    maxClients: number
    /** Named in the summary — "capped at 24 by brands_hatch (indy)". */
    bindingTrack?: string
    /** Tracks with no pit count on file, so the cap is a guess without them. */
    unknownTracks: string[]
    summary: string
  }
  /**
   * What the emitter set rather than inherited.
   *
   * Every entry here was a real bug once (plan §5.5) — an inherited `Created`
   * claiming the championship existed a month before it did, a car list naming a
   * spectator model that is switched off. Shown because "what did it decide for
   * me?" is the question a review screen exists to answer.
   */
  derived: string[]
  /** gridmom against the championship as it *would* be, not against the source. */
  gridmom: CheckReport
  /** An ERROR. Nothing overrides this. */
  blocked: boolean
  /** Warnings exist, so the import will need an acknowledgement. */
  needsAcknowledgement: boolean
}

export interface NewChampionshipPlanResponse {
  plan: NewChampionshipPlan
}

export interface NewChampionshipResponse {
  /** The championship ACSM created. */
  championshipId: string
  name: string
  rounds: number
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
