/**
 * An overhead video of a stretch of a recorded session: the track, every car
 * as an arrow where the recording put it, the cars a steward is looking at
 * picked out with their trails, names and speeds, and a race clock. Drawn
 * frame by frame and handed to ffmpeg as raw pixels.
 *
 * It shows what the recording knows and nothing it doesn't: positions,
 * headings and speeds, about 20 times a second, interpolated between. There is
 * no 3D, no camera, and no contact point a race-control feed didn't carry.
 */

import { spawn } from "node:child_process"

import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas"

import { loadFonts } from "../fonts.js"
import { readJournal } from "./journal.js"
import type { Track } from "./track.js"

export interface VideoOptions {
  /** The stretch to show, in ms from the session's start, as a replay shows it. */
  fromMs: number
  toMs: number
  /** Drivers to follow and pick out, matched case-insensitively within their names. */
  focus?: readonly string[]
  width?: number
  height?: number
  fps?: number
}

export interface CarTrack {
  carId: number
  driver: string
  focused: boolean
  /** Session ms, ascending. */
  t: number[]
  x: number[]
  z: number[]
  yaw: number[]
  kmh: number[]
  gear: number[]
}

export interface Clip {
  track: Track
  session: { name: string; track: string }
  cars: CarTrack[]
  /** Collisions in the stretch, at session ms, where the server said they were. */
  hits: { at: number; x: number; z: number; withCar: boolean }[]
  fromMs: number
  toMs: number
}

/** A frame is ready to draw this long either side of the stretch, for trails. */
const TRAIL_MS = 3000
/** A car not heard from for longer than this isn't drawn: it's left, or reset. */
const STALE_MS = 1000
/** The closest the view comes in, in meters across, so a car doesn't fill it. */
const MIN_VIEW_M = 220
/** How long a collision stays marked. */
const HIT_MS = 1500

export async function loadClip(journal: string, track: Track, o: VideoOptions): Promise<Clip> {
  const asked = o.focus ?? []
  const focus = asked.map((f) => f.toLowerCase())
  const names = new Map<number, string>()
  const cars = new Map<number, CarTrack>()
  const hits: Clip["hits"] = []
  let start: number | undefined
  let session = { name: "", track: "" }
  let recorder = -1
  for await (const r of readJournal(journal)) {
    if (r.t === "session") {
      if (start === undefined) {
        start = r.at
        session = { name: r.name, track: r.track }
        recorder = r.recorderCarId
      }
      continue
    }
    if (start === undefined) continue
    const t = r.at - start
    // Up to the stretch's end: a slot can change hands later in the session.
    if (r.t === "car" && r.driver && t <= o.toMs) names.set(r.carId, r.driver)
    if (t < o.fromMs - TRAIL_MS || t > o.toMs + STALE_MS) continue
    if (r.t === "collision") {
      hits.push({ at: t, x: r.worldPos[0], z: r.worldPos[2], withCar: r.otherCarId !== undefined })
    } else if (r.t === "pos" && r.car.carId !== recorder) {
      let c = cars.get(r.car.carId)
      if (!c) {
        c = {
          carId: r.car.carId,
          driver: "",
          focused: false,
          t: [],
          x: [],
          z: [],
          yaw: [],
          kmh: [],
          gear: [],
        }
        cars.set(r.car.carId, c)
      }
      c.t.push(t)
      c.x.push(r.car.pos[0])
      c.z.push(r.car.pos[2])
      c.yaw.push(r.car.rot[0])
      c.kmh.push(Math.hypot(r.car.vel[0], r.car.vel[2]) * 3.6)
      c.gear.push(r.car.gear)
    }
  }
  if (start === undefined) throw new Error(`${journal} has no session record`)
  for (const c of cars.values()) {
    c.driver = names.get(c.carId) ?? `car ${c.carId}`
    c.focused = focus.some((f) => c.driver.toLowerCase().includes(f))
  }
  const missing = asked.filter(
    (f) => ![...cars.values()].some((c) => c.driver.toLowerCase().includes(f.toLowerCase())),
  )
  if (missing.length > 0) {
    throw new Error(
      `no car in that stretch is driven by anyone called ${missing.map((m) => JSON.stringify(m)).join(" or ")}`,
    )
  }
  return { track, session, cars: [...cars.values()], hits, fromMs: o.fromMs, toMs: o.toMs }
}

export interface Pose {
  x: number
  z: number
  yaw: number
  kmh: number
  gear: number
}

/** Where a car was at session ms `t`, between its samples; undefined when it wasn't heard from. */
export function poseAt(c: CarTrack, t: number): Pose | undefined {
  let lo = 0
  let hi = c.t.length - 1
  if (hi < 0 || t < c.t[0]! - STALE_MS || t > c.t[hi]! + STALE_MS) return undefined
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (c.t[mid]! <= t) lo = mid
    else hi = mid - 1
  }
  const b = Math.min(lo + 1, c.t.length - 1)
  const span = c.t[b]! - c.t[lo]!
  if (t > c.t[lo]! && span > STALE_MS) return undefined
  const w = span > 0 && t > c.t[lo]! ? Math.min(1, (t - c.t[lo]!) / span) : 0
  const mix = (a: number[]) => a[lo]! + (a[b]! - a[lo]!) * w
  const turn = Math.atan2(Math.sin(c.yaw[b]! - c.yaw[lo]!), Math.cos(c.yaw[b]! - c.yaw[lo]!))
  return {
    x: mix(c.x),
    z: mix(c.z),
    yaw: c.yaw[lo]! + turn * w,
    kmh: mix(c.kmh),
    gear: c.gear[lo]!,
  }
}

