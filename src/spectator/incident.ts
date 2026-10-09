/**
 * Turns a collision in a recorder journal into an incident packet: what each
 * car was doing in the seconds around the contact, in the terms a steward
 * argues in — who was ahead, when they were alongside, who braked where, who
 * moved across whom, where on each car they touched.
 *
 * Everything here is measured from the recording. Nothing judges fault; that
 * is the steward's call; `rules.ts` only suggests one.
 */

import { readJournal, type JournalRecord } from "./journal.js"
import { BRAKE_LIGHTS, type CarState, type Vec3 } from "./protocol.js"
import { DEFAULT_THRESHOLDS, type IncidentThresholds } from "./thresholds.js"
import type { Track } from "./track.js"

/** Seconds of recording kept before and after the contact. */
export const WINDOW = { before: 8, after: 3 }
/** Timeline resolution, seconds. */
const STEP_S = 0.2
/** Longer than any gap between two samples of a car that is still connected. */
const MAX_GAP_MS = 1000

export interface CollisionSummary {
  index: number
  /** Recorder clock, ms. */
  at: number
  carId: number
  otherCarId?: number
  impactSpeedKmh: number
  /** Contact point in the reporting car's frame, as the server passed it on. */
  relPos: Vec3
  drivers: string[]
}

export interface CarMeta {
  carId: number
  driver: string
  model: string
}

export interface CarFrame {
  /** Meters along the racing line from the start line. */
  s: number
  speedKmh: number
  /** Meters off the racing line: positive toward the left edge. */
  lateralM: number
  /** Meters from the middle of the track: positive toward the left edge. */
  acrossM: number
  /** Meters beyond the track edge, 0 when on track. */
  offTrackM: number
  braking: boolean
  /** 0–1, or null where the network didn't carry it. */
  gas: number | null
  steer: number
  gear: number
  pos: Vec3
  yaw: number
}

export interface TimelineRow {
  /** Seconds relative to the contact. */
  t: number
  a: CarFrame | null
  b: CarFrame | null
  /** Meters B is ahead of A along the line (negative: behind). */
  gapM: number | null
  /** Meters between the two cars, center to center. */
  separationM: number | null
}

export interface IncidentPacket {
  session: { track: string; trackConfig: string; name: string; type: number }
  collision: CollisionSummary & { where: string }
  /** A is the car the server reports as hitting; B is the car it hit. */
  a: CarMeta
  b: CarMeta
  timeline: TimelineRow[]
  measured: Measurements
  facts: string[]
}

export { DEFAULT_THRESHOLDS, type IncidentThresholds } from "./thresholds.js"

export type Side = "a" | "b"

export interface Move {
  /** Meters sideways across the track over the lookback, positive to the left. */
  movedM: number
  overS: number
  /** Toward the other car, rather than away from it. */
  toward: boolean
  /** Whether the car's brake lights were on for any of it. */
  braking: boolean
}

/**
 * Numbers the facts and the rules engine are both built from. Every time is
 * in seconds relative to the contact, negative before it.
 */
export interface Measurements {
  /** The earliest moment both cars were recorded. */
  start: { t: number; leader: Side; gapM: number; gapS: number; s: number } | null
  /** Seconds before contact (negative) from which they overlapped without a break. */
  overlapFromT: number | null
  contact: { t: number; gapM: number; separationM: number; a: CarFrame; b: CarFrame } | null
  braking: Record<Side, { t: number; s: number; speedKmh: number } | null> & {
    /** Which car braked further down the road, and by how much. */
    later: { car: Side; m: number } | null
  }
  /**
   * The other car's position when the car ahead reached the turn-in of the
   * contact's corner. Null when nobody had turned in by the contact.
   */
  turnIn: {
    corner: string
    t: number
    leader: Side
    behindM: number
    overlapping: boolean
    /**
     * How far the car ahead moved across the track toward the other in the
     * lookback before it reached the turn-in, negative for away: a move
     * before the corner is a block, not a turn-in.
     */
    leaderMovedM: number
  } | null
  /** The car ahead throughout the lookback, or null if they swapped places in it. */
  lookbackLeader: Side | null
  moves: Record<Side, Move | null>
  /** Coming back from well beyond the track edge during the lookback. */
  rejoining: Record<Side, { maxOffM: number } | null>
  contactPoint: string
  /** Whether car A was recorded at all in the window. */
  haveA: boolean
}

