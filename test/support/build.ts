/**
 * Fixture builders.
 *
 * These produce exports shaped like the real thing but small enough to reason
 * about. They are NOT a substitute for the round-trip fixture in
 * `fixtures/import-roundtrip/` (plan §4.1) — that one has to be a real export.
 */

import type {
  Championship,
  ChampionshipClass,
  ChampionshipEvent,
  Entrant,
  EntryList,
} from "../../src/acsm/types.js"
import { InMemoryPitTable, type PitRecord } from "../../src/pits/table.js"
import { validateProfile } from "../../src/profile/load.js"
import type { LeagueProfile } from "../../src/profile/types.js"

export const testProfile = (over: Partial<LeagueProfile> = {}): LeagueProfile =>
  validateProfile({
    id: "test",
    name: "Test League",
    acsmBaseUrl: "https://acsm.example",
    schedule: {
      weekday: 3,
      qualiStart: "20:00",
      timezone: "America/Los_Angeles",
      practiceMinutes: 60,
      qualiMinutes: 20,
    },
    entryList: { targetSlots: 30 },
    baseline: {
      raceSetup: { EntryListType: 1, PracticeEntryListType: 2 },
      championship: {},
    },
    excludedCarModels: ["ford_transit"],
    ...over,
  })

export function entrant(over: Partial<Entrant> = {}): Entrant {
  return {
    Name: "",
    GUID: "",
    Model: "any_car_model",
    Skin: "",
    PitBox: 0,
    Ballast: 0,
    Restrictor: 0,
    ...over,
  }
}

/** Builds `CAR_0..CAR_{n-1}` from a list, filling PitBox with the index. */
export function entryList(entrants: Partial<Entrant>[]): EntryList {
  const out: EntryList = {}
  entrants.forEach((e, i) => {
    out[`CAR_${i}`] = entrant({ PitBox: i, ...e })
  })
  return out
}

/** n unclaimed slots at the sentinel model. */
export function emptySlots(n: number): Partial<Entrant>[] {
  return Array.from({ length: n }, () => ({}))
}

export function driver(name: string, over: Partial<Entrant> = {}): Partial<Entrant> {
  return {
    Name: name,
    GUID: `7656119${name.length}${name.charCodeAt(0)}${name.charCodeAt(name.length - 1)}`,
    Model: "rss_formula_hybrid_2021",
    Skin: `${name.toLowerCase()}_01`,
    ...over,
  }
}

/**
 * `RaceSetup` and its `Sessions` merge one level deep, so a test can override
 * MaxClients without silently losing the track. Getting this wrong makes
 * checks look like they pass when they never ran.
 */
export function raceEvent(over: Partial<ChampionshipEvent> = {}): ChampionshipEvent {
  const { RaceSetup: raceSetupOver, ...eventOver } = over

  const defaultSessions = {
    Practice: { Name: "Practice", Time: 60, Laps: 0, IsOpen: 1 },
    Qualifying: { Name: "Qualifying", Time: 20, Laps: 0, IsOpen: 1 },
    Race: { Name: "Race", Time: 0, Laps: 20, IsOpen: 1 },
  }

  const { Sessions: sessionsOver, ...raceSetupRest } = raceSetupOver ?? {}

  return {
    ID: `event-${Math.random().toString(16).slice(2, 10)}`,
    // 19:00 practice => 20:00 quali with a 60 minute practice.
    Scheduled: "2026-09-02T19:00:00-07:00",
    ScheduledServerID: "server-1",
    StartedTime: "0001-01-01T00:00:00Z",
    CompletedTime: "0001-01-01T00:00:00Z",
    EntryList: entryList(emptySlots(4)),
    Sessions: {},
    ...eventOver,
    RaceSetup: {
      Track: "suzuka",
      TrackLayout: "",
      Cars: "rss_formula_hybrid_2021",
      MaxClients: 18,
      EntryListType: 1,
      PracticeEntryListType: 2,
      RacePitWindowStart: 0,
      RacePitWindowEnd: 0,
      ReversedGridRacePositions: 0,
      SecondRaceMultiplier: 1,
      AllowDuplicateSkinChoices: false,
      ...raceSetupRest,
      Sessions: sessionsOver ?? defaultSessions,
    },
  }
}

export function championshipClass(over: Partial<ChampionshipClass> = {}): ChampionshipClass {
  return {
    ID: "class-1",
    Name: "RSS Formula Hybrid",
    AvailableCars: ["rss_formula_hybrid_2021"],
    Entrants: entryList(emptySlots(4)),
    Points: {
      Places: Array.from({ length: 20 }, (_, i) => 25 - i),
      BestLap: 1,
      PolePosition: 1,
      SecondRaceMultiplier: 1,
    },
    ...over,
  }
}

export function championship(over: Partial<Championship> = {}): Championship {
  return {
    // A UUID, because that is what ACSM issues — and because `regenerateIds`
    // only rewrites UUID-shaped strings, so a non-UUID default would quietly
    // make every fixture behave like an import that keeps its own ID.
    ID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    Name: "Test Championship",
    Description: "",
    Created: "2026-08-01T00:00:00-07:00",
    Updated: "2026-08-01T00:00:00-07:00",
    Version: 2,
    Classes: [championshipClass()],
    Events: [raceEvent()],
    SignUpForm: { Enabled: false, Responses: [], ExtraFields: [] },
    IgnoreXWorstEvents: 0,
    SpectatorCarEnabled: false,
    ACSR: false,
    ExportSecondRaceToACSR: false,
    StartNextPracticeOnEventComplete: true,
    ...over,
  }
}

export function pitTable(records: PitRecord[] = []): InMemoryPitTable {
  return new InMemoryPitTable(records)
}

export const suzukaPits: PitRecord = {
  track: "suzuka",
  layout: "",
  pitboxes: 30,
  source: "manual",
  verifiedAt: "2026-08-01T00:00:00Z",
}

/** Fixed clock, so schedule checks are deterministic. */
export const NOW = new Date("2026-08-24T12:00:00-07:00")
