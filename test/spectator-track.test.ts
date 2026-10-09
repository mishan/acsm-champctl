import { describe, expect, it } from "vitest"

import { parseFastLane, Track } from "../src/spectator/track.js"
import { fastLane, loop, walk } from "./support/synthetic-track.js"

const track = (direction: "left" | "right") => new Track(parseFastLane(fastLane(loop(direction))))

describe("Track", () => {
  it.each(["left", "right"] as const)(
    "finds four %s-handers, numbered in lap order",
    (direction) => {
      const t = track(direction)
      expect(t.corners.map((c) => [c.name, c.direction])).toEqual(
        ["T1", "T2", "T3", "T4"].map((name) => [name, direction]),
      )
      // The first straight is 300 m; T1's tightest point is partway round its arc.
      expect(t.corners[0]!.apex).toBeGreaterThan(300)
      expect(t.corners[0]!.apex).toBeLessThan(300 + (Math.PI / 2) * 40)
    },
  )

  it("measures distance along the line, and puts the left of the car on the positive side", () => {
    // The first straight runs along +z, where AC's left is +x.
    const t = track("left")
    const p = t.project([3, 0, 100])
    expect(p.s).toBeCloseTo(100, 0)
    expect(p.lateral).toBeCloseTo(3, 1)
    expect(t.project([-2, 0, 100]).lateral).toBeCloseTo(-2, 1)
  })

  it("keeps a car on a bridge on the bridge, not the road under it", () => {
    // Up the first straight along x = 0, round, and back across it at z = 80
    // on a bridge 8 m up.
    const points = walk([
      { straight: 200 },
      { turn: "left", degrees: 180, radius: 50 },
      { straight: 100 },
      { turn: "left", degrees: 90, radius: 20 },
      { straight: 200 },
    ])
    const buf = fastLane(points)
    points.forEach(([x, z], i) => {
      if (i > 100 && Math.abs(z - 80) < 1 && x < 79) buf.writeFloatLE(8, 16 + i * 20 + 4)
    })
    const t = new Track(parseFastLane(buf))
    expect(t.project([0, 0, 80]).s).toBeCloseTo(80, 0)
    expect(t.project([0, 8, 80]).s).toBeGreaterThan(400)
  })

  it("says how far past the edge a car is", () => {
    expect(track("left").project([8.5, 0, 100]).offTrack).toBeCloseTo(2.5, 1)
    expect(track("left").project([5, 0, 100]).offTrack).toBe(0)
  })

  it("names places the way a steward would", () => {
    const t = track("left")
    const t1 = t.corners[0]!
    expect(t.where(t1.apex)).toBe("T1 apex")
    expect(t.where(t1.entry - 100)).toBe("100 m before the turn-in to T1")
    expect(t.where(t1.exit + 60)).toMatch(/^\d+ m past the exit of T1$/)
  })

  it("measures gaps the short way round the lap", () => {
    const t = track("left")
    expect(t.gap(t.length - 5, 5)).toBeCloseTo(10, 3)
    expect(t.gap(5, t.length - 5)).toBeCloseTo(-10, 3)
  })

  it("refuses a racing line in a version nobody has measured", () => {
    const buf = fastLane(loop("left"))
    buf.writeUInt32LE(8, 0)
    expect(() => parseFastLane(buf)).toThrow(/version 8/)
  })
})
