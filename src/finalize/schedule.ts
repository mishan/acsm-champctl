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
 * How many distinct instants a local wall-clock time corresponds to in a zone.
 *
 * One, almost always. Zero in the gap where clocks go forward — that time
 * never happens. Two in the overlap where they go back — it happens twice.
 *
 * Works by candidate *offsets* rather than by assuming a shift size. Take the
 * wall clock as though it were UTC, subtract each of the offsets in force a
 * day either side of it, and keep whichever candidate instants render back to
 * the wall clock that was asked for.
 *
 * The obvious alternative — "add the shift and see whether the wall clock
 * repeats" — has to pick a number, and an hour is only the *usual* shift. Lord
 * Howe Island moves by 30 minutes, so an hour-based test misses its overlap
 * completely; historical zones have used 20 and 40. Probing the offsets asks
 * tzdata instead of guessing.
 */
export function localTimeCandidates(date: string, time: string, zone: string): DateTime[] {
  const wanted = time.slice(0, 5)

  // The wall clock as a UTC instant. Not a real moment — just arithmetic.
  const asUtc = DateTime.fromISO(`${date}T${wanted}`, { zone: "utc" })
  if (!asUtc.isValid) return []

  // Offsets in force well either side, which brackets any transition that
  // night whatever its size or direction.
  const probe = DateTime.fromISO(`${date}T12:00`, { zone })
  if (!probe.isValid) return []
  const offsets = new Set([probe.minus({ days: 1 }).offset, probe.plus({ days: 1 }).offset])

  const found = new Map<number, DateTime>()
  for (const offset of offsets) {
    const candidate = DateTime.fromMillis(asUtc.toMillis() - offset * 60_000, { zone })
    if (candidate.toFormat("yyyy-MM-dd") === date && candidate.toFormat("HH:mm") === wanted) {
      found.set(candidate.toMillis(), candidate)
    }
  }
  return [...found.values()].sort((a, b) => a.toMillis() - b.toMillis())
}

/**
 * Parses a league-local `YYYY-MM-DD` and `HH:mm` into a zoned instant.
 *
 * Refuses the two wall-clock times a zone cannot answer for, because Luxon
 * answers both silently and the answer is a race starting somewhere other than
 * where someone put it.
 *
 * **Nonexistent** — the gap where clocks go forward. Luxon shifts the time
 * forward rather than failing. Verified, not assumed.
 *
 * **Ambiguous** — the overlap where they go back. Luxon picks the earlier of
 * the two without saying so.
 *
 * A league race is unlikely to be scheduled in either window. "Unlikely" is
 * not a reason to write the wrong time without saying so.
 */
