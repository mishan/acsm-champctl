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

import type { DateTime } from "luxon"

import type { Championship, ChampionshipEvent } from "../acsm/types.js"
import { eventHasResults, events, trackLabel } from "../acsm/view.js"
import { championshipPath } from "../acsm/paths.js"
import { describeLength, readFormat, sameFormat, type RaceFormat } from "../finalize/format.js"
import { currentQualiStart, practiceMinutesFor } from "../finalize/schedule.js"
import { MESSAGE_LOCALE } from "../gridmom/finding.js"
import type { AnnounceParts, LeagueProfile } from "../profile/types.js"
import { MESSAGE_LIMIT } from "./transport.js"

export interface AnnounceOptions {
  profile: LeagueProfile
  /** Where the championship lives, for the sign-up link. */
  baseUrl?: string
  /** 1-based, as a league counts rounds. Without it, the next round still ahead. */
  round?: number
  /**
   * What counts as the past. Required rather than read off the clock in here, so
   * a test cannot lean on today's date without saying so — one that did would
   * pass until its fixture dates went by, then fail on a day nobody changed
   * anything.
   */
  now: Date
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

/**
 * An explicit round that can't be announced.
 *
 * Kept apart from `NothingToAnnounce` because the two mean opposite things to
 * cron. A finished season is the ordinary end state; a round somebody asked for
 * by number and got wrong is a mistake, and reporting it as a quiet week made a
 * typo look like a successful post.
 */
export class RoundRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RoundRefused"
  }
}

/** Every part on, which is what a profile with no `announce` block means. */
const ALL_PARTS: Required<AnnounceParts> = { track: true, quali: true, format: true, signUp: true }

export function partsFor(profile: LeagueProfile): Required<AnnounceParts> {
  return { ...ALL_PARTS, ...(profile.discord?.announce ?? {}) }
}

/**
 * The next round still ahead, 1-based: the first in running order with no
 * results and a quali that hasn't gone by.
 *
 * By schedule order rather than array order would be wrong: the array *is* the
 * running order, and a reorder moves what a round is between the slots while
 * the dates stay put (see `src/reorder/`). Round 2 is the second element, and
 * that stays true whatever its date says.
 *
 * Raced means `eventHasResults`, not `eventHasStarted`. ACSM stamps an event's
 * `StartedTime` from the UDP new-session callback, so a looping practice server
 * — which BATL leaves open on the upcoming round — makes an untouched round
 * look started, and this skipped straight past it to announce the round after.
 * Wrong track and wrong date, to the channel drivers set an alarm by.
 *
 * The date is checked as well, for a round that was never raced at all — a
 * server that crashed, a round rained off. Its results never land, so on
 * results alone it stayed "next" for the rest of the season, and every weekly
 * run announced it again with a date in the past.
 */