interface View {
  cx: number
  cz: number
  /** Meters across the frame. */
  span: number
}

function wholeTrack(clip: Clip, aspect: number): View {
  const xs = clip.track.points.map((p) => p.x)
  const zs = clip.track.points.map((p) => p.z)
  const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)]
  return {
    cx: (x0 + x1) / 2,
    cz: (z0 + z1) / 2,
    span: Math.max(x1 - x0, (z1 - z0) * aspect) * 1.08,
  }
}

/**
 * What the frame looks at: the focused cars with room around them, or the
 * whole track when nothing is focused. Undefined when the focused cars are
 * all out of the recording for the moment, so the view stays where it was
 * rather than pulling out to the whole circuit and back.
 */
export function frameView(clip: Clip, t: number, aspect: number): View | undefined {
  const focused = clip.cars
    .filter((c) => c.focused)
    .map((c) => poseAt(c, t))
    .filter((p): p is Pose => p !== undefined)
  if (focused.length === 0 && clip.cars.some((c) => c.focused)) return undefined
  if (focused.length === 0) return wholeTrack(clip, aspect)
  const xs = focused.map((p) => p.x)
  const zs = focused.map((p) => p.z)
  const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)]
  const span = Math.max(MIN_VIEW_M, (x1 - x0) * 1.6, (z1 - z0) * aspect * 1.6)
  return { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, span }
}

const COLORS = {
  ground: "#eceee8",
  track: "#b9bdc3",
  edge: "#9a9fa6",
  car: "#5b616a",
  focus: ["#d94f0f", "#2a6fd6", "#1a9a5c", "#8a3bd1"],
  text: "#1b1e23",
  panel: "rgba(255,255,255,0.88)",
  hit: "#d1291f",
}

/** The game's gear numbering: 0 is reverse, 1 neutral, 2 first. */
function gearLabel(g: number): string {
  return g === 0 ? "reverse" : g === 1 ? "neutral" : `gear ${g - 1}`
}

