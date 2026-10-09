/**
 * A top-down drawing of an incident: the track edges, each car's path with a
 * marker every second, and where they touched.
 *
 * Drawn the way a track's own map.png is, x to the right and z down the page,
 * so it reads like the map people know. That keeps corners turning the right
 * way: checked on Autopolis, whose racing line drawn like this matches its
 * outline image, and whose Turn 1 draws as the right-hander it is.
 */

import type { IncidentPacket } from "./incident.js"
import type { Track } from "./track.js"

const COLORS = { a: "#d1495b", b: "#2e86ab" } as const
/** Seconds of approach drawn before the contact, and after it. */
const SHOWN = { before: 3, after: 1 }
const PAD_M = 12
const WIDTH = 720

export function renderIncidentSvg(p: IncidentPacket, track: Track): string {
  const rows = p.timeline.filter((r) => r.t >= -SHOWN.before && r.t <= SHOWN.after)
  const frames = rows.flatMap((r) => [r.a, r.b]).filter((f) => f !== null)
  if (frames.length === 0) throw new Error("no positions to draw")

  const xs = frames.map((f) => f.pos[0])
  const zs = frames.map((f) => f.pos[2])
  const minX = Math.min(...xs) - PAD_M
  const maxX = Math.max(...xs) + PAD_M
  const minZ = Math.min(...zs) - PAD_M
  const maxZ = Math.max(...zs) + PAD_M
  const scale = WIDTH / Math.max(maxX - minX, maxZ - minZ)
  const height = Math.round((maxZ - minZ) * scale)
  const width = Math.round((maxX - minX) * scale)
  const at = (x: number, z: number): string =>
    `${((x - minX) * scale).toFixed(1)},${((z - minZ) * scale).toFixed(1)}`

  // Track edges over the stretch of lap the cars covered, plus a margin.
  const ss = frames.map((f) => f.s)
  const from = ss.reduce((m, s) => (track.gap(m, s) < 0 ? s : m), ss[0]!) - 40
  const span = Math.max(...ss.map((s) => track.gap(from, s))) + 80
  const left: string[] = []
  const right: string[] = []
  const line: string[] = []
  for (let d = 0; d <= span; d += 2) {
    const q = track.pointAt(from + d)
    left.push(at(q.leftEdge[0], q.leftEdge[1]))
    right.push(at(q.rightEdge[0], q.rightEdge[1]))
    line.push(at(q.x, q.z))
  }

  const path = (key: "a" | "b"): string =>
    rows
      .map((r) => r[key])
      .filter((f) => f !== null)
      .map((f) => at(f.pos[0], f.pos[2]))
      .join(" ")
  const markers = (key: "a" | "b"): string =>
    rows
      .filter((r) => r[key] && Number.isInteger(r.t))
      .map((r) => {
        const f = r[key]!
        const [cx, cy] = at(f.pos[0], f.pos[2]).split(",")
        const label =
          r.t === 0
            ? ""
            : `<text x="${cx}" y="${cy}" dx="6" dy="-6" class="t">${r.t > 0 ? "+" : ""}${r.t}s</text>`
        return `<circle cx="${cx}" cy="${cy}" r="${r.t === 0 ? 6 : 3.5}" fill="${COLORS[key]}"/>${label}`
      })
      .join("")

  // The closest approach measured, which can be a moment before the report.
  const contact = p.measured.contact
  const bang = contact
    ? (() => {
        const [cx, cy] = at(
          (contact.a.pos[0] + contact.b.pos[0]) / 2,
          (contact.a.pos[2] + contact.b.pos[2]) / 2,
        ).split(",")
        return `<circle cx="${cx}" cy="${cy}" r="14" fill="none" stroke="#f4a259" stroke-width="3"/>`
      })()
    : ""

  const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)
  const legend = [
    [COLORS.a, `${esc(p.a.driver || `car ${p.a.carId}`)} (reported the contact)`],
    [COLORS.b, esc(p.b.driver || `car ${p.b.carId}`)],
  ]
    .map(
      ([color, name], i) =>
        `<rect x="12" y="${14 + i * 20}" width="12" height="12" fill="${color}"/><text x="30" y="${24 + i * 20}">${name}</text>`,
    )
    .join("")

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height + 60}" viewBox="0 0 ${width} ${height + 60}" font-family="sans-serif" font-size="12">
<rect width="100%" height="100%" fill="#f7f7f2"/>
<g transform="translate(0,60)">
<polyline points="${left.join(" ")}" fill="none" stroke="#555" stroke-width="2"/>
<polyline points="${right.join(" ")}" fill="none" stroke="#555" stroke-width="2"/>
<polyline points="${line.join(" ")}" fill="none" stroke="#aaa" stroke-width="1" stroke-dasharray="4 4"/>
<polyline points="${path("a")}" fill="none" stroke="${COLORS.a}" stroke-width="2"/>
<polyline points="${path("b")}" fill="none" stroke="${COLORS.b}" stroke-width="2"/>
${markers("a")}${markers("b")}${bang}
</g>
<style>.t{font-size:10px;fill:#333}</style>
${legend}
<text x="${width - 12}" y="24" text-anchor="end">${esc(p.collision.where)}, ${Math.round(p.collision.impactSpeedKmh)} km/h impact</text>
</svg>
`
}
