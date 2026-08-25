/**
 * Schedule checks (plan §6.2).
 *
 * The load-bearing fact: `Scheduled` is *practice* start, not quali start.
 *   Scheduled = qualiStart − practiceDuration
 * Suzuka is scheduled 19:00 -07:00 with a 60 minute practice ahead of an 8PM
 * quali. Everything below derives from that.
 *
 * All arithmetic happens in the league's wall-clock zone and is then compared,
 * because November crosses a DST boundary and the stored offset differs either
 * side (plan §4.3).
 */

import { DateTime } from "luxon"

import type { ChampionshipEvent } from "../../acsm/types.js"
import { eventHasStarted, eventLabel, events, isZeroTime, session } from "../../acsm/view.js"
import type { Check, CheckContext } from "../context.js"
import { humanList } from "../finding.js"

/** Parses `Scheduled` into the league zone, preserving the instant. */
function scheduledAt(ev: ChampionshipEvent, zone: string): DateTime | undefined {
  if (isZeroTime(ev.Scheduled)) return undefined
  const dt = DateTime.fromISO(ev.Scheduled!, { setZone: true })
  return dt.isValid ? dt.setZone(zone) : undefined
}

/** Practice duration in minutes, from the event if set, else the profile. */
function practiceMinutes(ev: ChampionshipEvent, ctx: CheckContext): number {
  const t = session(ev, "Practice")?.Time
  return typeof t === "number" && t > 0 ? t : ctx.profile.schedule.practiceMinutes
}

const HHMM = "HH:mm"

export const scheduledDisagreesWithQuali: Check = {
  id: "schedule.derived-start",
  section: "6.2",
  run(ctx, emit) {
    const { timezone, qualiStart } = ctx.profile.schedule

    events(ctx.championship).forEach((ev, i) => {
      if (eventHasStarted(ev)) return
      const scheduled = scheduledAt(ev, timezone)
      if (!scheduled) return

      const practice = practiceMinutes(ev, ctx)
      // The event doesn't record quali start directly, so reconstruct it from
      // Scheduled and compare against the league's default quali time.
      const derivedQuali = scheduled.plus({ minutes: practice })
      const [h, m] = qualiStart.split(":").map(Number)
      const expectedQuali = scheduled.set({ hour: h, minute: m, second: 0, millisecond: 0 })

      const driftMinutes = Math.round(derivedQuali.diff(expectedQuali, "minutes").minutes)
      if (driftMinutes === 0) return

      const label = eventLabel(ev, i + 1)
      const expectedScheduled = expectedQuali.minus({ minutes: practice })
      emit(
        "WARN",
        "schedule.derived-start",
        `${cap(label)} starts practice at ${scheduled.toFormat(HHMM)}, which puts quali at ${derivedQuali.toFormat(HHMM)} rather than the usual ${qualiStart}; for a ${practice} minute practice it should be scheduled ${expectedScheduled.toFormat(HHMM)}.`,
        { round: i + 1, event: label, path: `Events[${i}].Scheduled` },
        {
          scheduled: scheduled.toISO(),
          practiceMinutes: practice,
          derivedQualiStart: derivedQuali.toFormat(HHMM),
          expectedQualiStart: qualiStart,
          expectedScheduled: expectedScheduled.toISO(),
          driftMinutes,
        },
      )
    })
  },
}

export const wrongWeekday: Check = {
  id: "schedule.weekday",
  section: "6.2",
  run(ctx, emit) {
    const { timezone, weekday } = ctx.profile.schedule
    const expectedName = DateTime.fromObject({ weekday }, { zone: timezone }).toFormat("cccc")

    events(ctx.championship).forEach((ev, i) => {
      if (eventHasStarted(ev)) return
      const scheduled = scheduledAt(ev, timezone)
      if (!scheduled) return
      if (scheduled.weekday === weekday) return
      // A per-event override with a stated reason is legitimate (plan §4.3).
      if (hasOverrideNote(ev)) return

      const label = eventLabel(ev, i + 1)
      emit(
        "WARN",
        "schedule.weekday",
        `${cap(label)} is on a ${scheduled.toFormat("cccc")} rather than the usual ${expectedName}, and nothing says why.`,
        { round: i + 1, event: label, path: `Events[${i}].Scheduled` },
        { scheduled: scheduled.toISO(), weekday: scheduled.weekday, expectedWeekday: weekday },
      )
    })
  },
}

