/**
 * Turning a list of tracks into race nights (plan §5.1 step 3).
 *
 * One round per track, in order, on the league's weekday at the league's quali
 * time, with a per-round date override for the week something moves.
 *
 * All of the timezone care lives in `finalize/schedule.ts` and is reused rather
 * than reimplemented — `Scheduled` is practice start rather than quali start,
 * the maths happens in league wall-clock time, and the two wall-clock times a
 * zone can't answer for are refused. Having a second copy of that here is
 * exactly how the two flows would drift into disagreeing about what 8pm means
 * on the first Wednesday in November.
 */

import { DateTime } from "luxon"

import {
  qualiStartFrom,
  scheduledFromQuali,
  ScheduleError,
} from "../finalize/schedule.js"
import type { LeagueProfile } from "../profile/types.js"

export interface RoundSchedule {
  round: number
  /** League-local quali start, for display. */
  qualiStart: string
  /** What goes in `Scheduled` — practice start, as an ISO instant. */
  scheduled: string
  /** True when a per-round override moved it off the weekday rule. */
  overridden: boolean
  note?: string
}

export interface RoundDateSpec {
  date?: string
  dateNote?: string
}

/**
 * Race nights for a month.
 *
 * Rounds land on consecutive occurrences of the league's weekday, starting at
 * `startDate` if given and otherwise at the next one from `from`. A round with
 * its own `date` takes it and does **not** shift the rounds after it — the
 * week a race moves is a one-off, and pushing the rest of the season back a
 * week because of it would be a surprise nobody asked for.
 */
export function monthSchedule(
  rounds: readonly RoundDateSpec[],
  profile: LeagueProfile,
  startDate?: string,
  from: DateTime = DateTime.now(),
): RoundSchedule[] {
  const { weekday, qualiStart, timezone, practiceMinutes } = profile.schedule

  const first = startDate
    ? isoDateOrThrow(startDate, timezone)
    : nextWeekday(from.setZone(timezone), weekday)

  let generated = first
  return rounds.map((round, i) => {
    // Every generated round sits a week after the previous *generated* one —
    // advanced whether or not this round overrides its date, so an override
    // doesn't drag the rest of the month along with it.
    if (i > 0) generated = generated.plus({ weeks: 1 })
    const useDate = round.date ?? generated.toFormat("yyyy-MM-dd")

    const quali = qualiStartFrom(useDate, qualiStart, timezone)
    const scheduled = scheduledFromQuali(quali, practiceMinutes)

    return {
      round: i + 1,
      qualiStart: quali.toISO() ?? "",
      scheduled: scheduled.toISO() ?? "",
      overridden: round.date !== undefined,
      ...(round.dateNote === undefined ? {} : { note: round.dateNote }),
    }
  })
}

/** The next occurrence of `weekday`, including today. */
export function nextWeekday(from: DateTime, weekday: number): DateTime {
  const delta = (weekday - from.weekday + 7) % 7
  return from.plus({ days: delta }).startOf("day")
}

function isoDateOrThrow(date: string, zone: string): DateTime {
  const dt = DateTime.fromISO(date, { zone })
  if (!dt.isValid) {
    throw new ScheduleError(`${date} is not a usable start date: ${dt.invalidReason ?? "unknown"}`)
  }
  return dt.startOf("day")
}
