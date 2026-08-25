/**
 * Structural types over the ACSM championship export.
 *
 * Deliberately loose. ACSM's championship schema is a large undocumented Go
 * struct that drifts across versions, so we model only the fields we read and
 * let everything else flow through untouched (see plan §4.1). Every interface
 * carries an index signature for that reason — do not tighten them.
 *
 * Nothing here should be used to *build* a championship for import; that path
 * goes through the template + overlay emitter, which preserves unknown fields.
 */

/** Any JSON object we haven't modelled. */
export type Unknowns = Record<string, unknown>

/** Sentinel model for an entry-list slot nobody has claimed yet (plan §4.4). */
export const ANY_CAR_MODEL = "any_car_model"

/**
 * `EntryListType` / `PracticeEntryListType` (plan §4.4).
 * BATL runs Locked races with PartiallyLocked practice.
 */
export const EntryListType = {
  Unlocked: 0,
  Locked: 1,
  PartiallyLocked: 2,
} as const
export type EntryListTypeValue = (typeof EntryListType)[keyof typeof EntryListType]

/**
 * The logical session champctl talks about. NOT the literal JSON key.
 *
 * ACSM's `SessionType` is a Go string type whose constants are `"BOOK"`,
 * `"PRACTICE"`, `"QUALIFY"` and `"RACE"` (`config_ini.go`) — uppercase and
 * abbreviated. Exports have also been seen using the friendly spellings. Since
 * `Sessions` is a `map[SessionType]...`, an unrecognised key unmarshals without
 * complaint, so nothing errors when the spelling is wrong; the lookup just
 * quietly finds nothing.
 *
 * Always go through `session()` in view.ts, which resolves either spelling.
 */
export type SessionKey = "Booking" | "Practice" | "Qualifying" | "Race"

/** Every JSON key seen for each logical session, lowercased for comparison. */
export const SESSION_KEY_ALIASES: Record<SessionKey, readonly string[]> = {
  Booking: ["booking", "book"],
  Practice: ["practice"],
  Qualifying: ["qualifying", "qualify", "quali"],
  Race: ["race"],
} as const

/**
 * One entrant slot. Appears both in the championship class entrant list and,
 * duplicated, in every event's entry list.
 *
 * `InternalUUID` is a per-list identity, NOT a join key — the class list and
 * each event list use different UUIDs for the same driver. Line them up by the
 * `CAR_n` map key instead (plan §5.5).
 */
export interface Entrant extends Unknowns {
  Name?: string
  GUID?: string
  Team?: string
  Model?: string
  Skin?: string
  /** Pit box index. In the *export* this is `PitBox`; in the edit *form* the
   *  same value is carried as `EntryList.EntrantID` (plan §3.2). */
  PitBox?: number
  Ballast?: number
  Restrictor?: number
  SpectatorMode?: number
  InternalUUID?: string
  GuidsList?: string[] | null
}

/** `CAR_0`, `CAR_1`, ... -> entrant. Key order is grid order. */
export type EntryList = Record<string, Entrant>

export interface SessionConfig extends Unknowns {
  Name?: string
  Time?: number
  Laps?: number
  IsOpen?: number
  IsMandatory?: boolean
  WaitTime?: number
}

export interface RaceSetup extends Unknowns {
  Track?: string
  TrackLayout?: string
  /** Semicolon-joined model list. Must be *derived* from the class
   *  `AvailableCars` plus the spectator model, never inherited (plan §5.5). */
  Cars?: string
  MaxClients?: number
  /** Keyed by ACSM's SessionType — "PRACTICE"/"QUALIFY"/"RACE" or the
   *  friendly spellings, depending on version. Use `session()` to read it. */
  Sessions?: Record<string, SessionConfig>

  EntryListType?: number
  PracticeEntryListType?: number

  /** Lap the pit window opens. BATL sets 1 for a mandatory stop, 0 otherwise
   *  — this is the mandatory-pit switch (plan §4.2). */
  RacePitWindowStart?: number
  RacePitWindowEnd?: number
  RaceExtraLap?: boolean

  ReversedGridRacePositions?: number
  SecondRaceMultiplier?: number

  PickupModeEnabled?: number
  LockedEntryList?: number
  AllowDuplicateSkinChoices?: boolean

