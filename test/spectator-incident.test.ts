/**
 * A Turn 1 incident on a synthetic left-hander, laid out by hand so every fact
 * has a known answer: Alice drives the racing line; Bob starts 12 m behind and
 * 3 m to her left (the inside), brakes 0.6 s later, then closes back toward
 * the line in the last 1.2 s and hits her.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  buildIncident,
  DEFAULT_THRESHOLDS,
  describeRel,
  type IncidentPacket,
} from "../src/spectator/incident.js"
import { JournalWriter, type JournalRecord } from "../src/spectator/journal.js"
import { BRAKE_LIGHTS, type CarState } from "../src/spectator/protocol.js"
import { renderIncidentSvg } from "../src/spectator/render.js"
import { incidentBrief } from "../src/spectator/brief.js"
import { suggest } from "../src/spectator/rules.js"
import { parseFastLane, Track } from "../src/spectator/track.js"
import { fastLane, loop } from "./support/synthetic-track.js"

const ALICE = 1
const BOB = 2
const CONTACT_MS = 5250

function scenario(track: Track, side: 1 | -1): JournalRecord[] {
  const records: JournalRecord[] = [
    {
      t: "session",
      at: 0,
      serverName: "s",
      track: "loop",
      trackConfig: "",
      name: "Race",
      type: 3,
      recorderCarId: 0,
    },
    { t: "car", at: 0, carId: ALICE, model: "m", skin: "s", driver: "Alice Apex" },
    { t: "car", at: 0, carId: BOB, model: "m", skin: "s", driver: "Bob Divebomb" },
  ]
  const at = (s: number, lateral: number): [number, number, number] => {
    const p = track.pointAt(s)
    const lx = (p.leftEdge[0] - p.x) / p.left
    const lz = (p.leftEdge[1] - p.z) / p.left
    return [p.x + lx * lateral, 0, p.z + lz * lateral]
  }
  const car = (
    carId: number,
    t: number,
    s: number,
    lateral: number,
    speed: number,
    braking: boolean,
  ): CarState => {
    const here = at(s, lateral)
    const there = at(s + 1, lateral)
    const [dx, dz] = [there[0] - here[0], there[2] - here[2]]
    const len = Math.hypot(dx, dz)
    return {
      carId,
      seq: 0,
      timestamp: t,
      ping: 0,
      pos: here,
      rot: [Math.atan2(-dx, dz), 0, 0],
      vel: [(dx / len) * speed, 0, (dz / len) * speed],
      steer: 0,
      rpm: 5000,
      gear: 4,
      statusFlags: braking ? BRAKE_LIGHTS : 0,
      gas: braking ? 0 : 1,
    }
  }
  for (let t = 0; t <= 9000; t += 55) {
    const sA = 150 + 30 * (t / 1000)
    const sB = 138 + 32 * (t / 1000)
    const closing = Math.max(0, Math.min(1, (t - (CONTACT_MS - 1200)) / 1200))
    records.push({ t: "pos", at: t, car: car(ALICE, t, sA, 0, 30, t >= 3000) })
    records.push({
      t: "pos",
      at: t,
      car: car(BOB, t, sB, side * (3 - 2.5 * closing), 32, t >= 3600),
    })
  }
  records.push({
    t: "collision",
    at: CONTACT_MS,
    carId: BOB,
    otherCarId: ALICE,
    impactSpeed: 4,
    worldPos: [0, 0, 0],
    relPos: [side * 0.7, 0, 0.8],
  })
  return records.sort((a, b) => a.at - b.at)
}

let dir: string
const packets: Record<"left" | "right", { packet: IncidentPacket; track: Track }> = {} as never

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "incident-"))
  for (const direction of ["left", "right"] as const) {
    const track = new Track(parseFastLane(fastLane(loop(direction))))
    const w = new JournalWriter(join(dir, `${direction}.ndjson.gz`))
    // The inside of the corner: left of the line for a left-hander.
    for (const r of scenario(track, direction === "left" ? 1 : -1)) w.write(r)
    await w.close()
    packets[direction] = { packet: await buildIncident(w.path, 0, track), track }
  }
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("buildIncident", () => {
  it("names the cars, the corner and the impact", () => {
    const { packet } = packets.left
    expect([packet.a.driver, packet.b.driver]).toEqual(["Bob Divebomb", "Alice Apex"])
    expect(packet.collision.where).toMatch(/T1/)
    expect(packet.facts[0]).toMatch(/reported Bob Divebomb hitting Alice Apex at .*T1.*14 km\/h/)
  })

  it.each([
    [/Alice Apex was ahead of Bob Divebomb by 1[0-2] m/, "who led at the start of the window"],
    [/They overlapped, within 2\.7 m of each other along the track/, "when they overlapped"],
    [
      /Bob Divebomb started braking 13 m further down the road than Alice Apex/,
      "the braking points",
    ],
    [
      /Bob Divebomb moved 2\.\d m right across the track in the last .* toward Alice Apex/,
      "who moved across whom",
    ],
    [/Alice Apex held their position on the track/, "who held their position"],
    [/Alice Apex was on the racing line/, "where each car was at contact"],
    [/Bob Divebomb was to the left of Alice Apex/, "which side of whom"],
    [/contact on Bob Divebomb's front-left/, "the contact point"],
  ])("states %s (%s)", (fact) => {
    expect(packets.left.packet.facts.some((f) => fact.test(f))).toBe(true)
  })

  it("reads the mirrored incident at a right-hander as the mirror image", () => {
    const facts = packets.right.packet.facts
    expect(facts.some((f) => /Bob Divebomb moved 2\.\d m left .* toward Alice Apex/.test(f))).toBe(
      true,
    )
    expect(facts.some((f) => /Alice Apex was to the left of Bob Divebomb/.test(f))).toBe(true)
  })

  it("refuses a collision number the session doesn't have", async () => {
    await expect(buildIncident(join(dir, "left.ndjson.gz"), 3, packets.left.track)).rejects.toThrow(
      /1 collisions; there is no #3/,
    )
  })
})

describe("describeRel", () => {
  it.each([
    [[0.7, 0, 0.8], "front-left"],
    [[-0.7, 0, -0.8], "rear-right"],
    [[0.9, 0, 0], "left side"],
    [[0, 0, 2], "front center"],
  ] as const)("%j is the %s", (rel, words) => {
    expect(describeRel([...rel])).toBe(words)
  })
})

describe("renderIncidentSvg", () => {
  /** Sum of turning on screen along a path: positive is clockwise with y down. */
  const turning = (svg: string, color: string): number => {
    const m = new RegExp(`<polyline points="([^"]+)" fill="none" stroke="${color}"`).exec(svg)
    const pts = m![1]!.split(" ").map((p) => p.split(",").map(Number) as [number, number])
    let sum = 0
    for (let i = 2; i < pts.length; i++) {
      const [ax, ay] = [pts[i - 1]![0] - pts[i - 2]![0], pts[i - 1]![1] - pts[i - 2]![1]]
      const [bx, by] = [pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]]
      sum += ax * by - ay * bx
    }
    return sum
  }

  it("draws a right-hander turning clockwise and a left-hander anticlockwise", () => {
    // Alice's path, which follows the racing line into the corner.
    const right = renderIncidentSvg(packets.right.packet, packets.right.track)
    const left = renderIncidentSvg(packets.left.packet, packets.left.track)
    expect(turning(right, "#2e86ab")).toBeGreaterThan(0)
    expect(turning(left, "#2e86ab")).toBeLessThan(0)
  })

  it("rings the measured contact, not wherever the cars were when it was reported", () => {
    const { packet, track } = packets.right
    const ring = (svg: string) => /<circle cx="([^"]+)" cy="([^"]+)" r="14"/.exec(svg)?.slice(1)
    const earlier = packet.timeline.find((r) => r.t === -1)!
    const moved = {
      ...packet,
      measured: {
        ...packet.measured,
        contact: { ...packet.measured.contact!, a: earlier.a!, b: earlier.b! },
      },
    }
    expect(ring(renderIncidentSvg(moved, track))).not.toEqual(
      ring(renderIncidentSvg(packet, track)),
    )
  })
})

describe("suggest", () => {
  it.each(["left", "right"] as const)(
    "calls the staged %s-hander incident for the car that moved across",
    (direction) => {
      const { packet } = packets[direction]
      expect(suggest(packet, DEFAULT_THRESHOLDS)).toMatchObject({ call: "A", rule: "moved-across" })
    },
  )
})

describe("incidentBrief", () => {
  it("carries the question, the rules, the facts and the timeline", () => {
    const brief = incidentBrief(packets.left.packet, "Rule 7: no divebombs.")
    expect(brief).toMatch(/^A collision in a sim racing league/)
    expect(brief).toContain("Rule 7: no divebombs.")
    for (const fact of packets.left.packet.facts) expect(brief).toContain(fact)
    expect(brief).toMatch(/\| t \(s\) \| gap \(m\) \| A \| B \|/)
  })
})
