/**
 * Stages a Turn 1 incident on a disposable server, on a real track's racing
 * line, so the recorder and the incident analysis have something realistic to
 * chew on without anyone driving.
 *
 * Car A drives the AI line at the AI's speed. Car B starts behind, brakes
 * later, sits a few meters to the inside, and turns in on top of A. When they
 * meet, B reports the contact the way a game client would, and A is pushed
 * wide and loses speed.
 *
 *   tsx scripts/spectator/scenario.ts <host> <port> <acRoot> <car> <fast_lane.ai>
 */

import { readFileSync } from "node:fs"

import { type Pose, SpectatorClient } from "../../src/spectator/client.js"
import { BRAKE_LIGHTS, type Vec3 } from "../../src/spectator/protocol.js"
import { parseFastLane, Track } from "../../src/spectator/track.js"
import { WireWriter } from "../../src/spectator/wire.js"

const [host = "127.0.0.1", port = "9600", acRoot = ".", car = "", fastLane = ""] =
  process.argv.slice(2)
const track = new Track(parseFastLane(readFileSync(fastLane)))
const firstCorner = track.corners[0]
if (!firstCorner) throw new Error("the racing line has no corners")
const turn = firstCorner
const inside = turn.direction === "right" ? -1 : 1

class ScriptedDriver extends SpectatorClient {
  reportContact(other: number, speed: number, world: Vec3, rel: Vec3): void {
    this.sendTcp(
      new WireWriter().u8(0x82).u16(1).u8(0x0a).u8(other).f32(speed).vec3(world).vec3(rel).build(),
    )
  }
}

interface CarState {
  s: number
  lateral: number
  speed: number
  pos: Vec3
  yaw: number
}

/** A point at (s, lateral off the racing line); the line runs at car-body height. */
function at(s: number, lateral: number): Vec3 {
  const p = track.pointAt(s)
  const lx = (p.leftEdge[0] - p.x) / (p.left || 1)
  const lz = (p.leftEdge[1] - p.z) / (p.left || 1)
  return [p.x + lx * lateral, p.y, p.z + lz * lateral]
}

function place(state: CarState): Vec3 {
  return at(state.s, state.lateral)
}

/** Heading and slope along the path a few meters either side of s. */
function attitude(s: number, lateral: number): { yaw: number; pitch: number } {
  const a = at(s - 2, lateral)
  const b = at(s + 2, lateral)
  const [dx, dy, dz] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  // Forward is (-sin yaw, cos yaw); pitch is positive nose up.
  return { yaw: Math.atan2(-dx, dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) }
}

/** An MX-5's wheelbase, for turning curvature into a front wheel angle. */
const WHEELBASE_M = 2.3
/** Steering wheel degrees per degree of front wheel, as measured on a real replay. */
const STEERING_RATIO = 14.4

function step(state: CarState, speed: number, dt: number, lateralRate = 0): Pose {
  const braking = speed < state.speed - 0.05
  const accelerating = speed > state.speed + 0.05
  state.speed = speed
  state.s += speed * dt
  const pos = place(state)
  const { yaw: lineYaw, pitch } = attitude(state.s, state.lateral)
  // Moving across the track turns the car toward where it's going.
  const yaw = lineYaw - Math.atan2(lateralRate, Math.max(speed, 1))
  const ahead = attitude(state.s + 5, state.lateral).yaw
  const curvature = Math.atan2(Math.sin(ahead - lineYaw), Math.cos(ahead - lineYaw)) / 5
  const wheelDeg = (Math.atan(WHEELBASE_M * curvature) * 180) / Math.PI
  state.pos = pos
  state.yaw = yaw
  return {
    pos,
    rot: [yaw, pitch, 0],
    vel: [
      -Math.sin(yaw) * speed * Math.cos(pitch),
      Math.sin(pitch) * speed,
      Math.cos(yaw) * speed * Math.cos(pitch),
    ],
    gear: Math.min(7, 2 + Math.floor(speed / 12)),
    rpm: Math.round(3000 + (speed % 12) * 400),
    gas: braking ? 0 : accelerating ? 1 : 0.6,
    statusFlags: braking ? BRAKE_LIGHTS : 0,
    steer: Math.max(-127, Math.min(127, Math.round(wheelDeg * STEERING_RATIO))),
  }
}

const start = turn.entry - 350
const a: CarState = {
  s: start,
  lateral: 0,
  speed: track.pointAt(start).speed,
  pos: [0, 0, 0],
  yaw: 0,
}
const b: CarState = { s: start - 15, lateral: 0, speed: a.speed + 1, pos: [0, 0, 0], yaw: 0 }
a.pos = place(a)
b.pos = place(b)
let last = process.env["DRY"] ? 0 : performance.now()
let contact: number | undefined
let carA = -1
let carB = -1
let driverB: ScriptedDriver | undefined
const poses = { a: undefined as Pose | undefined, b: undefined as Pose | undefined }

