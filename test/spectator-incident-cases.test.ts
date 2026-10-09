/**
 * Incidents built to break the measuring in the ways a review found it broke.
 * Each would have produced a wrong fact or a confident wrong call before its
 * fix; the comments say which.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  buildIncident,
  DEFAULT_THRESHOLDS,
  type IncidentPacket,
} from "../src/spectator/incident.js"
import { suggest } from "../src/spectator/rules.js"
import { parseFastLane, Track } from "../src/spectator/track.js"
import { type ScriptedCar, writeScenario } from "./support/incident-scenario.js"
import { fastLane, loop } from "./support/synthetic-track.js"

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "incident-cases-"))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const lerp = (a: number, b: number, from: number, to: number, x: number): number =>
  a + (b - a) * Math.max(0, Math.min(1, (x - from) / (to - from)))

describe("a racing line that sweeps across the track", () => {
  // The line runs 4 m right of center down the straight, then crosses to 4 m
  // left into the left-hander at 300 m. Points are 2 m apart.
  const line = (s: number): number => lerp(-4, 4, 200, 330, s)
  const track = new Track(
    parseFastLane(fastLane(loop("left"), { left: 6, right: 6 }, (i) => line(i * 2))),
  )
  let packet: IncidentPacket

  beforeAll(async () => {
    const path = await writeScenario(
      dir,
      "sweep",
      track,
      [
        // Holds 3 m left of center: the inside, and never moves.
        {
          carId: 1,
          driver: "Inside",
          s: (t) => 100 + 30 * (t / 1000),
          across: () => 3,
          braking: (t) => (t >= 1000 && t < 2000) || t >= 5000,
        },
        // Follows the racing line as it crosses to the inside, into Inside.
        {
          carId: 2,
          driver: "OnLine",
          s: (t) => 98 + 30.5 * (t / 1000),
          across: (t) => line(98 + 30.5 * (t / 1000)),
        },
      ],
      { at: 6115, carId: 2, otherCarId: 1 },
    )
    packet = await buildIncident(path, 0, track)
  })

  it("calls it for the car that crossed the track, not the one that held its place", () => {
    // Measured from the racing line, Inside "moved" and OnLine "held".
    expect(suggest(packet, DEFAULT_THRESHOLDS)).toMatchObject({ call: "A", rule: "moved-across" })
    expect(packet.facts).toContainEqual(
      expect.stringMatching(/^Inside held their position on the track/),
    )
  })

  it("reports the braking that led into the contact, not braking for an earlier corner", () => {
    // Inside braked from 1 s to 2 s, then again from 5 s; contact at 6.1 s.
    expect(packet.measured.braking.b?.t).toBeGreaterThan(-2)
  })
})

describe("a pass inside the window, then contact from behind", () => {
  const track = new Track(parseFastLane(fastLane(loop("left"))))
  let packet: IncidentPacket

  beforeAll(async () => {
    const path = await writeScenario(
      dir,
      "pass",
      track,
      [
        { carId: 1, driver: "Rammer", s: (t) => 100 + 30 * (t / 1000), across: () => 0 },
        // Passes on the left around 3.3 s, back in line by 4.5 s, 8 m ahead by 6 s; brakes
        // for T1 and is hit from behind at 6.7 s; then pulls away.
        {
          carId: 2,
          driver: "Passer",
          s: (t) =>
            t <= 6000
              ? 90 + 33 * (t / 1000)
              : t <= 6700
                ? 288 + 25 * ((t - 6000) / 1000)
                : 305.5 + 35 * ((t - 6700) / 1000),
          across: (t) => lerp(2.5, 0, 3500, 4500, t),
        },
      ],
      { at: 7000, carId: 1, otherCarId: 2 },
    )
    packet = await buildIncident(path, 0, track)
  })

  it("judges the turn-in by who was ahead at the turn-in, not at the start of the window", () => {
    // Taking Rammer as the leader from 8 s out, Passer "was 5 m back".
    expect(suggest(packet, DEFAULT_THRESHOLDS).call).toBe("A")
    expect(packet.measured.turnIn?.leader).toBe("b")
  })

  it("takes the contact as the closest approach, not the moment the report arrived", () => {
    // The report came 0.3 s after the contact, by when Passer had pulled away.
    // Closest row on the 0.2 s grid is 5.0 m; the report's own moment is 6.0 m.
    expect(packet.measured.contact?.gapM).toBeLessThan(5.5)
    // And the timeline counts from that moment, as the facts do.
    expect(packet.timeline.find((r) => r.t === 0)?.gapM).toBe(packet.measured.contact?.gapM)
  })
})

describe("contact in the braking zone, before anyone turned in", () => {
  const track = new Track(parseFastLane(fastLane(loop("left"))))

  it("doesn't describe a turn-in that happened after the contact", async () => {
    // Contact at 280 m, about 12 m short of T1's turn-in, which the cars
    // reach 0.4 s later. The turn-in used to be looked for up to 0.5 s after
    // the contact.
    const path = await writeScenario(
      dir,
      "braking-zone",
      track,
      [
        { carId: 1, driver: "Outside", s: (t) => 130 + 30 * (t / 1000), across: () => -1 },
        {
          carId: 2,
          driver: "Lunger",
          s: (t) => 129 + 30 * (t / 1000),
          across: (t) => lerp(2, -0.5, 3500, 5000, t),
        },
      ],
      { at: 5000, carId: 2, otherCarId: 1 },
    )
    const packet = await buildIncident(path, 0, track)
    expect(packet.measured.turnIn).toBeNull()
    expect(packet.facts.join(" ")).not.toMatch(/turn-in point/)
  })
})

describe("a gap in a car's recording", () => {
  const track = new Track(parseFastLane(fastLane(loop("left"))))

  it("places the car correctly after the gap, however far it went", async () => {
    // 5 s at 60 m/s is 300 m, round the corner and past the window a
    // projection hint from before the gap searches.
    const path = await writeScenario(
      dir,
      "gap",
      track,
      [
        {
          carId: 1,
          driver: "Gappy",
          s: (t) => 100 + 60 * (t / 1000),
          across: () => 0,
          gap: [3000, 8000],
        },
        { carId: 2, driver: "Steady", s: (t) => 80 + 60 * (t / 1000), across: () => 0 },
      ],
      { at: 9000, carId: 2, otherCarId: 1 },
    )
    const packet = await buildIncident(path, 0, track)
    // The first row after the gap; Gappy runs 20 m ahead of Steady throughout.
    const row = packet.timeline.find((r) => r.t > -5 && r.b)
    expect(Math.abs(row!.b!.s - row!.a!.s - 20)).toBeLessThan(1)
  })
})

describe("off the track before the contact", () => {
  const track = new Track(parseFastLane(fastLane(loop("left"))))
  // The track is 12 m wide: anything beyond 6 m from the middle is off it.
  const scenario = async (name: string, wide: (t: number) => number) => {
    const path = await writeScenario(
      dir,
      name,
      track,
      [
        { carId: 1, driver: "Wide", s: (t) => 100 + 30 * (t / 1000), across: wide },
        { carId: 2, driver: "Inside", s: (t) => 101 + 30 * (t / 1000), across: () => 4.5 },
      ],
      { at: 5000, carId: 1, otherCarId: 2 },
    )
    return (await buildIncident(path, 0, track)).measured.rejoining
  }

  it("counts a car coming back from well beyond the edge as rejoining", async () => {
    expect((await scenario("rejoin", (t) => lerp(7.8, 6.4, 3600, 5000, t))).a?.maxOffM).toBeCloseTo(
      1.8,
      0,
    )
  })

  it("doesn't count a car using the kerb, just over the edge, as rejoining", async () => {
    expect((await scenario("kerb", () => 6.5)).a).toBeNull()
  })
})

describe("a dive from too far back", () => {
  const track = new Track(parseFastLane(fastLane(loop("left"))))

  it("doesn't blame the car ahead for turning in", async () => {
    // Leader brakes and sweeps from the right edge to the apex; Diver is 3.9 m
    // back at the turn-in, holds the inside and is alongside by the contact.
    // Turning in looked like a move across the track under braking.
    const path = await writeScenario(
      dir,
      "dive",
      track,
      [
        {
          carId: 1,
          driver: "Leader",
          s: (t) => 200 + 30 * (t / 1000),
          across: (t) => lerp(-4, 4, 3100, 4100, t),
          braking: (t) => t >= 2500,
        },
        {
          carId: 2,
          driver: "Diver",
          s: (t) => 194 + 30 * (t / 1000) + (3 * Math.max(0, t - 2500)) / 1000,
          across: () => 4,
          braking: (t) => t >= 3300,
        },
      ],
      { at: 4000, carId: 2, otherCarId: 1 },
    )
    const s = suggest(await buildIncident(path, 0, track), DEFAULT_THRESHOLDS)
    expect([s.call, s.rule]).toEqual(["A", "no-overlap-at-turn-in"])
  })
})

describe("a car coming back from the run-off, hit from behind", () => {
  const track = new Track(parseFastLane(fastLane(loop("left"))))

  it("doesn't blame the car that was hit for rejoining", async () => {
    // Leader is 1.3 m past the edge on the exit of T2, drifting back on
    // without moving across; Rammer, on the track behind, runs into it.
    const path = await writeScenario(
      dir,
      "runoff",
      track,
      [
        { carId: 1, driver: "Rammer", s: (t) => 400 + 35 * (t / 1000), across: () => 5.8 },
        {
          carId: 2,
          driver: "Leader",
          s: (t) => 414 + 33 * (t / 1000),
          across: (t) => lerp(7.3, 6.8, 3500, 5000, t),
        },
      ],
      { at: 5000, carId: 1, otherCarId: 2 },
    )
    const packet = await buildIncident(path, 0, track)
    expect(packet.measured.rejoining.b).not.toBeNull()
    expect(suggest(packet, DEFAULT_THRESHOLDS).call).toBe("A")
  })
})

describe("holes in the recording", () => {
  const track = new Track(parseFastLane(fastLane(loop("left"))))

  it("measures no contact when neither car was recorded near the report", async () => {
    // B's samples are missing from 3 s to 6.5 s, the report at 6 s. The
    // contact used to be read off the nearest row with both, 0.6 s after it.
    const path = await writeScenario(
      dir,
      "hole-contact",
      track,
      [
        { carId: 1, driver: "A", s: (t) => 100 + 30 * (t / 1000), across: () => 0 },
        {
          carId: 2,
          driver: "B",
          s: (t) => 106 + 30 * (t / 1000),
          across: () => 0,
          gap: [3000, 6500],
        },
      ],
      { at: 6000, carId: 1, otherCarId: 2 },
    )
    const packet = await buildIncident(path, 0, track)
    expect(packet.measured.contact).toBeNull()
    expect(suggest(packet, DEFAULT_THRESHOLDS).call).toBe("unclear")
  })

  it("doesn't count an overlap as unbroken across a hole", async () => {
    // Side by side throughout, B unrecorded from 3 s to 5 s: the overlap is
    // known only from 5 s, 2 s before the contact.
    const path = await writeScenario(
      dir,
      "hole-overlap",
      track,
      [
        { carId: 1, driver: "A", s: (t) => 100 + 30 * (t / 1000), across: () => -2 },
        {
          carId: 2,
          driver: "B",
          s: (t) => 101 + 30 * (t / 1000),
          across: () => 2,
          gap: [3000, 5000],
        },
      ],
      { at: 7000, carId: 1, otherCarId: 2 },
    )
    const { measured } = await buildIncident(path, 0, track)
    expect(measured.overlapFromT).toBeGreaterThanOrEqual(-2)
  })

  it("doesn't take the first row after a hole as the turn-in", async () => {
    // Leader is unrecorded from 0.5 s before T1's entry, at 292 m, until
    // 40 m past it.
    const path = await writeScenario(
      dir,
      "hole-turnin",
      track,
      [
        {
          carId: 1,
          driver: "Leader",
          s: (t) => 200 + 30 * (t / 1000),
          across: () => 0,
          gap: [2000, 4500],
        },
        { carId: 2, driver: "Follower", s: (t) => 190 + 32 * (t / 1000), across: () => 0 },
      ],
      { at: 5000, carId: 2, otherCarId: 1 },
    )
    const { measured } = await buildIncident(path, 0, track)
    expect(measured.turnIn).toBeNull()
  })
})

describe("moves the turn-in rule mustn't excuse", () => {
  const track = new Track(parseFastLane(fastLane(loop("left"))))
  // T1 runs from 292 m to 372 m. Leader is car 1, the follower car 2, which
  // the server reports as hitting.
  it.each<[string, ScriptedCar, ScriptedCar, number, string, string]>([
    [
      "a squeeze on the exit, on a follower who got alongside after the turn-in",
      {
        carId: 1,
        driver: "L",
        s: (t) => 200 + 30 * (t / 1000),
        across: (t) => lerp(0, -2.3, 4000, 5500, t),
      },
      {
        carId: 2,
        driver: "F",
        s: (t) => 195 + 30 * (t / 1000) + lerp(0, 3.5, 3500, 4000, t),
        across: () => -3,
      },
      5500,
      "B",
      "moved-across",
    ],
    [
      "a block under braking just before the turn-in",
      {
        carId: 1,
        driver: "L",
        s: (t) => 200 + 30 * (t / 1000),
        across: (t) => lerp(-4, 2.4, 2000, 2900, t),
        braking: (t) => t >= 2000,
      },
      {
        carId: 2,
        driver: "F",
        s: (t) => 197 + 30 * (t / 1000),
        across: () => 3,
        braking: (t) => t >= 2100,
      },
      3300,
      "B",
      "braking-zone-move",
    ],
    [
      "running wide, then back across a follower who took the inside",
      {
        carId: 1,
        driver: "L",
        s: (t) => 200 + 30 * (t / 1000),
        across: (t) => (t < 4200 ? lerp(-4, -5, 3100, 4200, t) : lerp(-5, 1, 4200, 5300, t)),
      },
      {
        carId: 2,
        driver: "F",
        s: (t) => 196 + 30 * (t / 1000) + lerp(0, 2.2, 3600, 4400, t),
        across: () => 3,
      },
      5400,
      "B",
      "moved-across",
    ],
    [
      "rejoining from the run-off across the follower's nose",
      {
        carId: 1,
        driver: "L",
        s: (t) => 200 + 30 * (t / 1000),
        across: (t) => (t < 4800 ? lerp(-4, -8, 3500, 4500, t) : lerp(-8, -3, 4800, 5500, t)),
      },
      {
        carId: 2,
        driver: "F",
        s: (t) => 195 + 30 * (t / 1000) + lerp(0, 1.8, 4000, 5000, t),
        across: () => -3,
      },
      5500,
      "B",
      "rejoin",
    ],
  ])("blames the car ahead for %s", async (name, leader, follower, at, call, rule) => {
    const path = await writeScenario(dir, name.replace(/\W+/g, "-"), track, [leader, follower], {
      at,
      carId: 2,
      otherCarId: 1,
    })
    const s = suggest(await buildIncident(path, 0, track), DEFAULT_THRESHOLDS)
    expect([s.call, s.rule]).toEqual([call, rule])
  })
})
