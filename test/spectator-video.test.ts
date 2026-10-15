import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCanvas } from "@napi-rs/canvas"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { JournalWriter, type JournalRecord } from "../src/spectator/journal.js"
import type { CarState } from "../src/spectator/protocol.js"
import { parseFastLane, Track } from "../src/spectator/track.js"
import {
  type CarTrack,
  drawFrame,
  type FrameSink,
  frameView,
  loadClip,
  poseAt,
  writeVideo,
} from "../src/spectator/video.js"
import { fastLane, loop } from "./support/synthetic-track.js"

const track = new Track(parseFastLane(fastLane(loop("left"))))
let dir: string
let journal: string

const state = (carId: number, s: number): CarState => {
  const p = track.pointAt(s)
  return {
    carId,
    seq: 0,
    timestamp: 0,
    ping: 0,
    pos: [p.x, 0, p.z],
    rot: [0, 0, 0],
    vel: [0, 0, 30],
    steer: 0,
    rpm: 5000,
    gear: 4,
    statusFlags: 0,
  }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "video-"))
  // Two cars on the first straight, 1000 ms of session before the first sample.
  const records: JournalRecord[] = [
    {
      t: "session",
      at: 1000,
      serverName: "s",
      track: "loop",
      trackConfig: "",
      name: "Race",
      type: 3,
      recorderCarId: 0,
    },
    { t: "car", at: 1000, carId: 1, model: "m", skin: "s", driver: "Ricardo Example" },
    { t: "car", at: 1000, carId: 2, model: "m", skin: "s", driver: "Someone Else" },
  ]
  for (let ms = 0; ms <= 4000; ms += 50) {
    records.push({ t: "pos", at: 1000 + ms, car: state(1, 50 + (30 * ms) / 1000) })
    records.push({ t: "pos", at: 1000 + ms, car: state(2, 200 + (30 * ms) / 1000) })
  }
  const w = new JournalWriter(join(dir, "s.ndjson.gz"))
  for (const r of records) w.write(r)
  await w.close()
  journal = w.path
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const car = (t: number[], x: number[]): CarTrack => ({
  carId: 1,
  driver: "d",
  focused: true,
  t,
  x,
  z: x.map(() => 0),
  yaw: x.map(() => 0),
  kmh: x.map(() => 100),
  gear: x.map(() => 3),
})

describe("poseAt", () => {
  it("places a car between its samples", () => {
    expect(poseAt(car([0, 100], [0, 10]), 50)?.x).toBeCloseTo(5)
  })

  it("draws no car across a gap in its recording, rather than gliding it", () => {
    expect(poseAt(car([0, 5000], [0, 500]), 2500)).toBeUndefined()
  })
})

describe("loadClip", () => {
  it("times the stretch from the session's start and marks the cars it follows", async () => {
    const clip = await loadClip(journal, track, { fromMs: 1000, toMs: 2000, focus: ["ricardo"] })
    expect(clip.cars.map((c) => [c.driver, c.focused])).toEqual([
      ["Ricardo Example", true],
      ["Someone Else", false],
    ])
    expect(poseAt(clip.cars[0]!, 1000)?.z).toBeCloseTo(track.pointAt(80).z, 0)
  })

  it("says so when nobody in the stretch has the name asked for", async () => {
    await expect(
      loadClip(journal, track, { fromMs: 0, toMs: 1000, focus: ["nobody"] }),
    ).rejects.toThrow(/"nobody"/)
  })
})

describe("frames", () => {
  it("follows the focused car and paints it, rather than the whole track", async () => {
    const clip = await loadClip(journal, track, { fromMs: 1000, toMs: 2000, focus: ["ricardo"] })
    const view = frameView(clip, 1000, 16 / 9)
    const p = poseAt(clip.cars[0]!, 1000)!
    expect([view.cx, view.cz]).toEqual([p.x, p.z])
    const canvas = createCanvas(320, 180)
    const ctx = canvas.getContext("2d")
    drawFrame(ctx, clip, 1000, view, 320, 180)
    // Just ahead of the middle, where the car is: the first focus color.
    // Antialiased over its trail, so near rather than exactly it; the track
    // and other cars are grays nowhere near it.
    const px = [...ctx.getImageData(160, 92, 1, 1).data].slice(0, 3)
    const focus = [0xd9, 0x4f, 0x0f]
    expect(Math.max(...px.map((v, i) => Math.abs(v - focus[i]!)))).toBeLessThan(40)
  })

  it("writes one frame per 1/fps of the stretch, each the size asked for", async () => {
    const clip = await loadClip(journal, track, { fromMs: 1000, toMs: 2000 })
    const sizes: number[] = []
    let ended = false
    const sink: FrameSink = {
      write: async (rgba) => {
        sizes.push(rgba.length)
      },
      end: async () => {
        ended = true
      },
    }
    const frames = await writeVideo(clip, sink, {
      fromMs: 1000,
      toMs: 2000,
      width: 64,
      height: 36,
      fps: 10,
    })
    expect([frames, ended, new Set(sizes)]).toEqual([11, true, new Set([64 * 36 * 4])])
  })
})