/** One shared step for both cars, so their positions are always consistent with each other. */
function tick(now = performance.now()): number {
  const dt = (now - last) / 1000
  last = now
  const after = contact !== undefined ? (now - contact) / 1000 : undefined
  // A: the AI line at the AI's speed, until hit; then pushed wide and slowed.
  const speedA = after === undefined ? track.pointAt(a.s).speed : Math.max(8, a.speed - 12 * dt)
  const aLateral0 = a.lateral
  if (after !== undefined) a.lateral += (-inside * 3 - a.lateral) * Math.min(1, dt * 1.5)
  // B: looks further down the road before braking and moves to the inside,
  // then turns in toward A's line 40 m before the corner.
  const speedB = Math.max(track.pointAt(b.s).speed, track.pointAt(b.s + 30).speed) + 1.5
  const toTurnIn = track.gap(b.s, turn.entry)
  // From the inside line toward, and a little past, A's line by turn-in.
  const target =
    after !== undefined ? b.lateral : inside * 3.2 * Math.max(-0.3, Math.min(1, toTurnIn / 40))
  const bLateral0 = b.lateral
  b.lateral += (target - b.lateral) * Math.min(1, dt * 2)
  poses.a = step(a, speedA, dt, dt > 0 ? (a.lateral - aLateral0) / dt : 0)
  poses.b = step(b, speedB, dt, dt > 0 ? (b.lateral - bLateral0) / dt : 0)
  const gap = Math.hypot(a.pos[0] - b.pos[0], a.pos[2] - b.pos[2])
  if (contact === undefined && gap < 2.2 && carA >= 0) {
    contact = now
    // Where A is, in B's own frame: x across (left positive), z forward.
    const fx = -Math.sin(b.yaw)
    const fz = Math.cos(b.yaw)
    const rx = a.pos[0] - b.pos[0]
    const rz = a.pos[2] - b.pos[2]
    const rel: Vec3 = [(rx * fz - rz * fx) / 2, 0, (rx * fx + rz * fz) / 2]
    const mid: Vec3 = [
      (a.pos[0] + b.pos[0]) / 2,
      (a.pos[1] + b.pos[1]) / 2,
      (a.pos[2] + b.pos[2]) / 2,
    ]
    driverB?.reportContact(carA, Math.abs(b.speed - a.speed) + 2, mid, rel)
    console.log(
      `contact at ${track.where(b.s)}, gap ${gap.toFixed(2)} m, B ${(b.speed * 3.6).toFixed(0)} km/h, A ${(a.speed * 3.6).toFixed(0)} km/h`,
    )
  }
  return gap
}

// DRY=1 runs the same physics with no server, to tune the scenario.
if (process.env["DRY"]) {
  carA = 0
  let t = 0
  let closest = Infinity
  while (track.gap(turn.exit + 120, a.s) < 0 && t < 120_000) {
    t += 1000 / 36
    const gap = tick(t)
    if (gap < closest) closest = gap
    if (Math.round(t) % 1000 < 28) {
      console.log(
        `${(t / 1000).toFixed(0)}s A ${Math.round(a.s)}m ${(a.speed * 3.6).toFixed(0)}km/h lat ${a.lateral.toFixed(1)} | B ${Math.round(b.s)}m ${(b.speed * 3.6).toFixed(0)}km/h lat ${b.lateral.toFixed(1)} | gap ${gap.toFixed(1)}`,
      )
    }
  }
  console.log(`closest ${closest.toFixed(2)} m`)
  process.exit(0)
}

const identity = (n: number) => ({
  guid: `7656119800000000${n}`,
  name: n === 2 ? "Alice Apex" : "Bob Divebomb",
  team: "",
  nation: "",
  car,
  password: "",
})
const base = { host, port: Number(port), acRoot, onPacket: () => {} }
const driverA = new ScriptedDriver({
  ...base,
  identity: identity(2),
  pose: () => poses.a ?? step(a, a.speed, 0),
})
driverB = new ScriptedDriver({
  ...base,
  identity: identity(3),
  pose: () => poses.b ?? step(b, b.speed, 0),
})
carA = (await driverA.connect()).carId
carB = (await driverB.connect()).carId
console.log(
  `A is car ${carA}, B is car ${carB}; ${turn.name} is a ${turn.direction}-hander at ${Math.round(turn.entry)} m`,
)
last = performance.now()
const timer = setInterval(() => tick(), 1000 / 36)
while (track.gap(turn.exit + 120, a.s) < 0) await new Promise((r) => setTimeout(r, 200))
clearInterval(timer)
driverA.close()
driverB.close()
console.log(contact === undefined ? "no contact happened" : "done")