type SessionRecord = JournalRecord & { t: "session" }
type CollisionRecord = JournalRecord & { t: "collision" }

export async function listCollisions(journal: string): Promise<CollisionSummary[]> {
  const names = new Map<number, string>()
  const out: CollisionSummary[] = []
  for await (const r of readJournal(journal)) {
    if (r.t === "car" && r.driver) names.set(r.carId, r.driver)
    if (r.t === "collision") out.push(summarize(r, out.length, names))
  }
  return out
}

function summarize(
  r: CollisionRecord,
  index: number,
  names: Map<number, string>,
): CollisionSummary {
  const drivers = [names.get(r.carId) ?? `car ${r.carId}`]
  if (r.otherCarId !== undefined) drivers.push(names.get(r.otherCarId) ?? `car ${r.otherCarId}`)
  return {
    index,
    at: r.at,
    carId: r.carId,
    ...(r.otherCarId === undefined ? {} : { otherCarId: r.otherCarId }),
    impactSpeedKmh: r.impactSpeed * 3.6,
    relPos: r.relPos,
    drivers,
  }
}

export async function buildIncident(
  journal: string,
  index: number,
  track: Track,
  thresholds: IncidentThresholds = DEFAULT_THRESHOLDS,
): Promise<IncidentPacket> {
  const collisions = await listCollisions(journal)
  const collision = collisions[index]
  if (!collision)
    throw new Error(`${journal} has ${collisions.length} collisions; there is no #${index}`)
  if (collision.otherCarId === undefined) {
    throw new Error(
      `collision #${index} is ${collision.drivers[0]} hitting the scenery, not another car`,
    )
  }
  const ids = [collision.carId, collision.otherCarId] as const
  const from = collision.at - WINDOW.before * 1000 - MAX_GAP_MS
  const to = collision.at + WINDOW.after * 1000 + MAX_GAP_MS

  let session: SessionRecord | undefined
  const meta = new Map<number, CarMeta>()
  const samples = new Map<number, CarState[]>(ids.map((id) => [id, []]))
  for await (const r of readJournal(journal)) {
    if (r.t === "session") session ??= r
    else if (r.t === "car" && (ids as readonly number[]).includes(r.carId)) {
      const prev = meta.get(r.carId)
      meta.set(r.carId, {
        carId: r.carId,
        driver: r.driver || prev?.driver || "",
        model: r.model || prev?.model || "",
      })
    } else if (r.t === "pos" && r.at >= from && r.at <= to) samples.get(r.car.carId)?.push(r.car)
  }
  if (!session) throw new Error(`${journal} has no session record`)
  for (const list of samples.values()) list.sort((x, y) => x.timestamp - y.timestamp)

  const sample = framer(track)
  const timeline: TimelineRow[] = []
  for (let t = -WINDOW.before; t <= WINDOW.after + 1e-9; t += STEP_S) {
    const at = collision.at + t * 1000
    const a = sample(samples.get(ids[0])!, at, ids[0])
    const b = sample(samples.get(ids[1])!, at, ids[1])
    timeline.push({
      t: Math.round(t * 10) / 10,
      a,
      b,
      gapM: a && b ? track.gap(a.s, b.s) : null,
      separationM: a && b ? Math.hypot(a.pos[0] - b.pos[0], a.pos[2] - b.pos[2]) : null,
    })
  }

  const nameOf = (id: number): CarMeta =>
    meta.get(id) ?? { carId: id, driver: `car ${id}`, model: "" }
  const a = nameOf(ids[0])
  const b = nameOf(ids[1])
  const measured = measure(
    timeline,
    track,
    thresholds,
    collision.relPos,
    (samples.get(ids[0]) ?? []).length > 0,
  )
  // The facts count from the closest approach, which can be a moment before
  // the report; the timeline counts from the same moment.
  const shift = timeline.find((r) => measured.contact && r.a === measured.contact.a)?.t ?? 0
  for (const r of timeline) r.t = Math.round((r.t - shift) * 10) / 10
  const atContact = measured.contact?.a ?? timeline.find((r) => r.t === 0)?.a
  const where = atContact ? track.where(atContact.s) : "unknown"
  const packet: IncidentPacket = {
    session: {
      track: session.track,
      trackConfig: session.trackConfig,
      name: session.name,
      type: session.type,
    },
    collision: { ...collision, where },
    a,
    b,
    timeline,
    measured,
    facts: [],
  }
  packet.facts = describe(packet, track, thresholds)
  return packet
}

