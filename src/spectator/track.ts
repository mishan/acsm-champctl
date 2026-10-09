/**
 * A track's racing line, from its `ai/fast_lane.ai`, and what it lets us say
 * about a position on track: how far round the lap it is, how far off the line
 * and toward which edge, and which corner it's at.
 *
 * Layout, measured on Autopolis International (version 7, 2883 points): a
 * 16-byte header (u32 version, u32 count, 8 bytes unused), `count` points of
 * 20 bytes (x, y, z, distance along the line, u32 index), a u32 repeat of the
 * count, then 72 bytes per point. Of those 18 floats this reads three: the AI's
 * target speed (index 0) and the distance from the line to the left and right
 * edges (indices 5 and 6). One open-source parser reads 32-byte points; that
 * puts every point after the first in the wrong place.
 */

import type { Vec3 } from "./protocol.js"
import { WireReader } from "./wire.js"

export interface LinePoint {
  x: number
  y: number
  z: number
  /** Meters from the start line along the racing line. */
  s: number
  /** AI target speed, m/s. */
  speed: number
  /** Meters from the line to the track edge on each side. */
  left: number
  right: number
}

export interface Corner {
  /** "T1", "T2", ... in lap order from the start line. */
  name: string
  direction: "left" | "right"
  /** Meters along the line where it starts turning, the tightest point, and where it straightens. */
  entry: number
  apex: number
  exit: number
  /** Tightest radius, meters. */
  radius: number
}

export interface Projection {
  /** Meters along the line, 0 at the start line. */
  s: number
  /** Meters off the line: positive toward the left edge, negative toward the right. */
  lateral: number
  /** How far past the edge on that side, or 0 when on track. */
  offTrack: number
  /**
   * Meters from the middle of the track, positive to the left. Where a car is
   * on the track, as opposed to on the racing line, which itself sweeps from
   * edge to edge through every corner: a car holding its place on track is
   * still here, and one following the line is moving.
   */
  across: number
}

export function parseFastLane(buf: Buffer): LinePoint[] {
  const r = new WireReader(buf)
  const version = r.u32()
  const count = r.u32()
  if (version !== 7) throw new Error(`fast_lane.ai version ${version}; only 7 has been measured`)
  r.skip(8)
  const points: LinePoint[] = []
  for (let i = 0; i < count; i++) {
    const [x, y, z] = r.vec3()
    const s = r.f32()
    r.u32()
    points.push({ x, y, z, s, speed: 0, left: 0, right: 0 })
  }
  if (r.remaining >= 4 + count * 72 && r.u32() === count) {
    for (const p of points) {
      const extra = r.bytes(72)
      p.speed = extra.readFloatLE(0)
      p.left = extra.readFloatLE(20)
      p.right = extra.readFloatLE(24)
    }
  }
  return points
}

/** Below this radius a stretch of line is a corner. */
const CORNER_RADIUS_M = 200
/** Curvature is averaged over this much line, so a kink in the AI line isn't a corner. */
const SMOOTH_M = 30
/** Turns the same way closer together than this are one corner, like a double apex. */
const MERGE_M = 20
/** Shorter than this is a kink, not a corner. */
const MIN_CORNER_M = 15

export class Track {
  readonly points: readonly LinePoint[]
  readonly length: number
  readonly corners: readonly Corner[]
  /** Signed curvature per point, 1/m, positive turning left. */
  readonly #curvature: Float64Array

  constructor(points: readonly LinePoint[]) {
    if (points.length < 3) throw new Error("a racing line needs at least three points")
    this.points = points
    const last = points[points.length - 1]!
    const first = points[0]!
    // The line closes on itself; the last segment back to the start counts.
    this.length = last.s + Math.hypot(first.x - last.x, first.z - last.z)
    this.#curvature = this.#smoothedCurvature()
    this.corners = this.#findCorners()
  }

