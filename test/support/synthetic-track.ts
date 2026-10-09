/**
 * A racing line built by walking a turtle round a loop, written out in the
 * fast_lane.ai layout `Track` reads. Turning "left" rotates the heading toward
 * AC's left, (fz, -fx), so a loop of left turns has left-handers by
 * construction, independent of the code under test.
 */

export type Leg = { straight: number } | { turn: "left" | "right"; degrees: number; radius: number }

export function walk(legs: readonly Leg[], step = 2): [number, number][] {
  let x = 0
  let z = 0
  let fx = 0
  let fz = 1
  const out: [number, number][] = []
  for (const leg of legs) {
    if ("straight" in leg) {
      for (let d = 0; d < leg.straight; d += step) {
        out.push([x, z])
        x += fx * step
        z += fz * step
      }
      continue
    }
    const sign = leg.turn === "left" ? 1 : -1
    const steps = Math.round(((leg.degrees / 180) * Math.PI * leg.radius) / step)
    const da = (sign * (leg.degrees / 180) * Math.PI) / steps
    for (let k = 0; k < steps; k++) {
      out.push([x, z])
      x += fx * step
      z += fz * step
      const [lx, lz] = [fz, -fx]
      ;[fx, fz] = [Math.cos(da) * fx + Math.sin(da) * lx, Math.cos(da) * fz + Math.sin(da) * lz]
    }
  }
  return out
}

/** A rounded rectangle: four 90° corners of the given direction, T1 after 300 m. */
export function loop(direction: "left" | "right"): [number, number][] {
  const corner = { turn: direction, degrees: 90, radius: 40 } as const
  return walk([
    { straight: 300 },
    corner,
    { straight: 200 },
    corner,
    { straight: 300 },
    corner,
    { straight: 200 },
    corner,
  ])
}

/**
 * `center` is the middle of the track. `offset` moves the racing line off it,
 * meters to the left at each point, and the edge distances follow so the
 * track itself stays where it is: a line that sweeps across a fixed track,
 * as real ones do.
 */
export function fastLane(
  center: readonly [number, number][],
  edges = { left: 6, right: 6 },
  offset: (i: number) => number = () => 0,
): Buffer {
  const n = center.length
  const points = center.map(([x, z], i): [number, number] => {
    const [ax, az] = center[(i - 1 + n) % n]!
    const [bx, bz] = center[(i + 1) % n]!
    const len = Math.hypot(bx - ax, bz - az) || 1
    const [fx, fz] = [(bx - ax) / len, (bz - az) / len]
    const off = offset(i)
    return [x + fz * off, z - fx * off]
  })
  const head = Buffer.alloc(16)
  head.writeUInt32LE(7, 0)
  head.writeUInt32LE(n, 4)
  const body = Buffer.alloc(n * 20)
  let s = 0
  points.forEach(([x, z], i) => {
    if (i > 0) s += Math.hypot(x - points[i - 1]![0], z - points[i - 1]![1])
    body.writeFloatLE(x, i * 20)
    body.writeFloatLE(0, i * 20 + 4)
    body.writeFloatLE(z, i * 20 + 8)
    body.writeFloatLE(s, i * 20 + 12)
    body.writeUInt32LE(i, i * 20 + 16)
  })
  const count = Buffer.alloc(4)
  count.writeUInt32LE(n)
  const extra = Buffer.alloc(n * 72)
  for (let i = 0; i < n; i++) {
    extra.writeFloatLE(30, i * 72)
    extra.writeFloatLE(edges.left - offset(i), i * 72 + 20)
    extra.writeFloatLE(edges.right + offset(i), i * 72 + 24)
  }
  return Buffer.concat([head, body, count, extra])
}
