/**
 * The week's announcement (plan §7).
 *
 * Plan §7 says this comes "from the tool's own schedule table, not ACSM".
 * There is no such table and there should not be one: the export already
 * carries `Scheduled`, champctl already knows that `Scheduled = qualiStart −
 * practiceDuration` (docs/acsm-write-path.md), and a second copy of the
 * calendar is a second thing to be wrong. If the announcement and the manager
 * ever disagree about when the race is, the manager is what the server actually
 * runs — so the manager is what gets read.
 *
 * Not gridmom's voice. gridmom nags about mistakes; this is the league saying
 * what is on, and the two arriving in the same tone would make the nagging
 * easier to ignore.
 */

import { DateTime } from "luxon"

import type { Championship, ChampionshipEvent } from "../acsm/types.js"
import { eventHasStarted, events, trackLabel } from "../acsm/view.js"
import { championshipPath } from "../acsm/paths.js"
import { describeLength, readFormat, sameFormat, type RaceFormat } from "../finalize/format.js"
import { currentQualiStart, practiceMinutesFor } from "../finalize/schedule.js"
import { MESSAGE_LOCALE } from "../gridmom/finding.js"
import type { AnnounceParts, LeagueProfile } from "../profile/types.js"

export interface AnnounceOptions {
  profile: LeagueProfile
  /** Where the championship lives, for the sign-up link. */
  baseUrl?: string
  /** 1-based, as a league counts rounds. Without it, the next unraced round. */
  round?: number
  /** Injected so "the next round" is deterministic under test. */
  now?: Date
}

export interface Announcement {
  /** 1-based round number. */
  round: number
  content: string
}

/** Why there is nothing to announce. Not a failure — usually a finished season. */
export class NothingToAnnounce extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NothingToAnnounce"
  }
}

/** Every part on, which is what a profile with no `announce` block means. */
const ALL_PARTS: Required<AnnounceParts> = { track: true, quali: true, format: true, signUp: true }

export function partsFor(profile: LeagueProfile): Required<AnnounceParts> {
  return { ...ALL_PARTS, ...(profile.discord?.announce ?? {}) }
}

/**
 * The next round that hasn't been raced, 1-based.
 *
 * By schedule order rather than array order would be wrong: the array *is* the
 * running order, and a reorder moves what a round is between the slots while
 * the dates stay put (see `src/reorder/`). Round 2 is the second element, and
 * that stays true whatever its date says.
 */
export function nextRound(c: Championship): number | undefined {
  const all = events(c)
  for (let i = 0; i < all.length; i++) {
    if (!eventHasStarted(all[i]!)) return i + 1
  }
  return undefined
}

/**
 * What the league calls this format, if it calls it anything.
 *
 * BATL votes in terms of "1x40" and "2x20", so an announcement that says "40
 * minutes with a mandatory stop" is describing the thing people just voted on
 * in words they did not use. Falls back to the plain description for a format
 * no preset matches, which is most of them — the presets are starting points
 * and the racers change them (plan §4.2).
 */
export function describeFormat(format: RaceFormat, profile: LeagueProfile): string {
  const preset = (profile.formats ?? []).find((p) => sameFormat(p, format))
  if (preset) return preset.name

  const bits = [describeLength(format.length)]
  if (format.reversedGridPositions > 0) {
    bits.push(`reversed grid top ${format.reversedGridPositions}`)
  }
  if (format.mandatoryPit) bits.push("mandatory pit stop")
  return bits.join(", ")
}

export function announce(c: Championship, options: AnnounceOptions): Announcement {
  const all = events(c)
  if (all.length === 0) throw new NothingToAnnounce("This championship has no rounds.")

  const round = options.round ?? nextRound(c)
  if (round === undefined) {
    throw new NothingToAnnounce("Every round has been raced. Nothing left to announce.")
  }
  if (round < 1 || round > all.length) {
    throw new NothingToAnnounce(`There is no round ${round} — this championship has ${all.length}.`)
  }

  const ev = all[round - 1]!
  // A raced round is refused rather than announced in the past tense. An
  // explicit --round is usually a typo for the one beside it, and "this week at
  // Suzuka" about a race that happened is worse than an error.
  if (eventHasStarted(ev) && options.round !== undefined) {
    throw new NothingToAnnounce(`Round ${round} has already been raced.`)
  }

  const parts = partsFor(options.profile)
  const lines: string[] = [heading(c, ev, round, parts)]

  const detail = [
    parts.quali ? qualiLine(ev, options.profile) : undefined,
    parts.format ? `Format: ${describeFormat(readFormat(ev), options.profile)}.` : undefined,
  ].filter((s): s is string => s !== undefined)
  lines.push(...detail)

  if (parts.signUp) {
    const link = signUpLink(c, options.baseUrl ?? options.profile.acsmBaseUrl)
    if (link) lines.push(`Sign up: ${link}`)
  }

  return { round, content: lines.join("\n") }
}

function heading(
  c: Championship,
  ev: ChampionshipEvent,
  round: number,
  parts: Required<AnnounceParts>,
): string {
  const name = c.Name?.trim() || "the championship"
  if (!parts.track) return `**${name} — round ${round}**`

  const track = trackLabel(ev.RaceSetup)
  return track ? `**${name} — round ${round}: ${track}**` : `**${name} — round ${round}**`
}

/**
 * Quali start in league-local wall clock.
 *
 * Derived rather than read: `Scheduled` is *practice* start, so announcing it
 * would tell everyone to turn up an hour early — which is the single most
 * likely way this message could be confidently wrong.
 */
function qualiLine(ev: ChampionshipEvent, profile: LeagueProfile): string {
  const zone = profile.schedule.timezone
  const quali = currentQualiStart(
    ev,
    zone,
    practiceMinutesFor(ev, profile.schedule.practiceMinutes),
  )
  if (!quali || !quali.isValid) return "Quali time not set yet."

  // Locale pinned for the same reason gridmom pins it: the prose around the
  // date is English, so a host running under LANG=de_DE must not produce
  // "Mittwoch" in the middle of an English sentence.
  const when = quali.setLocale(MESSAGE_LOCALE).toFormat("cccc d LLLL")
  return `Quali ${quali.setLocale(MESSAGE_LOCALE).toFormat("HH:mm")} on ${when}.`
}

function signUpLink(c: Championship, baseUrl: string | undefined): string | undefined {
  if (!baseUrl || !c.ID) return undefined
  return `${baseUrl.replace(/\/+$/, "")}${championshipPath(c.ID)}`
}

/** The timezone is named once, at the end, rather than on every line. */
export function withZoneNote(content: string, profile: LeagueProfile): string {
  const zone = profile.schedule.timezone
  const abbr = DateTime.now().setZone(zone).setLocale(MESSAGE_LOCALE).toFormat("ZZZZ")
  return `${content}\n-# All times ${abbr}.`
}