/** Whether the car's previous sample before this frame was a gap ago. */
function gapBefore(list: CarState[], i: number, at: number): boolean {
  const p = list[i]
  const prev = list[i - 1]
  return (
    p !== undefined &&
    at >= p.timestamp &&
    prev !== undefined &&
    p.timestamp - prev.timestamp > MAX_GAP_MS
  )
}

/** Interpolates a car's samples at a time, projected onto the track. */
function framer(track: Track): (list: CarState[], at: number, carId: number) => CarFrame | null {
  const hints = new Map<number, number>()
  return (list, at, carId) => {
    let i = 0
    while (i < list.length - 1 && list[i + 1]!.timestamp <= at) i++
    const p = list[i]
    const q = list[Math.min(i + 1, list.length - 1)]
    if (!p || !q) return null
    // No reading for this moment: before the car's first sample, after its
    // last, or inside a gap. Holding a stale pose would invent evidence.
    if (
      at < p.timestamp - MAX_GAP_MS / 2 ||
      at > q.timestamp + MAX_GAP_MS / 2 ||
      (q.timestamp - p.timestamp > MAX_GAP_MS && at > p.timestamp + MAX_GAP_MS / 2)
    ) {
      hints.delete(carId)
      return null
    }
    const w =
      q.timestamp === p.timestamp
        ? 0
        : Math.max(0, Math.min(1, (at - p.timestamp) / (q.timestamp - p.timestamp)))
    const lerp = (u: Vec3, v: Vec3): Vec3 => [
      u[0] + (v[0] - u[0]) * w,
      u[1] + (v[1] - u[1]) * w,
      u[2] + (v[2] - u[2]) * w,
    ]
    const pos = lerp(p.pos, q.pos)
    const vel = lerp(p.vel, q.vel)
    // A hint from before a gap can be further back than the search window
    // reaches, so a gap means a fresh search over the whole line.
    if (gapBefore(list, i, at)) hints.delete(carId)
    const near = hints.get(carId)
    const proj = track.project(pos, near)
    hints.set(carId, proj.index)
    const k = w < 0.5 ? p : q
    return {
      s: proj.s,
      speedKmh: Math.hypot(vel[0], vel[2]) * 3.6,
      lateralM: proj.lateral,
      acrossM: proj.across,
      offTrackM: proj.offTrack,
      braking: (k.statusFlags & BRAKE_LIGHTS) !== 0,
      gas: k.gas ?? null,
      steer: k.steer,
      gear: k.gear,
      pos,
      yaw: k.rot[0],
    }
  }
}

/** The reported contact can trail the real one by a network delay; the closest approach this near it is the contact. */
const CONTACT_SEARCH_S = 0.4
/** Braking that ended longer ago than this before the contact was for something else. */
const BRAKING_RELEVANT_S = 3
/** Brake lights off for no longer than this are still the same braking. */
const BRAKE_BLIP_S = 0.4
/** Beyond the edge by less than this is a car using a kerb, not a car rejoining. */
const REJOIN_MARGIN_M = 1
/** How much closer to the track a car must have come to count as coming back. */
const REJOIN_RETURN_M = 0.3