/** Looks for a reason recorded on the event, wherever the tool chose to put it. */
function hasOverrideNote(ev: ChampionshipEvent): boolean {
  for (const key of ["ScheduleNote", "Note", "Description"] as const) {
    const v = (ev as Record<string, unknown>)[key]
    if (typeof v === "string" && v.trim()) return true
  }
  return false
}

export const twoEventsSameNight: Check = {
  id: "schedule.collision",
  section: "6.2",
  run(ctx, emit) {
    const { timezone } = ctx.profile.schedule
    const byDay = new Map<string, { round: number; label: string }[]>()

    events(ctx.championship).forEach((ev, i) => {
      const scheduled = scheduledAt(ev, timezone)
      if (!scheduled) return
      const day = scheduled.toISODate()!
      const label = eventLabel(ev, i + 1)
      const bucket = byDay.get(day)
      if (bucket) bucket.push({ round: i + 1, label })
      else byDay.set(day, [{ round: i + 1, label }])
    })

    for (const [day, evs] of byDay) {
      if (evs.length < 2) continue
      emit(
        "WARN",
        "schedule.collision",
        `${humanList(evs.map((e) => e.label))} are all scheduled for ${DateTime.fromISO(day).toFormat("cccc d LLLL")}.`,
        { path: "Events[].Scheduled" },
        { date: day, rounds: evs.map((e) => e.round) },
      )
    }
  },
}

export const scheduledInThePast: Check = {
  id: "schedule.past",
  section: "6.2",
  run(ctx, emit) {
    const { timezone } = ctx.profile.schedule
    const now = DateTime.fromJSDate(ctx.now, { zone: timezone })

    events(ctx.championship).forEach((ev, i) => {
      if (eventHasStarted(ev)) return
      const scheduled = scheduledAt(ev, timezone)
      if (!scheduled || scheduled >= now) return

      const label = eventLabel(ev, i + 1)
      emit(
        "WARN",
        "schedule.past",
        `${cap(label)} was due to run ${scheduled.toRelative({ base: now })} and never started.`,
        { round: i + 1, event: label, path: `Events[${i}].Scheduled` },
        { scheduled: scheduled.toISO() },
      )
    })
  },
}

export const missingScheduledServer: Check = {
  id: "schedule.missing-server",
  section: "6.2",
  run(ctx, emit) {
    const evs = events(ctx.championship)
    const withServer = evs.filter((ev) => (ev.ScheduledServerID ?? "").trim())
    if (withServer.length === 0 || withServer.length === evs.length) return

    evs.forEach((ev, i) => {
      if ((ev.ScheduledServerID ?? "").trim()) return
      if (eventHasStarted(ev)) return
      // Only meaningful for events that are actually scheduled.
      if (isZeroTime(ev.Scheduled)) return

      const label = eventLabel(ev, i + 1)
      emit(
        "WARN",
        "schedule.missing-server",
        `${cap(label)} has no server assigned, while the other events do.`,
        { round: i + 1, event: label, path: `Events[${i}].ScheduledServerID` },
      )
    })
  },
}

export const dstBoundaryCrossing: Check = {
  id: "schedule.dst",
  section: "6.2",
  run(ctx, emit) {
    const { timezone } = ctx.profile.schedule
    const offsets = new Map<number, { round: number; label: string }[]>()

    events(ctx.championship).forEach((ev, i) => {
      const scheduled = scheduledAt(ev, timezone)
      if (!scheduled) return
      const label = eventLabel(ev, i + 1)
      const bucket = offsets.get(scheduled.offset)
      if (bucket) bucket.push({ round: i + 1, label })
      else offsets.set(scheduled.offset, [{ round: i + 1, label }])
    })

    if (offsets.size < 2) return
    const described = [...offsets]
      .sort((a, b) => b[0] - a[0])
      .map(([off, evs]) => `${humanList(evs.map((e) => e.label))} at UTC${formatOffset(off)}`)

    emit(
      "INFO",
      "schedule.dst",
      `The clocks change part way through this championship: ${described.join(", ")}.`,
      { path: "Events[].Scheduled" },
      { offsets: [...offsets.keys()] },
    )
  },
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+"
  const abs = Math.abs(minutes)
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export const scheduleChecks: readonly Check[] = [
  scheduledDisagreesWithQuali,
  wrongWeekday,
  twoEventsSameNight,
  scheduledInThePast,
  missingScheduledServer,
  dstBoundaryCrossing,
]
