/**
 * Practice and quali length: the two numbers, beside the quali start, that
 * decide when a race night begins and when its race does.
 *
 * Kept out of `RaceFormat`, which is what a league votes on and what the bot
 * compares; nobody votes on how long practice runs.
 */

import { SESSION_KEY_ALIASES, type ChampionshipEvent, type SessionKey } from "../acsm/types.js"
import { session } from "../acsm/view.js"

export interface SessionLengths {
  practiceMinutes: number
  qualiMinutes: number
}

/**
 * The lengths a round runs, null for a session it doesn't have.
 *
 * A length of 0 reads as the league's, because that is how `Scheduled` is
 * worked out (`practiceMinutesFor`) and how gridmom reads it. Reporting the 0
 * would describe a practice no other part of champctl believes in.
 */
export function sessionLengthsOf(
  ev: ChampionshipEvent,
  defaults: SessionLengths,
): { practice: number | null; quali: number | null } {
  const length = (key: SessionKey, fallback: number): number | null => {
    const s = session(ev, key)
    if (!s) return null
    return typeof s.Time === "number" && s.Time > 0 ? s.Time : fallback
  }
  return {
    practice: length("Practice", defaults.practiceMinutes),
    quali: length("Qualifying", defaults.qualiMinutes),
  }
}

/**
 * The event with these lengths on the sessions it has.
 *
 * A session the event doesn't have stays absent: a round with no practice is
 * a choice someone made, and a length is no reason to invent one.
 */
export function withSessionLengths(
  ev: ChampionshipEvent,
  lengths: Partial<SessionLengths>,
): ChampionshipEvent {
  const sessions = { ...(ev.RaceSetup?.Sessions ?? {}) }
  const wanted: [SessionKey, number | undefined][] = [
    ["Practice", lengths.practiceMinutes],
    ["Qualifying", lengths.qualiMinutes],
  ]
  for (const [key, minutes] of wanted) {
    const keys = Object.keys(sessions).filter((s) =>
      SESSION_KEY_ALIASES[key].includes(s.trim().toLowerCase()),
    )
    if (minutes !== undefined) for (const k of keys) sessions[k] = { ...sessions[k], Time: minutes }
  }
  return { ...ev, RaceSetup: { ...ev.RaceSetup, Sessions: sessions } }
}