export function measure(
  rows: readonly TimelineRow[],
  track: Track,
  th: IncidentThresholds,
  relPos: Vec3,
  haveA: boolean,
): Measurements {
  const both = rows.filter((r) => r.a && r.b && r.gapM !== null)
  // The report arrives after the contact, never before it.
  const near = both.filter((r) => r.t <= 1e-9 && r.t >= -CONTACT_SEARCH_S - 1e-9)
  // Nothing recorded of both cars that close to the report: any other row
  // would be measuring a moment that wasn't the contact.
  const contactRow =
    near.length > 0
      ? near.reduce((best, r) => (r.separationM! < best.separationM! ? r : best))
      : undefined
  const t0 = contactRow?.t ?? 0
  const rel = (t: number): number => Math.round((t - t0) * 10) / 10
  const before = both.filter((r) => r.t <= t0)
  const leaderOf = (r: TimelineRow): Side => (r.gapM! > 0 ? "b" : "a")
  const first = both[0]

  const start = first
    ? {
        t: rel(first.t),
        leader: leaderOf(first),
        gapM: Math.abs(first.gapM!),
        gapS: Math.abs(first.gapM!) / Math.max(1, first.a!.speedKmh / 3.6),
        s: first.a!.s,
      }
    : null

  // Rows either side of a hole in either car's recording aren't continuous:
  // nothing says what happened between them.
  const adjacent = (later: TimelineRow, earlier: TimelineRow): boolean =>
    later.t - earlier.t <= STEP_S + 1e-9

  let overlapFromT: number | null = null
  for (let i = before.length - 1; i >= 0 && Math.abs(before[i]!.gapM!) < th.overlapM; i--) {
    if (i < before.length - 1 && !adjacent(before[i + 1]!, before[i]!)) break
    overlapFromT = rel(before[i]!.t)
  }

  const contact =
    contactRow?.a && contactRow.b
      ? {
          t: 0,
          gapM: contactRow.gapM!,
          separationM: contactRow.separationM!,
          a: contactRow.a,
          b: contactRow.b,
        }
      : null

  // The braking that led into the contact: the last run of brake lights
  // before it, back to where that run began.
  const lastBraking = (key: Side) => {
    let i = before.length - 1
    while (i >= 0 && !before[i]![key]!.braking) i--
    if (i < 0 || before[i]!.t < t0 - BRAKING_RELEVANT_S) return null
    // Back to where the run began, across blips of the lights shorter than
    // BRAKE_BLIP_S: modulating the pedal isn't a new braking point.
    for (
      let j = i - 1;
      j >= 0 && before[i]!.t - before[j]!.t <= BRAKE_BLIP_S + STEP_S + 1e-9;
      j--
    ) {
      if (before[j]![key]!.braking) i = j
    }
    const r = before[i]!
    return { t: rel(r.t), s: r[key]!.s, speedKmh: r[key]!.speedKmh }
  }
  const brakeA = lastBraking("a")
  const brakeB = lastBraking("b")
  const laterGap = brakeA && brakeB ? track.gap(brakeB.s, brakeA.s) : 0
  const braking = {
    a: brakeA,
    b: brakeB,
    later:
      brakeA && brakeB && Math.abs(laterGap) >= 2
        ? { car: (laterGap > 0 ? "a" : "b") as Side, m: Math.abs(laterGap) }
        : null,
  }

  const recent = before.filter((r) => r.t >= t0 - th.lookbackS)
  const leaders = new Set(recent.map(leaderOf))
  const lookbackLeader = leaders.size === 1 ? [...leaders][0]! : null

  // Turn-in: the first moment before the contact that whichever car was
  // ahead then had reached the corner's turn-in point.
  let turnIn: Measurements["turnIn"] = null
  const contactS = contact?.a.s
  const corner =
    contactS === undefined
      ? undefined
      : track.corners.find(
          (c) => track.gap(c.entry - 60, contactS) >= 0 && track.gap(contactS, c.exit) >= 0,
        )
  if (corner) {
    const i = before.findIndex((x) => track.gap(corner.entry, x[leaderOf(x)]!.s) >= 0)
    const r = before[i]
    const prev = before[i - 1]
    // Only a row straight after one short of the entry is the moment of
    // reaching it; after a hole, or at the window's start, it's somewhere past.
    if (r && prev && adjacent(r, prev)) {
      const behindM = Math.abs(r.gapM!)
      const leader = leaderOf(r)
      const follower: Side = leader === "a" ? "b" : "a"
      // Up to the row before the turn-in: by the turn-in row itself a car
      // is already into the corner's own move.
      const from = before.find((x) => x.t >= Math.min(prev.t, t0 - th.lookbackS))!
      const moved = prev[leader]!.acrossM - from[leader]!.acrossM
      const toward = Math.sign(moved) === Math.sign(prev[follower]!.acrossM - from[leader]!.acrossM)
      turnIn = {
        corner: corner.name,
        t: rel(r.t),
        leader,
        behindM,
        overlapping: behindM < th.overlapM,
        leaderMovedM: toward ? Math.abs(moved) : -Math.abs(moved),
      }
    }
  }

  const move = (key: Side): Move | null => {
    const other: Side = key === "a" ? "b" : "a"
    const r0 = recent[0]
    const r1 = recent[recent.length - 1]
    if (!r0 || !r1 || r0 === r1) return null
    const movedM = r1[key]!.acrossM - r0[key]!.acrossM
    return {
      movedM,
      overS: Math.round((r1.t - r0.t) * 10) / 10,
      toward: Math.sign(movedM) === Math.sign(r1[other]!.acrossM - r0[key]!.acrossM),
      braking: recent.some((r) => r[key]!.braking),
    }
  }

  const rejoin = (key: Side): { maxOffM: number } | null => {
    const offs = recent.map((r) => r[key]!.offTrackM)
    const maxOffM = Math.max(0, ...offs)
    const last = offs[offs.length - 1] ?? 0
    return maxOffM >= REJOIN_MARGIN_M && last <= maxOffM - REJOIN_RETURN_M ? { maxOffM } : null
  }

  return {
    start,
    overlapFromT,
    contact,
    braking,
    turnIn,
    lookbackLeader,
    moves: { a: move("a"), b: move("b") },
    rejoining: { a: rejoin("a"), b: rejoin("b") },
    contactPoint: describeRel(relPos),
    haveA,
  }
}