export function qualiStartFrom(date: string, time: string, zone: string): DateTime {
  // Strict shapes, checked before anything is parsed.
  //
  // Everything downstream works in `HH:mm` — `localTimeCandidates` compares
  // against `time.slice(0, 5)` — so a looser input isn't rejected, it is
  // silently reinterpreted. Measured: "20:00:30" quietly lost its seconds, and
  // "20:00+05:00" quietly lost its *offset*, scheduling 8pm Pacific for
  // someone who asked for 8pm UTC. A seven-hour error with no warning is far
  // worse than being told the format is wrong.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ScheduleError(`${JSON.stringify(date)} is not a date. Use YYYY-MM-DD.`)
  }
  if (!/^\d{2}:\d{2}$/.test(time)) {
    throw new ScheduleError(
      `${JSON.stringify(time)} is not a time. Use HH:mm, as ${zone}'s wall clock — no seconds, ` +
        `and no trailing Z or offset, which would be ignored rather than honoured.`,
    )
  }

  const dt = DateTime.fromISO(`${date}T${time}`, { zone })
  if (!dt.isValid) {
    throw new ScheduleError(
      `${date} ${time} is not a valid date and time in ${zone}: ${dt.invalidReason ?? "unknown"}`,
    )
  }

  const candidates = localTimeCandidates(date, time, zone)

  if (candidates.length === 0) {
    throw new ScheduleError(
      `${date} ${time} does not exist in ${zone} — the clocks go forward that night and skip ` +
        `over it. It would land at ${dt.toFormat("yyyy-MM-dd HH:mm")}. Pick a time either side ` +
        `of the change.`,
    )
  }

  if (candidates.length > 1) {
    const [first, second] = candidates as [DateTime, DateTime]
    const apart = Math.round((second.toMillis() - first.toMillis()) / 60_000)
    throw new ScheduleError(
      `${date} ${time} happens twice in ${zone} — the clocks go back that night, so this ` +
        `wall-clock time is ambiguous: it could mean either of two instants ${apart} minutes ` +
        `apart (${first.toFormat("ZZ")} or ${second.toFormat("ZZ")}). Pick a time outside the ` +
        `repeated period.`,
    )
  }

  return candidates[0] as DateTime
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
 *
 * **The ambiguity check belongs here too, not only on the input.**
 * `qualiStartFrom` refuses a wall clock the zone can't answer for, but the
 * value this function renders is `Scheduled` — practice start — which is quali
 * *minus the practice length*. Subtracting from an unambiguous instant can land
 * inside the repeated hour: on 2026-11-01 in America/Los_Angeles a quali at
 * 02:00 is unambiguous, and 60 minutes earlier renders as "01:00", which
 * happens twice that night. The form carries a bare wall clock plus a zone name
 * and nothing that says which of the two, so ACSM resolves it itself — Go's
 * `ParseInLocation` takes the first match — and the race lands an hour from
 * where it was put, with the write reporting success. Validating the input and
 * then transmitting something else derived from it is how that got missed.
 */
export function scheduleFormValues(
  scheduled: DateTime,
  zone: string,
  recurrence: string,
): ScheduleFormValues {
  // Checked before anything is formatted. Luxon's `toFormat` on an invalid
  // DateTime returns the *string* "Invalid DateTime" rather than throwing, so
  // an unsupported zone — a profile typo, most likely — would post
  // `event-schedule-date=Invalid DateTime` and the same again for the time.
  // The ambiguity check below cannot catch it either: `localTimeCandidates`
  // gives up and returns an empty list for a zone it can't probe, which reads
  // as "unambiguous" here.
  if (!scheduled.isValid) {
    throw new ScheduleError(
      `Refusing to send an invalid date and time to ACSM: ${scheduled.invalidReason ?? "unknown"}` +
        `${scheduled.invalidExplanation ? ` (${scheduled.invalidExplanation})` : ""}.`,
    )
  }
  const local = scheduled.setZone(zone)
  if (!local.isValid) {
    throw new ScheduleError(
      `${JSON.stringify(zone)} is not a timezone this system knows, so the race time cannot be ` +
        `worked out: ${local.invalidReason ?? "unknown"}. The league profile's ` +
        `\`schedule.timezone\` needs an IANA name such as "America/Los_Angeles".`,
    )
  }

  const date = local.toFormat("yyyy-MM-dd")
  const time = local.toFormat("HH:mm")

  // Only the overlap is reachable here: `local` is a real instant, so the wall
  // clock it renders as exists by construction. One candidate is the normal
  // case; the gap (zero candidates) cannot arise.
  const candidates = localTimeCandidates(date, time, zone)
  if (candidates.length > 1) {
    const [first, second] = candidates as [DateTime, DateTime]
    const apart = Math.round((second.toMillis() - first.toMillis()) / 60_000)
    throw new ScheduleError(
      `Refusing to send ${date} ${time} as the practice start: the clocks go back in ${zone} ` +
        `that night, so that wall clock happens twice — ${apart} minutes apart ` +
        `(${first.toFormat("ZZ")} or ${second.toFormat("ZZ")}) — and the schedule form has no ` +
        `way to say which one is meant. Move quali far enough either side of the change that ` +
        `the practice start lands outside the repeated period.`,
    )
  }

  return {
    [SCHEDULE_FIELD.date]: date,
    [SCHEDULE_FIELD.time]: time,
    [SCHEDULE_FIELD.timezone]: zone,
    [SCHEDULE_FIELD.recurrence]: recurrence,
  }
}
