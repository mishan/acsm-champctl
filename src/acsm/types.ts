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

  /**
   * An int on the wire, not a bool, despite reading as a yes/no question.
   *
   * Measured against 2.4.15, which refuses the whole import with
   * `json: cannot unmarshal bool into Go struct field
   * CurrentRaceConfig.Events.RaceSetup.RaceExtraLap of type int`. Typed as
   * either because an export is the only thing that says which a given build
   * sends, and reads must survive both — see `readFormat`. Writes go out as a
   * number.
   */
  RaceExtraLap?: number | boolean

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
  /**
   * What the manager calls this round, and what it shows *instead of* the
   * track when it isn't empty.
   *
   * ACSM writes `""` for every event it creates and derives the label from
   * `RaceSetup.Track`. A non-empty value is something a person or an older
   * build put there. Modelled rather than left to flow through as an unknown,
   * because the emitter builds every round from one template event — so an
   * inherited name is the template's track on all of them, and a championship
   * comes out with five rounds that all claim to be at Donington.
   */
  Name?: string
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
  /**
   * The two gates are not the same type on the wire, however much they look
   * like a pair. Measured against 2.4.15: the skill gate is a string, and the
   * safety gate is an int that rejects `""` with
   * `json: cannot unmarshal string into Go struct field
   * Championship.ACSRSafetyGate of type int`. Both stay loose because that
   * asymmetry is exactly the kind of thing that drifts between builds.
   */
  ACSRSkillGate?: string | number | null
  ACSRSafetyGate?: number | string | null

  StartNextPracticeOnEventComplete?: boolean
}

/** One row of `/api/championships/list.json`. */
export interface ChampionshipSummary extends Unknowns {
  ID?: string
  Name?: string
}

/**
 * `/healthcheck.json`, which every build answers without credentials.
 *
 * Only the fields champctl reads are named, and all of them are optional: this
 * is the one response that has to parse on a build nobody has seen yet, since
 * it is what tells us which build we are talking to. See `dialect.ts`.
 */
export interface AcsmHealthcheck extends Unknowns {
  /**
   * Both spellings, because both are in play. 1.7.9, 2.4.5 and 2.4.15 all
   * answer `OK`; the repo's own fixtures and `StaticAcsmReader` have long used
   * `ok`. Declaring only one left the other reachable through the index
   * signature — typed as `unknown`, so every read of it needed a cast, which
   * is how a field that exists ends up treated as one that might not.
   */
  OK?: boolean
  ok?: boolean
  /**
   * `Version` is what 1.7.9, 2.4.5 and 2.4.15 all return — measured, not
   * assumed. The other two spellings have never been seen from a build and are
   * declared because `scripts/recon/forms.ts` probes for them, which is the
   * kind of hedge that is worth either honouring or deleting rather than
   * leaving in two minds. `dialectFrom` reads all three.
   */
  Version?: string
  version?: string
  ServerManagerVersion?: string
  /** 1.7.x reports this. 2.4.x dropped it and reports `LicenseID` instead. */
  IsPremium?: boolean
  /** Premium only — it is the licence the build validated at startup. */
  LicenseID?: string
  AssettoIsInstalled?: boolean
}

/**
 * A car or a track as ACSM's own listing pages show it.
 *
 * Here rather than beside the scraper that produces it, because `wire.ts`
 * names this shape and may only reach into leaves — following it into a module
 * that imports cheerio would drag the HTML parser into the client's typecheck.
 */
export interface InstalledItem {
  /** The folder name, which is what a championship stores. */
  id: string
  /** What the listing calls it, or the folder name when it gives no other. */
  name: string
}

export interface InstalledContent {
  cars: InstalledItem[]
  tracks: InstalledItem[]
}
