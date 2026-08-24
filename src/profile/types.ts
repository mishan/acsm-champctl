/**
 * League profile.
 *
 * BATL's baseline lives in `profiles/batl.json`; another league drops in their
 * own. Anything that can't be expressed here is something that got hardcoded
 * and shouldn't have — that is the design check (plan §2).
 */

import type { Championship, RaceSetup } from "../acsm/types.js"

/** ISO weekday, 1 = Monday ... 7 = Sunday (matches Luxon). */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7

export interface ScheduleDefaults {
  /** Race night. BATL: 3 (Wednesday). */
  weekday: Weekday
  /** Default quali start as local wall-clock `HH:mm`. NOT `Scheduled`. */
  qualiStart: string
  /** IANA zone. Wall-clock is authoritative; offsets differ across DST. */
  timezone: string
  /** Minutes of practice before quali. `Scheduled = qualiStart − this`. */
  practiceMinutes: number
  /** Expected quali duration in minutes, for the baseline INFO diff. */
  qualiMinutes: number
}

export interface EntryListPolicy {
  /** How many people may hold a championship place. A league policy, NOT a
   *  track constraint, and deliberately larger than MaxClients (plan §4.4). */
  targetSlots: number
  /** Reserved pit boxes that entrants must not use, e.g. a spectator car. */
  reservedPitBoxes?: number[]
  /**
   * How to read a race number out of a skin folder name, as a regex source
   * with one capture group — e.g. `"^\\d+_(\\d{1,3})$"`.
   *
   * ACSM has no race number field, so this is pure league convention. When it
   * is absent the duplicate-race-number check doesn't run, which is the right
   * default: guessing at digits inside arbitrary skin names finds a "duplicate"
   * in every entry list.
   */
  raceNumberFromSkin?: string
}

/**
 * Baseline values. Any event or championship field that differs from these
 * produces an INFO finding — expected in a league that votes on everything,
 * so these are never blocking.
 */
export interface Baseline {
  raceSetup?: Partial<RaceSetup>
  championship?: Partial<Championship>
}

export interface LeagueProfile {
  id: string
  name: string
  /** Base URL of the league's ACSM, used by the read client and CLI. */
  acsmBaseUrl?: string
  schedule: ScheduleDefaults
  entryList: EntryListPolicy
  baseline: Baseline
  /** Cars that never count toward stats or grid checks, e.g. `ford_transit`. */
  excludedCarModels?: string[]
}