function formatClock(ms: number): string {
  const s = Math.max(0, ms) / 1000
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`
}

export function drawFrame(
  ctx: SKRSContext2D,
  clip: Clip,
  t: number,
  view: View,
  w: number,
  h: number,
): void {
  const scale = w / view.span
  const X = (x: number) => w / 2 + (x - view.cx) * scale
  const Z = (z: number) => h / 2 + (z - view.cz) * scale
  ctx.fillStyle = COLORS.ground
  ctx.fillRect(0, 0, w, h)

  // The track: a band between its edges, every 2 m.
  const t0 = clip.track
  ctx.fillStyle = COLORS.track
  ctx.beginPath()
  for (let s = 0; s <= t0.length; s += 2) {
    const q = t0.pointAt(s)
    s === 0
      ? ctx.moveTo(X(q.leftEdge[0]), Z(q.leftEdge[1]))
      : ctx.lineTo(X(q.leftEdge[0]), Z(q.leftEdge[1]))
  }
  ctx.closePath()
  for (let s = 0; s <= t0.length; s += 2) {
    const q = t0.pointAt(s)
    s === 0
      ? ctx.moveTo(X(q.rightEdge[0]), Z(q.rightEdge[1]))
      : ctx.lineTo(X(q.rightEdge[0]), Z(q.rightEdge[1]))
  }
  ctx.closePath()
  ctx.fill("evenodd")

  for (const hit of clip.hits) {
    const age = t - hit.at
    if (age < 0 || age > HIT_MS) continue
    ctx.strokeStyle = COLORS.hit
    ctx.globalAlpha = 1 - age / HIT_MS
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.arc(X(hit.x), Z(hit.z), 10 + (age / HIT_MS) * 30, 0, Math.PI * 2)
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  const focused = clip.cars.filter((c) => c.focused)
  const colorOf = (c: CarTrack) => COLORS.focus[focused.indexOf(c) % COLORS.focus.length]!
  // Trails first, so every car sits on top of them.
  for (const c of focused) {
    ctx.strokeStyle = colorOf(c)
    ctx.lineWidth = 3
    ctx.globalAlpha = 0.55
    ctx.beginPath()
    let on = false
    for (let k = t - TRAIL_MS; k <= t; k += 50) {
      const p = poseAt(c, k)
      if (!p) {
        on = false
        continue
      }
      on ? ctx.lineTo(X(p.x), Z(p.z)) : ctx.moveTo(X(p.x), Z(p.z))
      on = true
    }
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  // A car is about 4.5 m long; drawn at least big enough to see on the whole-track view.
  const len = Math.max(9, 4.5 * scale)
  const ordered = [...clip.cars].sort((a, b) => Number(a.focused) - Number(b.focused))
  for (const c of ordered) {
    const p = poseAt(c, t)
    if (!p) continue
    const [fx, fz] = [-Math.sin(p.yaw), Math.cos(p.yaw)]
    const [lx, lz] = [fz, -fx]
    const cx = X(p.x)
    const cz = Z(p.z)
    ctx.fillStyle = c.focused ? colorOf(c) : COLORS.car
    ctx.beginPath()
    ctx.moveTo(cx + fx * len * 0.6, cz + fz * len * 0.6)
    ctx.lineTo(cx - fx * len * 0.4 + lx * len * 0.3, cz - fz * len * 0.4 + lz * len * 0.3)
    ctx.lineTo(cx - fx * len * 0.4 - lx * len * 0.3, cz - fz * len * 0.4 - lz * len * 0.3)
    ctx.closePath()
    ctx.fill()
    if (c.focused || scale > 1.5) {
      ctx.font = `${c.focused ? 500 : 400} 14px Roboto`
      ctx.fillStyle = COLORS.text
      ctx.fillText(c.driver, cx + len * 0.5 + 4, cz - len * 0.5)
    }
  }

  // The panel: the clock, the session, and each focused car's speed and gear.
  ctx.fillStyle = COLORS.panel
  const rows = focused.length
  ctx.fillRect(12, 12, 300, 54 + rows * 24)
  ctx.fillStyle = COLORS.text
  ctx.font = "500 24px Roboto"
  ctx.fillText(formatClock(t), 24, 44)
  ctx.font = "400 14px Roboto"
  ctx.fillText(`${clip.session.name}, ${clip.session.track}`, 120, 42)
  focused.forEach((c, i) => {
    const p = poseAt(c, t)
    ctx.fillStyle = colorOf(c)
    ctx.fillRect(24, 64 + i * 24, 10, 10)
    ctx.fillStyle = COLORS.text
    const what = p ? `${Math.round(p.kmh)} km/h, ${gearLabel(p.gear)}` : "not on track"
    ctx.fillText(`${c.driver}: ${what}`, 42, 74 + i * 24)
  })
}

/** Where the frames go: ffmpeg in use, a stand-in in tests. */
export interface FrameSink {
  write(rgba: Buffer): Promise<void>
  end(): Promise<void>
}

/** H.264 in an MP4 that Discord and browsers play inline. `command` is for the tests. */
export function ffmpegSink(
  out: string,
  w: number,
  h: number,
  fps: number,
  command = "ffmpeg",
): FrameSink {
  const ff = spawn(
    command,
    [
      ...["-hide_banner", "-loglevel", "error", "-y"],
      ...["-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${w}x${h}`, "-r", String(fps), "-i", "-"],
      ...["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", "-movflags", "+faststart", out],
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  )
  let err = ""
  ff.stderr.on("data", (d: Buffer) => {
    err += d.toString()
  })
  const exited = new Promise<void>((resolve, reject) => {
    ff.on("error", (e) =>
      reject(
        (e as NodeJS.ErrnoException).code === "ENOENT"
          ? new Error("video needs ffmpeg, and there isn't one on the PATH")
          : e,
      ),
    )
    ff.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${err.trim() || `exit ${code}`}`)),
    )
  })
  // A run that stops before end(), with a frame it couldn't draw, would
  // otherwise leave ffmpeg's failure unhandled and take the process down.
  exited.catch(() => {})
  // The pipe breaks when ffmpeg quits early. A broken pipe never drains, so a
  // write waits for either, and ffmpeg's own exit says why.
  ff.stdin.on("error", () => {})
  return {
    write: async (rgba) => {
      if (ff.stdin.destroyed) return exited
      if (!ff.stdin.write(rgba)) {
        await Promise.race([new Promise((resolve) => ff.stdin.once("drain", resolve)), exited])
      }
    },
    end: async () => {
      ff.stdin.end()
      await exited
    },
  }
}

export async function writeVideo(clip: Clip, sink: FrameSink, o: VideoOptions): Promise<number> {
  loadFonts()
  const w = o.width ?? 1280
  const h = o.height ?? 720
  const fps = o.fps ?? 30
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext("2d")
  let frames = 0
  // The view eases toward where the focused cars are, so it doesn't jitter
  // with every sample.
  let view: View | undefined
  const count = Math.floor(((clip.toMs - clip.fromMs) * fps) / 1000) + 1
  for (let f = 0; f < count; f++) {
    const t = clip.fromMs + (f * 1000) / fps
    const target = frameView(clip, t, w / h)
    view =
      view && target
        ? {
            cx: view.cx + (target.cx - view.cx) * 0.15,
            cz: view.cz + (target.cz - view.cz) * 0.15,
            span: view.span + (target.span - view.span) * 0.1,
          }
        : (view ?? target ?? wholeTrack(clip, w / h))
    drawFrame(ctx, clip, t, view, w, h)
    await sink.write(Buffer.from(ctx.getImageData(0, 0, w, h).data.buffer))
    frames++
  }
  await sink.end()
  return frames
}
