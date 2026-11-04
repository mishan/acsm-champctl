/**
 * The event screen's draft, and the request it implies.
 *
 * Its own module rather than part of `EventEditor.tsx` because it is the rule
 * about *what may be pushed*, and a rule that decides whether a write happens
 * should be testable without rendering anything. A `.tsx` file also cannot be
 * imported by the node test project without turning on JSX for it, which is a
 * lot of configuration to reach a pure function.
 */

import type { PlanRequest } from "./api.js"

/** The form as typed: strings, because that is what inputs hold. */
export interface Draft {
  /**
   * Where the round runs, as the pickers hold it.
   *
   * `track` is always filled from the round; `layout` is `""` both for a track
   * with one layout and for a round that never had one set. The screen tells
   * those apart with the layout index, not with this.
   */
  track: string
  layout: string
  /** The round's track and layout as they arrived, so a no-op stays a no-op. */
  venueWas: { track: string; layout: string }
  lengthKind: "laps" | "minutes"
  laps: string
  minutes: string
  reversed: string
  mandatoryPit: boolean
  extraLap: boolean
  qualiDate: string
  qualiTime: string
  practiceMinutes: string
  qualiMinutes: string
  /** The round's own lengths, null for a session it doesn't run. */
  lengthsWas: { practice: number | null; quali: number | null }
}

/**
 * The draft as a preview request, or null while it isn't one.
 *
 * Returning null rather than substituting a default is the point. A half-typed
 * lap count is not an instruction, and previewing one would show a confident
 * diff for a race nobody asked for.
 */
export function requestFrom(draft: Draft): PlanRequest | null {
  const length = Number(draft.lengthKind === "laps" ? draft.laps : draft.minutes)
  if (!Number.isInteger(length) || length < 1) return null

  const reversed = Number(draft.reversed)
  if (!Number.isInteger(reversed) || reversed < 0) return null

  // A half-filled wall clock is an invalid draft, not a smaller request.
  //
  // Both blank is an unscheduled round and means "leave the schedule alone".
  // One blank used to mean the same thing: the quali change was dropped and the
  // rest of the format previewed cleanly, so the screen showed a date the push
  // was never going to apply and a button happy to apply it. Returning null
  // instead puts it on the same footing as a lap count of "abc" — no plan, and
  // nothing to push until the field is finished.
  const qualiDate = draft.qualiDate.trim()
  const qualiTime = draft.qualiTime.trim()
  if (Boolean(qualiDate) !== Boolean(qualiTime)) return null

  // A track is required, so a blank one is a half-typed form rather than a
  // request to move nowhere.
  const track = draft.track.trim()
  if (!track) return null

  const lengths = lengthsOf(draft)
  if (!lengths) return null

  return {
    ...(draft.lengthKind === "laps" ? { laps: length } : { minutes: length }),
    reversedGridPositions: reversed,
    mandatoryPit: draft.mandatoryPit,
    extraLap: draft.extraLap,
    ...(qualiDate && qualiTime ? { quali: { date: qualiDate, time: qualiTime } } : {}),
    ...venueOf(draft),
    ...lengths,
  }
}

/**
 * The session lengths that changed, or null while one is half-typed.
 *
 * Only a session the round runs: one it doesn't has no field on screen, and
 * the server refuses a length for it.
 */
function lengthsOf(draft: Draft): Pick<PlanRequest, "practiceMinutes" | "qualiMinutes"> | null {
  const out: Pick<PlanRequest, "practiceMinutes" | "qualiMinutes"> = {}
  const fields = [
    ["practiceMinutes", draft.practiceMinutes, draft.lengthsWas.practice],
    ["qualiMinutes", draft.qualiMinutes, draft.lengthsWas.quali],
  ] as const
  for (const [key, typed, was] of fields) {
    if (was === null) continue
    const minutes = minutesFrom(typed)
    if (minutes === null) return null
    if (minutes !== was) out[key] = minutes
  }
  return out
}

/** At least a minute: to everything that reads the export, 0 means "the league default". */
function minutesFrom(typed: string): number | null {
  const n = Number(typed.trim() || "x")
  return Number.isInteger(n) && n >= 1 ? n : null
}

/** When each session starts, as `HH:mm`. */
export interface Night {
  practice: string | null
  quali: string
  /** Approximate: a quali running over, and the race's own wait, push it later. */
  race: string | null
}

/**
 * The race night the draft describes, for the screen to show before anything
 * is previewed. Wall-clock arithmetic only: the server works out the real
 * instants, in the league's zone, and that is what gets pushed.
 */
export function nightFrom(draft: Draft): Night | null {
  const m = /^(\d{2}):(\d{2})$/.exec(draft.qualiTime.trim())
  if (!m) return null
  const quali = Number(m[1]) * 60 + Number(m[2])
  const practice = draft.lengthsWas.practice === null ? null : minutesFrom(draft.practiceMinutes)
  const qualiLength = draft.lengthsWas.quali === null ? null : minutesFrom(draft.qualiMinutes)
  if (draft.lengthsWas.practice !== null && practice === null) return null
  if (draft.lengthsWas.quali !== null && qualiLength === null) return null
  return {
    practice: practice === null ? null : clock(quali - practice),
    quali: clock(quali),
    race: qualiLength === null ? null : clock(quali + qualiLength),
  }
}

function clock(minutes: number): string {
  const day = 24 * 60
  const m = ((minutes % day) + day) % day
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`
}

/**
 * The move, when there is one.
 *
 * Sent only when it differs from what the round arrived with. Sending it every
 * time would be harmless on the server — planFinalize compares against the
 * export and drops a no-op — but it would mean every preview of a lap-count
 * change asked to write the track too, and the server would then refuse the
 * whole preview for a round whose layout is *already* wrong. The screen has to
 * be able to show that round before it can offer to fix it.
 */
function venueOf(draft: Draft): { venue?: { track: string; layout: string } } {
  const track = draft.track.trim()
  const layout = draft.layout.trim()
  if (track === draft.venueWas.track && layout === draft.venueWas.layout) return {}
  return { venue: { track, layout } }
}
