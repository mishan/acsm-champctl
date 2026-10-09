/**
 * Each rule against measurements built to be exactly its case, plus the
 * neighbors it must not fire on. The staged incident end to end is in
 * spectator-incident.test.ts.
 */

import { describe, expect, it } from "vitest"

import {
  type CarFrame,
  DEFAULT_THRESHOLDS,
  type IncidentPacket,
  type Measurements,
  type Move,
} from "../src/spectator/incident.js"
import { suggest } from "../src/spectator/rules.js"

const frame = (lateralM = 0): CarFrame => ({
  s: 100,
  speedKmh: 150,
  lateralM,
  acrossM: lateralM,
  offTrackM: 0,
  braking: false,
  gas: 1,
  steer: 0,
  gear: 4,
  pos: [0, 0, 0],
  yaw: 0,
})
const held: Move = { movedM: 0.1, overS: 1.4, toward: false, braking: false }
const across = (braking = false): Move => ({ movedM: 1.5, overS: 1.4, toward: true, braking })

/** A side by side contact with nothing decisive in it; each case changes what it needs. */
function measured(over: Partial<Measurements>): Measurements {
  return {
    start: { t: -8, leader: "b", gapM: 10, gapS: 0.3, s: 50 },
    overlapFromT: -1,
    contact: { t: 0, gapM: 1, separationM: 2, a: frame(-1.5), b: frame(0) },
    braking: { a: null, b: null, later: null },
    turnIn: null,
    lookbackLeader: "b",
    moves: { a: held, b: held },
    rejoining: { a: null, b: null },
    contactPoint: "front-left",
    haveA: true,
    ...over,
  }
}

const packet = (m: Measurements): IncidentPacket => ({
  session: { track: "t", trackConfig: "", name: "Race", type: 3 },
  collision: {
    index: 0,
    at: 0,
    carId: 1,
    otherCarId: 2,
    impactSpeedKmh: 10,
    relPos: [0, 0, 0],
    drivers: [],
    where: "T1",
  },
  a: { carId: 1, driver: "Ana", model: "m" },
  b: { carId: 2, driver: "Bo", model: "m" },
  timeline: [],
  measured: m,
  facts: [],
})

describe("suggest", () => {
  it.each<[string, Partial<Measurements>, string, string | undefined]>([
    [
      "A rejoined from off the track into B",
      { rejoining: { a: { maxOffM: 2 }, b: null }, moves: { a: across(), b: held } },
      "A",
      "rejoin",
    ],
    [
      "B, coming back from off the track ahead, was run into from behind",
      {
        overlapFromT: null,
        rejoining: { a: null, b: { maxOffM: 2 } },
        moves: { a: held, b: { ...held, toward: true } },
      },
      "A",
      "from-behind",
    ],
    [
      "B moved under braking, but A had only just passed into the lead",
      { lookbackLeader: null, moves: { a: held, b: across(true) } },
      "B",
      "moved-across",
    ],
    [
      "A wasn't overlapping at turn-in, but had been ahead earlier in the lookback",
      {
        overlapFromT: null,
        lookbackLeader: null,
        contact: { t: 0, gapM: 3, separationM: 3, a: frame(-1.5), b: frame(0) },
        turnIn: {
          corner: "T1",
          t: -0.5,
          leader: "b",
          behindM: 4,
          overlapping: false,
          leaderMovedM: 0,
        },
      },
      "A",
      "from-behind",
    ],
    [
      "B, ahead, moved toward A under braking",
      { moves: { a: held, b: across(true) } },
      "B",
      "braking-zone-move",
    ],
    [
      "A wasn't overlapping at turn-in and B held its line",
      {
        overlapFromT: null,
        turnIn: {
          corner: "T1",
          t: -0.5,
          leader: "b",
          behindM: 4,
          overlapping: false,
          leaderMovedM: 0,
        },
      },
      "A",
      "no-overlap-at-turn-in",
    ],
    [
      "A wasn't overlapping at turn-in, then B turned in under braking",
      {
        moves: { a: held, b: across(true) },
        turnIn: {
          corner: "T1",
          t: -0.5,
          leader: "b",
          behindM: 4,
          overlapping: false,
          leaderMovedM: 0,
        },
      },
      "A",
      "no-overlap-at-turn-in",
    ],
    ["A, overlapping, moved across B", { moves: { a: across(), b: held } }, "A", "moved-across"],
    [
      "B, ahead at turn-in with A overlapping, turned in on A",
      {
        moves: { a: held, b: across() },
        turnIn: {
          corner: "T1",
          t: -0.5,
          leader: "b",
          behindM: 1.5,
          overlapping: true,
          leaderMovedM: 0,
        },
      },
      "B",
      "moved-across",
    ],
    [
      "both moved toward each other",
      { moves: { a: across(), b: across() } },
      "racing incident",
      "both-moved",
    ],
    ["A ran into B from behind", { overlapFromT: null }, "A", "from-behind"],
    ["side by side, nobody moved", {}, "unclear", undefined],
    ["A not recorded", { haveA: false }, "unclear", undefined],
  ])("%s", (_, over, call, rule) => {
    const s = suggest(packet(measured(over)), DEFAULT_THRESHOLDS)
    expect([s.call, s.rule]).toEqual([call, rule])
    expect(s.reasons.length).toBeGreaterThan(0)
  })

  it("takes its idea of a move from the thresholds", () => {
    const m = measured({ moves: { a: across(), b: held } })
    expect(suggest(packet(m), { ...DEFAULT_THRESHOLDS, moveM: 2 }).call).toBe("unclear")
  })
})