export function nextRound(c: Championship, profile: LeagueProfile, now: Date): number | undefined {
  const all = events(c)
  for (let i = 0; i < all.length; i++) {
    const ev = all[i]!
    if (!eventHasResults(ev) && !goneBy(qualiStart(ev, profile), now)) return i + 1
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

  const round = options.round ?? nextRound(c, options.profile, options.now)
  if (round === undefined) {
    throw new NothingToAnnounce(
      "Every round has been raced or has gone by. Nothing left to announce.",
    )
  }
  if (round < 1 || round > all.length) {
    throw new RoundRefused(`There is no round ${round} — this championship has ${all.length}.`)
  }

  const ev = all[round - 1]!
  // Computed once, and it is the instant everything time-shaped hangs off:
  // the refusal below, the clock, the date, and the zone abbreviation at the end.
  const quali = qualiStart(ev, options.profile)

  // An explicit round in the past is refused rather than announced in the past
  // tense. It is usually a typo for the one beside it, and "this week at
  // Suzuka" about a race that happened is worse than an error.
  //
  // Raced is the same predicate as `nextRound`, and for the same reason: on
  // `eventHasStarted` this refused round 3 as already raced while round 3's
  // practice server was merely open.
  if (options.round !== undefined) {
    if (eventHasResults(ev)) throw new RoundRefused(`Round ${round} has already been raced.`)
    if (quali && goneBy(quali, options.now)) {
      throw new RoundRefused(`Round ${round}'s quali was ${when(quali)}, which has gone by.`)
    }
  }

  const parts = partsFor(options.profile)
  const lines: string[] = [heading(c, ev, round, parts)]

  const detail = [
    parts.quali ? qualiLine(quali) : undefined,
    parts.format ? formatLine(ev, options.profile) : undefined,
  ].filter((s): s is string => s !== undefined)
  lines.push(...detail)

  if (parts.signUp) {
    const link = signUpLink(c, options.baseUrl ?? options.profile.acsmBaseUrl)
    // The same page either way; only the label depends on whether ACSM is
    // taking sign-ups on it. Absent reads as on, since that is the only thing
    // this line ever said before the form was consulted.
    const label = c.SignUpForm?.Enabled === false ? "Details" : "Sign up"
    if (link) lines.push(`${label}: ${link}`)
  }

  const body = lines.join("\n")
  // Appended here rather than by the caller, so it cannot end up on a message
  // whose time it doesn't describe. Gated on a time having been *stated* rather
  // than merely being known: a league that turns the quali line off gets a
  // message with no clock in it, and a message with no clock has no zone to
  // qualify.
  const stated = parts.quali && quali?.isValid ? quali : undefined
  const content = stated ? withZoneNote(body, stated) : body

  // Refused rather than cut. Every other line here is bounded, so an overlong
  // announcement means an overlong championship name, and trimming it would put
  // a heading nobody wrote in front of the whole league.
  if (content.length > MESSAGE_LIMIT) {
    throw new Error(
      `The announcement is ${content.length} characters, over Discord's ${MESSAGE_LIMIT}. ` +
        `The championship name is the likely culprit.`,
    )
  }
  return { round, content }
}

/** Quali start, derived from `Scheduled`, which is practice start. */
function qualiStart(ev: ChampionshipEvent, profile: LeagueProfile): DateTime | undefined {
  return currentQualiStart(
    ev,
    profile.schedule.timezone,
    practiceMinutesFor(ev, profile.schedule.practiceMinutes),
  )
}

/** Quali has started. An unscheduled round has no date to pass, so it hasn't. */
function goneBy(quali: DateTime | undefined, now: Date): boolean {
  return quali?.isValid === true && quali.toMillis() <= now.getTime()
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
function qualiLine(quali: DateTime | undefined): string {
  if (!quali?.isValid) return "Quali time not set yet."
  return `Quali ${when(quali)}.`
}

/**
 * "20:00 on Wednesday 2 September".
 *
 * Locale pinned for the same reason gridmom pins it: the prose around the date
 * is English, so a host running under LANG=de_DE must not produce "Mittwoch"
 * in the middle of an English sentence.
 */
function when(at: DateTime): string {
  const local = at.setLocale(MESSAGE_LOCALE)
  return `${local.toFormat("HH:mm")} on ${local.toFormat("cccc d LLLL")}`
}

/**
 * The format line, or a plain "not set" for a round with no race length.
 *
 * `readFormat` reads a missing Race session, and one with neither laps nor
 * time, as zero minutes — so this posted "Format: 0 minutes." to the league
 * about a round nobody had set up yet.
 */
function formatLine(ev: ChampionshipEvent, profile: LeagueProfile): string {
  const format = readFormat(ev)
  const { length } = format
  const unset = length.kind === "laps" ? length.laps <= 0 : length.minutes <= 0
  return unset ? "Format not set yet." : `Format: ${describeFormat(format, profile)}.`
}

function signUpLink(c: Championship, baseUrl: string | undefined): string | undefined {
  if (!baseUrl || !c.ID) return undefined
  return `${baseUrl.replace(/\/+$/, "")}${championshipPath(c.ID)}`
}

/**
 * The timezone, named once at the end rather than on every line.
 *
 * **Read off the announced instant, never off the current one.** This took the
 * profile and used `DateTime.now()`, which is right for about fifty weeks of
 * the year and wrong across a clock change: a cron run in October announcing a
 * race on 4 November said "All times PDT" about a race that runs in PST. The
 * message is then an hour out, stated confidently, to the whole league — and
 * the announcement is exactly the thing people set an alarm by.
 *
 * Takes the `DateTime` rather than a zone plus an instant, because those are
 * two arguments that can disagree and this is one that cannot.
 */
export function withZoneNote(content: string, at: DateTime): string {
  return `${content}\n-# All times ${at.setLocale(MESSAGE_LOCALE).toFormat("ZZZZ")}.`
}
