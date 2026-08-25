/**
 * Championship-level checks (plan §6.5).
 */

import { DateTime } from "luxon"

import { classes, events, isZeroTime, slots, trackLabel } from "../../acsm/view.js"
import type { Check } from "../context.js"
import { MESSAGE_LOCALE, humanList, pluralize } from "../finding.js"

export const dropScoresExceedRounds: Check = {
  id: "champ.ignore-worst",
  section: "6.5",
  run(ctx, emit) {
    const ignore = ctx.championship.IgnoreXWorstEvents ?? 0
    if (ignore === 0) return
    const n = events(ctx.championship).length
    if (ignore < n) return

    emit(
      "WARN",
      "champ.ignore-worst",
      `The championship drops each driver's worst ${ignore} ${pluralize(ignore, "result")} but only has ${n} ${pluralize(n, "round")}, so ${ignore === n ? "everything gets dropped" : "more gets dropped than exists"}.`,
      { path: "IgnoreXWorstEvents" },
      { ignoreXWorstEvents: ignore, events: n },
    )
  },
}

export const pointsShorterThanGrid: Check = {
  id: "champ.points-places",
  section: "6.5",
  run(ctx, emit) {
    const maxClients = Math.max(
      0,
      ...events(ctx.championship).map((ev) => ev.RaceSetup?.MaxClients ?? 0),
    )
    if (maxClients === 0) return

    classes(ctx.championship).forEach((cls, i) => {
      const places = cls.Points?.Places
      if (!Array.isArray(places) || places.length === 0) return
      if (places.length >= maxClients) return

      const name = cls.Name ?? `class ${i + 1}`
      const shortfall = maxClients - places.length
      emit(
        "WARN",
        "champ.points-places",
        `${name} pays points down to ${places.length}th but up to ${maxClients} cars can start, so the last ${shortfall} ${pluralize(shortfall, "finisher")} can't score.`,
        { className: name, path: `Classes[${i}].Points.Places` },
        { places: places.length, maxClients },
      )
    })
  },
}

export const repeatedTrack: Check = {
  id: "champ.repeated-track",
  section: "6.5",
  run(ctx, emit) {
    const byTrack = new Map<string, string[]>()
    events(ctx.championship).forEach((ev, i) => {
      const track = trackLabel(ev.RaceSetup)
      if (!track) return
      const bucket = byTrack.get(track)
      if (bucket) bucket.push(`round ${i + 1}`)
      else byTrack.set(track, [`round ${i + 1}`])
    })

    for (const [track, rounds] of byTrack) {
      if (rounds.length < 2) continue
      emit(
        "WARN",
        "champ.repeated-track",
        `${track} shows up ${rounds.length} times in this championship, at ${humanList(rounds)}.`,
        { path: "Events[].RaceSetup.Track" },
        { track, rounds },
      )
    }
  },
}

export const acsrContradiction: Check = {
  id: "champ.acsr",
  section: "6.5",
  run(ctx, emit) {
    const c = ctx.championship
    if (c.ACSR !== true && c.ExportSecondRaceToACSR === true) {
      emit(
        "INFO",
        "champ.acsr-export",
        `Second races are set to export to ACSR, but ACSR is switched off.`,
        { path: "ExportSecondRaceToACSR" },
      )
    }
    if (c.ACSR === true) {
      const gates = (["ACSRSkillGate", "ACSRSafetyGate"] as const).filter(
        (k) => (c[k] ?? "") === "",
      )
      if (gates.length > 0) {
        emit(
          "INFO",
          "champ.acsr-gates",
          `ACSR is on but ${humanList(gates.map(gateName))} ${pluralize(gates.length, "has", "have")} no value set.`,
          { path: "ACSRSkillGate" },
          { gates },
        )
      }
    }
  },
}

function gateName(k: string): string {
  return k === "ACSRSkillGate" ? "the skill gate" : "the safety gate"
}

export const descriptionMentionsOtherTracks: Check = {
  id: "champ.description-tracks",
  section: "6.5",
  run(ctx, emit) {
    const description = ctx.championship.Description ?? ""
    if (!description.trim()) return

    const scheduled = events(ctx.championship)
      .map((ev) => (ev.RaceSetup?.Track ?? "").trim())
      .filter(Boolean)
    if (scheduled.length === 0) return

    // Track folder names are unfriendly, so compare on their word-ish parts.
    const haystack = description.toLowerCase()
    const missing = scheduled.filter((t) => !mentions(haystack, t))
    if (missing.length === 0 || missing.length === scheduled.length) return

    emit(
      "INFO",
      "champ.description-tracks",
      `The description doesn't mention ${humanList(missing)}, which ${pluralize(missing.length, "is", "are")} on the schedule.`,
      { path: "Description" },
      { missing },
    )
  },
}

/**
 * Whether a description plausibly names a track folder.
 *
 * The word filter is there so `ks_barcelona_gp` isn't matched on `ks` or `gp`,
 * which appear across half of Kunos's content. But `>= 4` also emptied the
 * word list for short folder names — `spa` is three characters — and an empty
 * list returns true, so this check could never report the one track a BATL
 * season is most likely to run. Three is the shortest folder name that is a
 * name rather than a prefix.
 */