  MandatoryLongPitEnabled?: boolean
  MandatoryLongPitMinimumNumberOfLongPits?: number
}

export interface SessionResults extends Unknowns {
  Type?: string
  TrackName?: string
  TrackConfig?: string
  Date?: string
  Cars?: ResultCar[]
  Result?: ResultEntry[]
  Laps?: ResultLap[]
  Events?: ResultEvent[]
}

export interface ResultCar extends Unknowns {
  CarId?: number
  Driver?: { Name?: string; Guid?: string; GuidsList?: string[] | null }
  Model?: string
  Skin?: string
}

export interface ResultEntry extends Unknowns {
  DriverName?: string
  DriverGuid?: string
  CarId?: number
  CarModel?: string
  BestLap?: number
  TotalTime?: number
  BallastKG?: number
  Restrictor?: number
  GridPosition?: number
  PitsTaken?: number
  Disqualified?: boolean
  Penalties?: unknown[]
}

export interface ResultLap extends Unknowns {
  DriverName?: string
  DriverGuid?: string
  CarId?: number
  CarModel?: string
  Timestamp?: number
  LapTime?: number
  Sectors?: number[]
  Cuts?: number
  Tyre?: string
}

export interface ResultEvent extends Unknowns {
  Type?: string
  CarId?: number
  Driver?: { Name?: string; Guid?: string }
  OtherCarId?: number
  OtherDriver?: { Name?: string; Guid?: string }
  ImpactSpeed?: number
  WorldPosition?: { X?: number; Y?: number; Z?: number }
}

export interface EventSession extends Unknowns {
  Name?: string
  StartedTime?: string
  CompletedTime?: string
  Results?: SessionResults | null
}

export interface ChampionshipEvent extends Unknowns {
  ID?: string
  /** Practice start, NOT quali start: `Scheduled = qualiStart − practice`
   *  (plan §4.3). ISO-8601 with a real UTC offset. */
  Scheduled?: string
  ScheduledServerID?: string
  StartedTime?: string
  CompletedTime?: string
  RaceSetup?: RaceSetup
  EntryList?: EntryList
  /** Same key caveat as RaceSetup.Sessions. Use `eventSession()` to read it. */
  Sessions?: Record<string, EventSession>
}

export interface ChampionshipClass extends Unknowns {
  ID?: string
  Name?: string
  AvailableCars?: string[]
  Entrants?: EntryList
  Points?: ChampionshipPoints
}

export interface ChampionshipPoints extends Unknowns {
  Places?: number[]
  BestLap?: number
  PolePosition?: number
  SecondRaceMultiplier?: number
  CollisionWithDriver?: number
  CollisionWithEnv?: number
  CutTrack?: number
}

export interface SignUpResponse extends Unknowns {
  Created?: string
  Name?: string
  GUID?: string
  Team?: string
  Email?: string
  Car?: string
  Skin?: string
  Status?: "Accepted" | "Rejected" | string
  Questions?: Record<string, string>
}

export interface SignUpForm extends Unknowns {
  Enabled?: boolean
  AskForEmail?: boolean
  AskForTeam?: boolean
  HideCarChoice?: boolean
  RequiresApproval?: boolean
  RegistrationOpen?: boolean
  RegistrationClosesAt?: string
  ExtraFields?: unknown[]
  /** PUBLIC DATA. Strip before anything reaches a dashboard (plan §5.3). */
  Responses?: SignUpResponse[]
}

export interface Championship extends Unknowns {
  ID?: string
  Name?: string
  Description?: string
  Created?: string
  Updated?: string
  Version?: number
  Classes?: ChampionshipClass[]
  Events?: ChampionshipEvent[]
  SignUpForm?: SignUpForm
  OpenEntrants?: boolean
  PersistOpenEntrants?: boolean
  IgnoreXWorstEvents?: number

  SpectatorCarEnabled?: boolean
  SpectatorCar?: Entrant

  ACSR?: boolean
  ExportSecondRaceToACSR?: boolean
  ACSRSkillGate?: string
  ACSRSafetyGate?: string

  StartNextPracticeOnEventComplete?: boolean
}

/** One row of `/api/championships/list.json`. */
export interface ChampionshipSummary extends Unknowns {
  ID?: string
  Name?: string
}
