/**
 * A suggested call on an incident, from fixed rules over the measurements.
 *
 * Deterministic and free on purpose: the bot can post one with every ticket,
 * the same incident always gets the same answer, and a steward can see which
 * rule fired and check its numbers. The rules are the conventions most sim
 * leagues share; when none clearly applies the answer is "unclear", never a
 * guess, because the decision is a human steward's either way.
 */

import type { IncidentPacket, IncidentThresholds, Measurements, Side } from "./incident.js"

export type Call = "A" | "B" | "racing incident" | "unclear"

export interface Suggestion {
  call: Call
  /** The rule that decided it, or undefined when none did. */
  rule?: RuleId
  reasons: string[]
}

export type RuleId =
  | "rejoin"
  | "braking-zone-move"
  | "no-overlap-at-turn-in"
  | "moved-across"
  | "both-moved"
  | "from-behind"

const other = (s: Side): Side => (s === "a" ? "b" : "a")
const callFor = (s: Side): Call => (s === "a" ? "A" : "B")
const one = (v: number): string => (Math.round(v * 10) / 10).toString()

interface Rule {
  id: RuleId
  apply(m: Measurements, th: IncidentThresholds, name: Record<Side, string>): Suggestion | undefined
}

const moved = (m: Measurements, s: Side, th: IncidentThresholds): boolean => {
  const mv = m.moves[s]
  return mv?.toward === true && Math.abs(mv.movedM) >= th.moveM
}
const held = (m: Measurements, s: Side, th: IncidentThresholds): boolean => {
  const mv = m.moves[s]
  return mv !== null && Math.abs(mv.movedM) < th.holdM
}

/** In order: the first that applies decides. */
const RULES: readonly Rule[] = [
  {
    // Coming back onto the track into someone is on the car coming back,
    // unless it was ahead all along and simply got hit from behind.
    id: "rejoin",
    apply(m, th, name) {
      for (const s of ["a", "b"] as const) {
        const hitFromBehind = m.overlapFromT === null && m.lookbackLeader === s && !moved(m, s, th)
        if (
          m.rejoining[s] &&
          !m.rejoining[other(s)] &&
          m.moves[s]?.toward === true &&
          !hitFromBehind
        ) {
          return {
            call: callFor(s),
            rule: "rejoin",
            reasons: [
              `${name[s]} was coming back onto the track, from up to ${one(m.rejoining[s]!.maxOffM)} m beyond the edge, into ${name[other(s)]}.`,
            ],
          }
        }
      }
      return undefined
    },
  },
  {
    // No overlap by the turn-in point: no claim to room, so yield. Ahead of the
    // move rules, because the car ahead turning in toward the apex is exactly
    // a move across the track under braking. It excuses that move and only
    // that one: not a turn-in from before the moves measured, nor a block
    // on the way to it.
    id: "no-overlap-at-turn-in",
    apply(m, th, name) {
      const t = m.turnIn
      if (
        !t ||
        t.overlapping ||
        m.lookbackLeader !== t.leader ||
        t.t < -th.lookbackS ||
        t.leaderMovedM >= th.moveM
      )
        return undefined
      const follower = other(t.leader)
      return {
        call: callFor(follower),
        rule: "no-overlap-at-turn-in",
        reasons: [
          `When ${name[t.leader]} reached the turn-in point of ${t.corner}, ${name[follower]} was ${one(t.behindM)} m back, short of an overlap (${th.overlapM} m).`,
          `${name[t.leader]} was still ahead in the last ${th.lookbackS} s, so the corner was theirs; ${name[follower]} should have yielded.`,
        ],
      }
    },
  },
  {
    // A defender may not move in the braking zone in reaction to an attacker.
    id: "braking-zone-move",
    apply(m, th, name) {
      // Only when one car was ahead throughout; a swap in the lookback means
      // there's no defender to hold to this.
      const leader = m.lookbackLeader
      if (!leader) return undefined
      const mv = m.moves[leader]
      if (!mv?.braking || !moved(m, leader, th) || !held(m, other(leader), th)) return undefined
      return {
        call: callFor(leader),
        rule: "braking-zone-move",
        reasons: [
          `${name[leader]} was ahead and moved ${one(Math.abs(mv.movedM))} m toward ${name[other(leader)]} under braking.`,
          `${name[other(leader)]} held their position on the track.`,
        ],
      }
    },
  },
  {
    // Alongside, one car moves into the other while the other holds its line.
    id: "moved-across",
    apply(m, th, name) {
      if (m.overlapFromT === null) return undefined
      for (const s of ["a", "b"] as const) {
        if (moved(m, s, th) && held(m, other(s), th)) {
          const mv = m.moves[s]!
          const reasons = [
            `They were overlapping from ${Math.abs(m.overlapFromT)} s before contact.`,
            `${name[s]} moved ${one(Math.abs(mv.movedM))} m toward ${name[other(s)]} in the last ${one(mv.overS)} s; ${name[other(s)]} held their position on the track.`,
          ]
          if (m.turnIn?.overlapping && m.turnIn.leader === s) {
            reasons.push(
              `${name[other(s)]} was overlapping at the turn-in point of ${m.turnIn.corner}, so was owed room.`,
            )
          }
          return { call: callFor(s), rule: "moved-across", reasons }
        }
      }
      return undefined
    },
  },
  {
    // Side by side and both squeezing: neither left the other room.
    id: "both-moved",
    apply(m, th, name) {
      if (m.overlapFromT === null || !moved(m, "a", th) || !moved(m, "b", th)) return undefined
      return {
        call: "racing incident",
        rule: "both-moved",
        reasons: [`${name.a} and ${name.b} both moved toward each other while overlapping.`],
      }
    },
  },
  {
    // Never alongside: the car behind ran into the car ahead.
    id: "from-behind",
    apply(m, th, name) {
      if (m.overlapFromT !== null || !m.contact) return undefined
      const behind: Side = m.contact.gapM > 0 ? "a" : "b"
      if (!held(m, other(behind), th)) return undefined
      return {
        call: callFor(behind),
        rule: "from-behind",
        reasons: [
          `They never overlapped: ${name[behind]} was behind ${name[other(behind)]} until the contact.`,
          `${name[other(behind)]} held their position on the track, so the contact was ${name[behind]} running into them.`,
        ],
      }
    },
  },
]

export function suggest(p: IncidentPacket, th: IncidentThresholds): Suggestion {
  const name = { a: p.a.driver || `car ${p.a.carId}`, b: p.b.driver || `car ${p.b.carId}` }
  if (!p.measured.contact || !p.measured.haveA) {
    return { call: "unclear", reasons: ["The recording doesn't cover both cars at the contact."] }
  }
  for (const rule of RULES) {
    const s = rule.apply(p.measured, th, name)
    if (s) return s
  }
  return {
    call: "unclear",
    reasons: ["None of the rules clearly applies; this one needs a steward to look at it."],
  }
}

/** "Bob Divebomb" for "A", and so on, for printing a suggestion. */
export function callName(call: Call, p: IncidentPacket): string {
  if (call === "A") return p.a.driver || `car ${p.a.carId}`
  if (call === "B") return p.b.driver || `car ${p.b.carId}`
  return call
}