const round = (v: number): number => Math.round(v)
const one = (v: number): string => (Math.round(v * 10) / 10).toString()

/** Plain sentences about the incident, each one checkable against the timeline. */
function describe(p: IncidentPacket, track: Track, th: IncidentThresholds): string[] {
  const name = { a: p.a.driver || `car ${p.a.carId}`, b: p.b.driver || `car ${p.b.carId}` }
  const A = name.a
  const B = name.b
  const m = p.measured
  const facts: string[] = []
  if (!m.haveA || !m.contact) {
    facts.push(
      "The recording doesn't cover both cars at the moment of contact, so their positions are partly unknown.",
    )
  }
  facts.push(
    `The server reported ${A} hitting ${B} at ${p.collision.where}, at an impact speed of ${round(p.collision.impactSpeedKmh)} km/h.`,
  )
  if (m.start) {
    const lead = name[m.start.leader]
    const trail = name[m.start.leader === "a" ? "b" : "a"]
    facts.push(
      `${Math.abs(m.start.t)} s before contact (${track.where(m.start.s)}), ${lead} was ahead of ${trail} by ${round(m.start.gapM)} m, about ${one(m.start.gapS)} s.`,
    )
  }
  const overlapRow =
    m.overlapFromT === null ? undefined : p.timeline.find((r) => r.t === m.overlapFromT)
  facts.push(
    overlapRow?.a
      ? `They overlapped, within ${th.overlapM} m of each other along the track (about a wheelbase), from ${Math.abs(m.overlapFromT!)} s before contact (${track.where(overlapRow.a.s)}).`
      : `They never overlapped before contact (never within ${th.overlapM} m of each other along the track): one was behind the other.`,
  )
  if (m.contact) {
    const c = m.contact
    facts.push(
      `At contact ${c.gapM > 0 ? B : A} was ${one(Math.abs(c.gapM))} m further along the track; the cars were ${one(c.separationM)} m apart, center to center.`,
    )
    const side = (f: CarFrame): string =>
      Math.abs(f.lateralM) < 0.3
        ? "on the racing line"
        : `${one(Math.abs(f.lateralM))} m ${f.lateralM >= 0 ? "left" : "right"} of the racing line`
    facts.push(`At contact ${A} was ${side(c.a)} and ${B} was ${side(c.b)}.`)
    facts.push(
      c.b.acrossM > c.a.acrossM ? `${B} was to the left of ${A}.` : `${A} was to the left of ${B}.`,
    )
    for (const key of ["a", "b"] as const) {
      if (c[key].offTrackM > 0)
        facts.push(`${name[key]} was ${one(c[key].offTrackM)} m beyond the track edge at contact.`)
    }
    facts.push(
      `Speeds at contact: ${A} ${round(c.a.speedKmh)} km/h, ${B} ${round(c.b.speedKmh)} km/h.`,
    )
  }
  for (const key of ["a", "b"] as const) {
    const b = m.braking[key]
    facts.push(
      b
        ? `${name[key]} began braking for the contact's corner ${Math.abs(b.t)} s before contact (${track.where(b.s)}), doing ${round(b.speedKmh)} km/h.`
        : `${name[key]} showed no brake lights in the ${BRAKING_RELEVANT_S} s before contact.`,
    )
  }
  if (m.braking.later) {
    const later = m.braking.later
    facts.push(
      `${name[later.car]} started braking ${round(later.m)} m further down the road than ${name[later.car === "a" ? "b" : "a"]}.`,
    )
  } else if (m.braking.a && m.braking.b)
    facts.push("They started braking within 2 m of the same point.")
  if (m.turnIn) {
    const t = m.turnIn
    const lead = name[t.leader]
    const other = name[t.leader === "a" ? "b" : "a"]
    facts.push(
      t.overlapping
        ? `When ${lead} reached the turn-in point of ${t.corner}, ${other} was overlapping, ${one(t.behindM)} m back along the track.`
        : `When ${lead} reached the turn-in point of ${t.corner}, ${other} was ${one(t.behindM)} m behind, not overlapping.`,
    )
  }
  for (const key of ["a", "b"] as const) {
    const mv = m.moves[key]
    if (!mv) continue
    const other = name[key === "a" ? "b" : "a"]
    facts.push(
      Math.abs(mv.movedM) < th.holdM
        ? `${name[key]} held their position on the track in the last ${one(mv.overS)} s (moved ${one(Math.abs(mv.movedM))} m across it).`
        : `${name[key]} moved ${one(Math.abs(mv.movedM))} m ${mv.movedM > 0 ? "left" : "right"} across the track in the last ${one(mv.overS)} s, ${mv.toward ? "toward" : "away from"} ${other}${mv.braking ? ", under braking" : ""}.`,
    )
  }
  for (const key of ["a", "b"] as const) {
    const r = m.rejoining[key]
    if (r) {
      facts.push(
        `${name[key]} was coming back onto the track before the contact, having been up to ${one(r.maxOffM)} m beyond the edge in the last ${th.lookbackS} s.`,
      )
    }
  }
  facts.push(`${A}'s game placed the contact on ${A}'s ${m.contactPoint}.`)
  return facts
}

/**
 * The contact point in the reporting car's frame, in words. Read as x across
 * with left positive and z along with front positive: AC's own axes, but not
 * yet checked against a contact a real game reported.
 */
export function describeRel([x, , z]: Vec3): string {
  const fore = z > 0.5 ? "front" : z < -0.5 ? "rear" : ""
  const side = x > 0.3 ? "left" : x < -0.3 ? "right" : ""
  if (fore && side) return `${fore}-${side}`
  if (fore) return `${fore} center`
  if (side) return `${side} side`
  return "center"
}