  #at(i: number): LinePoint {
    const n = this.points.length
    return this.points[((i % n) + n) % n]!
  }

  /** Unit forward direction at point i, in x/z. */
  #forward(i: number): [number, number] {
    const a = this.#at(i - 1)
    const b = this.#at(i + 1)
    const dx = b.x - a.x
    const dz = b.z - a.z
    const len = Math.hypot(dx, dz) || 1
    return [dx / len, dz / len]
  }

  /**
   * Left of forward (fx, fz) is (fz, -fx). Checked on Autopolis: all 4591
   * points of its side_l.csv project to this side and all of side_r.csv to
   * the other, each within 4 cm of the edge distance in fast_lane.ai. (Those
   * CSVs store z negated; nothing here reads them.)
   */
  #left(i: number): [number, number] {
    const [fx, fz] = this.#forward(i)
    return [fz, -fx]
  }

  #smoothedCurvature(): Float64Array {
    const n = this.points.length
    const raw = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const [ax, az] = this.#forward(i - 1)
      const [bx, bz] = this.#forward(i + 1)
      const turn = Math.atan2(ax * bz - az * bx, ax * bx + az * bz)
      const a = this.#at(i - 1)
      const b = this.#at(i + 1)
      const ds = Math.hypot(b.x - a.x, b.z - a.z) || 1
      // Sign flipped so positive is toward the left side defined above.
      raw[i] = -turn / ds
    }
    const out = new Float64Array(n)
    const spacing = this.length / n
    const half = Math.max(1, Math.round(SMOOTH_M / spacing / 2))
    for (let i = 0; i < n; i++) {
      let sum = 0
      for (let k = -half; k <= half; k++) sum += raw[(((i + k) % n) + n) % n]!
      out[i] = sum / (2 * half + 1)
    }
    return out
  }

  #findCorners(): Corner[] {
    const n = this.points.length
    const threshold = 1 / CORNER_RADIUS_M
    // Start scanning on a straight so no corner is split across the line.
    let start = 0
    while (start < n && Math.abs(this.#curvature[start]!) >= threshold) start++
    if (start === n) return []
    const runs: { from: number; to: number }[] = []
    let open: number | undefined
    for (let k = 0; k <= n; k++) {
      const i = (start + k) % n
      const turning = k < n && Math.abs(this.#curvature[i]!) >= threshold
      if (turning && open === undefined) open = start + k
      if (!turning && open !== undefined) {
        runs.push({ from: open, to: start + k - 1 })
        open = undefined
      }
    }
    const spacing = this.length / n
    const merged: { from: number; to: number }[] = []
    for (const run of runs) {
      const prev = merged[merged.length - 1]
      const sameWay =
        prev &&
        Math.sign(this.#curvature[prev.to % n]!) === Math.sign(this.#curvature[run.from % n]!)
      if (prev && sameWay && (run.from - prev.to) * spacing < MERGE_M) prev.to = run.to
      else merged.push({ ...run })
    }
    const corners = merged
      .filter((r) => (r.to - r.from + 1) * spacing >= MIN_CORNER_M)
      .map((r) => {
        let apex = r.from
        for (let k = r.from; k <= r.to; k++) {
          if (Math.abs(this.#curvature[k % n]!) > Math.abs(this.#curvature[apex % n]!)) apex = k
        }
        const c = this.#curvature[apex % n]!
        return {
          direction: c > 0 ? ("left" as const) : ("right" as const),
          entry: this.#at(r.from).s,
          apex: this.#at(apex).s,
          exit: this.#at(r.to).s,
          radius: 1 / Math.abs(c),
        }
      })
      .sort((a, b) => a.entry - b.entry)
    return corners.map((c, i) => ({ name: `T${i + 1}`, ...c }))
  }

  /**
   * The nearest point of the line to (x, z) and where along it that is. A
   * `near` index from the previous sample keeps a car on its own part of the
   * track where the circuit passes close to itself.
   */
  project(pos: Vec3, near?: number): Projection & { index: number } {
    const n = this.points.length
    const [x, y, z] = pos
    let best = 0
    let bestD = Infinity
    const search = near === undefined ? n : Math.min(n, 200)
    const from = near === undefined ? 0 : near - search / 2
    for (let k = 0; k < search; k++) {
      const i = (((from + k) % n) + n) % n
      const p = this.points[i]!
      // Height too, or a car on a bridge is as near the road under it.
      const d = (p.x - x) ** 2 + (p.y - y) ** 2 + (p.z - z) ** 2
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    // Refine onto the segment either side of the nearest point.
    const p = this.points[best]!
    const [fx, fz] = this.#forward(best)
    const [lx, lz] = this.#left(best)
    const along = (x - p.x) * fx + (z - p.z) * fz
    const lateral = (x - p.x) * lx + (z - p.z) * lz
    const s = (((p.s + along) % this.length) + this.length) % this.length
    const edge = lateral >= 0 ? p.left : p.right
    const offTrack = edge > 0 ? Math.max(0, Math.abs(lateral) - edge) : 0
    // Without edge data the line is all there is to measure from.
    const across = p.left + p.right > 0 ? lateral - (p.left - p.right) / 2 : lateral
    return { s, lateral, offTrack, across, index: best }
  }

  /** The line's point and edges at distance s. */
  pointAt(s: number): LinePoint & { leftEdge: [number, number]; rightEdge: [number, number] } {
    const n = this.points.length
    const target = ((s % this.length) + this.length) % this.length
    let lo = 0
    let hi = n - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.points[mid]!.s <= target) lo = mid
      else hi = mid - 1
    }
    // Between this point and the next, so nothing built on it moves in steps
    // of the point spacing.
    const a = this.points[lo]!
    const b = this.#at(lo + 1)
    const span = lo === n - 1 ? this.length - a.s : b.s - a.s
    const w = span > 0 ? Math.min(1, (target - a.s) / span) : 0
    const mix = (u: number, v: number): number => u + (v - u) * w
    const p: LinePoint = {
      x: mix(a.x, b.x),
      y: mix(a.y, b.y),
      z: mix(a.z, b.z),
      s: target,
      speed: mix(a.speed, b.speed),
      left: mix(a.left, b.left),
      right: mix(a.right, b.right),
    }
    const [lx, lz] = this.#left(lo)
    return {
      ...p,
      leftEdge: [p.x + lx * p.left, p.z + lz * p.left],
      rightEdge: [p.x - lx * p.right, p.z - lz * p.right],
    }
  }

  /** Signed distance from a to b along the lap, the short way round. */
  gap(a: number, b: number): number {
    const d = (((b - a) % this.length) + this.length) % this.length
    return d > this.length / 2 ? d - this.length : d
  }

  /**
   * Where s is, the way a steward would say it: "T3 apex", "T3, 40 m before
   * the apex", "120 m past the exit of T3".
   */
  where(s: number): string {
    const corner = this.corners.find((c) => this.#within(s, c.entry - 30, c.exit + 10))
    if (corner) {
      const toApex = this.gap(s, corner.apex)
      if (Math.abs(toApex) < 8) return `${corner.name} apex`
      return toApex > 0
        ? `${corner.name}, ${Math.round(toApex)} m before the apex`
        : `${corner.name}, ${Math.round(-toApex)} m after the apex`
    }
    if (this.corners.length === 0) return `${Math.round(s)} m into the lap`
    // Distances round the lap, so a corner whose exit wraps past the start
    // line still counts as just behind.
    const behind = (c: Corner): number => (((s - c.exit) % this.length) + this.length) % this.length
    const ahead = (c: Corner): number => (((c.entry - s) % this.length) + this.length) % this.length
    const after = this.corners.reduce((a, c) => (behind(c) < behind(a) ? c : a))
    const next = this.corners.reduce((a, c) => (ahead(c) < ahead(a) ? c : a))
    return ahead(next) < behind(after)
      ? `${Math.round(ahead(next))} m before the turn-in to ${next.name}`
      : `${Math.round(behind(after))} m past the exit of ${after.name}`
  }

  #within(s: number, from: number, to: number): boolean {
    return this.gap(from, s) >= 0 && this.gap(s, to) >= 0
  }
}
