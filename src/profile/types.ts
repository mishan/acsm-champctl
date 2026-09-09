/**
 * League profile.
 *
 * BATL's baseline lives in `profiles/batl.json`; another league drops in their
 * own. Anything that can't be expressed here is something that got hardcoded
 * and shouldn't have — that is the design check (plan §2).
 */

import type { Championship, RaceSetup } from "../acsm/types.js"
import type { RaceFormat } from "../finalize/format.js"

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
  /**
   * Whether this league minds two entrants sharing a skin.
   *
   * Off by default, and the check does not run without it — the same shape as
   * `raceNumberFromSkin` above, and for the same reason.
   *
   * This used to be read off ACSM's `AllowDuplicateSkinChoices`, which is
   * `false` in every export anyone has looked at, including leagues where
   * duplicate skins are entirely routine because not everyone has one of their
   * own. That is Go's zero value for a field nobody sets, not a league
   * declaring it enforces unique skins — the same trap as
   * `PracticeEntryListType` in plan §5.4. Reading it as a rule turned one BATL
   * championship into 27 duplicate-skin ERRORs, which blocked every push and
   * buried the two findings that were real.
   *
   * A league where everyone does have a custom skin can set this and hear
   * about it when two people turn up in the same car. As a warning: two
   * identical cars is confusing on a broadcast, not a broken or unfair race.
   */
  uniqueSkins?: boolean
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

/**
 * A named starting point for the weekly format vote — BATL's "1x40" and
 * "2x20".
 *
 * These live in the profile rather than in the UI because they are league
 * convention, not a fact about ACSM: another league's shorthand is its own, and
 * a preset hardcoded in a button is exactly the thing the design check in the
 * header of this file is for. They are only starting points — every field stays
 * editable afterwards, because the whole reason this screen exists is that the
 * racers change them (plan §4.2).
 */
export interface FormatPreset extends RaceFormat {
  /** What the league calls it. Shown on the button. */
  name: string
}

/**
 * Where the bot posts.
 *
 * Here rather than in the environment because a channel id is league
 * configuration, not a secret — reviewable in git, and the same for everyone
 * running this league's bot. The token is the secret and stays in
 * `CHAMPCTL_DISCORD_TOKEN`; nothing in a profile should ever be worth hiding.
 */
export interface DiscordSettings {
  /**
   * Channel the nightly gridmom report posts into.
   *
   * An *admin* channel, and that is a requirement rather than a naming
   * convention. Findings quote the entry list, so they carry driver names —
   * `entry.duplicate-pit-box` names whose boxes collide, and the sign-up checks
   * name applicants who can't join. None of it is secret, since the export is
   * public (plan §5.3), but "these three people are about to be dropped from
   * the grid" is not a thing to say in front of the league before anyone has
   * looked at it.
   */
  adminChannelId?: string
  /**
   * Channel announcements and standings go into. The league's channel, not the
   * admins' — this is the one drivers read.
   *
   * Separate from `adminChannelId` rather than defaulting to it, because the
   * two carry different things: gridmom quotes the entry list and names who is
   * about to be dropped from the grid, and an announcement says the race is on
   * Wednesday. Falling back to one channel would put the first kind in front of
   * the league the first time somebody forgot to set the second.
   */
  announceChannelId?: string
  /**
   * Which parts of an announcement champctl says.
   *
   * Configurable because ACSM has its own Discord integration and BATL already
   * has it switched on, so some of this is said twice by default. Which parts
   * overlap depends on how that integration is configured, which champctl
   * cannot see — so the league decides rather than champctl guessing.
   *
   * Absent means all of them.
   */
  announce?: AnnounceParts
}

/** Each part of an announcement, on unless a league turns it off. */
export interface AnnounceParts {
  /** The track and the round number. */
  track?: boolean
  /** Quali time in league-local wall clock, with the date. */
  quali?: boolean
  /** The voted format, named as the league's own shorthand where one matches. */
  format?: boolean
  /** A link to the championship page, which is where sign-ups are. */
  signUp?: boolean
}

export interface LeagueProfile {
  id: string
  name: string
  /** Base URL of the league's ACSM, used by the read client and CLI. */
  acsmBaseUrl?: string
  schedule: ScheduleDefaults
  entryList: EntryListPolicy
  baseline: Baseline
  /** Named format shorthands, offered as one-tap starting points in the UI. */
  formats?: FormatPreset[]
  /** Where `champctl-bot` posts. Absent means the league has no bot. */
  discord?: DiscordSettings
  /**
   * League furniture: cars that are always there and never worth a finding.
   *
   * BATL's Ford Transit, which runs in every race for the stream. Naming a
   * model here means "this is ours, stop telling me about it", and champctl
   * takes that literally — `entry.model-not-available` and
   * `grid.race-setup-cars` both forgive it, whatever `SpectatorCarEnabled`
   * says. That is a deliberate widening: the second check only forgave
   * `SpectatorCar.Model`, which is `""` on BATL's exports, so the same van was
   * reported once per round on every championship for ever. Five warnings that
   * are noise cost more than the one case they were guarding, because the
   * value of the report is that people read it.
   *
   * Forgiven for being *present*, never required to be. A model listed here
   * and absent from a car list is not a finding.
   */
  excludedCarModels?: string[]
}