function mentions(haystack: string, track: string): boolean {
  const words = track
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && w !== "track")
  if (words.length === 0) return true
  return words.some((w) => haystack.includes(w))
}

export const practiceNotRolledOver: Check = {
  id: "champ.next-practice",
  section: "6.5",
  run(ctx, emit) {
    if (ctx.championship.StartNextPracticeOnEventComplete === false) {
      emit(
        "WARN",
        "champ.next-practice",
        `Practice for the next round won't start automatically when an event finishes.`,
        { path: "StartNextPracticeOnEventComplete" },
      )
    }
  },
}

export const signUpDeadlinePassed: Check = {
  id: "champ.signup-deadline",
  section: "6.5",
  run(ctx, emit) {
    const form = ctx.championship.SignUpForm
    if (!form?.Enabled) return
    const closes = form.RegistrationClosesAt
    if (isZeroTime(closes)) return

    const zone = ctx.profile.schedule.timezone
    const deadline = DateTime.fromISO(closes!, { setZone: true }).setLocale(MESSAGE_LOCALE)
    if (!deadline.isValid) return
    const now = DateTime.fromJSDate(ctx.now, { zone }).setLocale(MESSAGE_LOCALE)
    if (deadline >= now) return

    emit(
      "INFO",
      "champ.signup-deadline",
      `Sign-ups are still switched on, but registration closed ${deadline.setZone(zone).toRelative({ base: now })}.`,
      { path: "SignUpForm.RegistrationClosesAt" },
      { closesAt: deadline.toISO() },
    )
  },
}

/**
 * Contradictions the import test surfaced (plan §5.5): settings left over from
 * a template that describe a feature the championship has switched off.
 */
export const signUpFormLeftovers: Check = {
  id: "champ.signup-leftovers",
  section: "6.5",
  run(ctx, emit) {
    const form = ctx.championship.SignUpForm
    if (!form || form.Enabled) return
    const extras = Array.isArray(form.ExtraFields) ? form.ExtraFields.length : 0
    if (extras === 0) return

    emit(
      "INFO",
      "champ.signup-leftovers",
      `Sign-ups are switched off but the form still carries ${extras} extra ${pluralize(extras, "question")} from whatever it was copied from.`,
      { path: "SignUpForm.ExtraFields" },
      { extraFields: extras },
    )
  },
}

/**
 * `Created` inherited from a template makes a championship claim to predate
 * itself. Cheap to catch, and it was a real emitter bug (plan §5.5).
 */
export const createdBeforeItsOwnEvents: Check = {
  id: "champ.created-after-events",
  section: "6.5",
  run(ctx, emit) {
    const created = ctx.championship.Created
    if (isZeroTime(created)) return
    const createdAt = DateTime.fromISO(created!, { setZone: true }).setLocale(MESSAGE_LOCALE)
    if (!createdAt.isValid) return

    const scheduledTimes = events(ctx.championship)
      .flatMap((ev) => {
        if (isZeroTime(ev.Scheduled)) return []
        const d = DateTime.fromISO(ev.Scheduled!, { setZone: true })
        return d.isValid ? [d] : []
      })
      .sort((a, b) => a.toMillis() - b.toMillis())
    const earliest = scheduledTimes[0]
    if (!earliest) return

    // A year of slack; this is looking for a template stamp, not a close call.
    if (createdAt.plus({ years: 1 }) >= earliest) return

    emit(
      "INFO",
      "champ.created-after-events",
      `The championship says it was created ${createdAt.toFormat("d LLLL yyyy")}, well before its first round on ${earliest.toFormat("d LLLL yyyy")} — probably inherited from whatever it was copied from.`,
      { path: "Created" },
      { created: createdAt.toISO(), firstEvent: earliest.toISO() },
    )
  },
}

export const noEntrants: Check = {
  id: "champ.empty",
  section: "6.5",
  run(ctx, emit) {
    if (events(ctx.championship).length === 0) {
      emit("WARN", "champ.no-events", `This championship has no events.`, { path: "Events" })
      return
    }
    const anyEntrants =
      classes(ctx.championship).some((cls) => slots(cls.Entrants).length > 0) ||
      events(ctx.championship).some((ev) => slots(ev.EntryList).length > 0)
    if (!anyEntrants) {
      emit("WARN", "champ.no-entrants", `This championship has no entry list at all.`, {
        path: "Classes[].Entrants",
      })
    }
  },
}

export const championshipChecks: readonly Check[] = [
  dropScoresExceedRounds,
  pointsShorterThanGrid,
  repeatedTrack,
  acsrContradiction,
  descriptionMentionsOtherTracks,
  practiceNotRolledOver,
  signUpDeadlinePassed,
  signUpFormLeftovers,
  createdBeforeItsOwnEvents,
  noEntrants,
]
