/**
 * Turning "quali is at 8pm" into what ACSM's schedule form wants.
 *
 * Two facts drive everything here, both from plan §4.3.
 *
 * **`Scheduled` is practice start, not quali start.** `Scheduled = qualiStart −
 * practiceDuration`. Suzuka is scheduled 19:00 for an 8pm quali with a 60
 * minute practice. Anyone reading `Scheduled` as the quali time is an hour out.
 *
 * **Wall-clock is authoritative, offsets are not.** A league races at 8pm local
 * all season; the UTC offset changes underneath it in November. So the maths is
 * done in the league's IANA zone and only rendered to an offset at the end.
 * Doing it in UTC "and adding the offset" is right for most of the year and
 * silently an hour wrong for the rest of it.
 *
 * Scheduling is also a *separate request* from the event save — the event
 * submit form does not carry `Scheduled` (plan §5.2). Changing a quali time is
 * two writes, and this module produces the second one.
 */

import { DateTime } from "luxon"

import type { ChampionshipEvent } from "../acsm/types.js"
import { session } from "../acsm/view.js"
import { isZeroTime } from "../acsm/view.js"

/** Field names captured from the real schedule form, `fixtures/recon/`. */
export const SCHEDULE_FIELD = {
  date: "event-schedule-date",
  time: "event-schedule-time",
  timezone: "event-schedule-timezone",
  recurrence: "event-schedule-recurrence",
} as const

export interface ScheduleFormValues {
  "event-schedule-date": string
  "event-schedule-time": string
  "event-schedule-timezone": string
  "event-schedule-recurrence": string
}

export class ScheduleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ScheduleError"
  }
}

/**
 * Practice length for an event, preferring what the event actually says over
 * the league default.
 *
 * The default is a fallback, not an assumption: an event with a 30 minute
 * practice would otherwise have its `Scheduled` computed from the league's 60
 * and start half an hour early.
 */
export function practiceMinutesFor(ev: ChampionshipEvent, fallbackMinutes: number): number {
  const t = session(ev, "Practice")?.Time
  return typeof t === "number" && t > 0 ? t : fallbackMinutes
}

/**
 * `Scheduled` — practice start — for a given quali start.
 *
 * `qualiStart` must already carry the league zone; this only subtracts.
 */
export function scheduledFromQuali(qualiStart: DateTime, practiceMinutes: number): DateTime {
  return qualiStart.minus({ minutes: practiceMinutes })
}

/**
 * The quali start implied by an event's current `Scheduled`.
 *
 * Returns undefined for an unscheduled event — ACSM writes Go's zero time
 * rather than omitting the field, and treating `0001-01-01` as a real date
 * produces a diff claiming the race moved by two thousand years.
 */
export function currentQualiStart(
  ev: ChampionshipEvent,
  zone: string,
  practiceMinutes: number,
): DateTime | undefined {
  if (!ev.Scheduled || isZeroTime(ev.Scheduled)) return undefined
  const dt = DateTime.fromISO(ev.Scheduled, { setZone: true })
  if (!dt.isValid) return undefined
  return dt.setZone(zone).plus({ minutes: practiceMinutes })
}

/**
 * Parses a league-local `YYYY-MM-DD` and `HH:mm` into a zoned instant.
 *
 * Refuses the two wall-clock times a zone can't answer for, because Luxon
 * answers both silently and the answer is a race an hour from where someone
 * thought they put it.
 *
 * **Nonexistent.** On a spring-forward night 02:30 never happens; Luxon shifts
 * it forward to 03:30. Verified, not assumed.
 *
 * **Ambiguous.** On a fall-back night 01:30 happens twice, and Luxon picks the
 * first. The detection is that adding an hour leaves the wall clock unchanged
 * — 01:30 PDT plus an hour is 01:30 PST — which is true only inside the
 * repeated hour.
 *
 * A league race is unlikely to be scheduled in either window. "Unlikely" is
 * not a reason to write the wrong time without saying so.
 */
export function qualiStartFrom(date: string, time: string, zone: string): DateTime {
  const dt = DateTime.fromISO(`${date}T${time}`, { zone })
  if (!dt.isValid) {
    throw new ScheduleError(
      `${date} ${time} is not a valid date and time in ${zone}: ${dt.invalidReason ?? "unknown"}`,
    )
  }

  const wanted = time.slice(0, 5)
  // Round-tripping the wall clock catches a time that got moved to make it
  // exist.
  if (dt.toFormat("yyyy-MM-dd") !== date || dt.toFormat("HH:mm") !== wanted) {
    throw new ScheduleError(
      `${date} ${time} does not exist in ${zone} — the clocks go forward that night. ` +
        `It would land at ${dt.toFormat("yyyy-MM-dd HH:mm")}. Pick a time either side of the change.`,
    )
  }

  if (dt.plus({ hours: 1 }).toFormat("HH:mm") === dt.toFormat("HH:mm")) {
    throw new ScheduleError(
      `${date} ${time} happens twice in ${zone} — the clocks go back that night, so this ` +
        `wall-clock time is ambiguous and the race could start an hour either side of what ` +
        `you meant. Pick a time outside the repeated hour.`,
    )
  }

  return dt
}

/**
 * The four fields the schedule form takes.
 *
 * The timezone goes as the IANA name, which is what the form's own select
 * offers, so ACSM resolves the offset itself rather than being handed one that
 * is only correct today.
 *
 * `recurrence` is echoed from whatever the form already had. Scheduled events
 * can repeat, champctl does not model that yet, and blanking it here would
 * quietly cancel a repeat someone set up in ACSM.
 */
export function scheduleFormValues(
  scheduled: DateTime,
  zone: string,
  recurrence: string,
): ScheduleFormValues {
  const local = scheduled.setZone(zone)
  return {
    [SCHEDULE_FIELD.date]: local.toFormat("yyyy-MM-dd"),
    [SCHEDULE_FIELD.time]: local.toFormat("HH:mm"),
    [SCHEDULE_FIELD.timezone]: zone,
    [SCHEDULE_FIELD.recurrence]: recurrence,
  }
}
