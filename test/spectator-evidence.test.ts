import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { gatherEvidence } from "../src/spectator/evidence.js"
import { parseFastLane, Track } from "ac-ai-line"
import type { FrameSink } from "../src/spectator/video.js"
import { writeScenario } from "./support/incident-scenario.js"
import { fastLane, loop } from "./support/synthetic-track.js"

const track = new Track(parseFastLane(fastLane(loop("left"))))
let dir: string
let journal: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "evidence-"))
  const lane = join(dir, "ac", "content", "tracks", "loop", "ai")
  await mkdir(lane, { recursive: true })
  await writeFile(join(lane, "fast_lane.ai"), fastLane(loop("left")))
  // Side by side down the first straight, B moving across into A; the server
  // reports the contact at 5 s.
  journal = await writeScenario(
    dir,
    "race",
    track,
    [
      { carId: 1, driver: "Ana", s: (t) => 100 + 30 * (t / 1000), across: () => -2 },
      {
        carId: 2,
        driver: "Bo",
        s: (t) => 101 + 30 * (t / 1000),
        across: (t) => (t < 3500 ? 3 : 3 - (t - 3500) / 400),
      },
    ],
    { at: 5000, carId: 2, otherCarId: 1 },
  )
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const frames = () => {
  const got = { frames: 0 }
  const sink = (): FrameSink => ({
    write: async () => {
      got.frames++
    },
    end: async () => {},
    abort: () => {},
  })
  return { got, sink }
}

/** A sink that writes the video as `text`, or fails partway through it. */
const writes =
  (text: string, fail = false) =>
  (video: string): FrameSink => ({
    write: async () => {},
    end: async () => {
      await writeFile(video, text)
      if (fail) throw new Error("ffmpeg failed: out of disk")
    },
    abort: () => {},
  })

// Each draws every frame of a 30 s video, which under a full parallel run takes
// longer than vitest's default 5 s.
describe("gatherEvidence", { timeout: 30_000 }, () => {
  it("measures a reported collision: facts, a call, a drawing, a video and a clip", async () => {
    const { got, sink } = frames()
    const e = await gatherEvidence({
      journal,
      acRoot: join(dir, "ac"),
      outDir: dir,
      stem: "incident-1",
      carIds: [2, 1],
      atMs: 5000,
      collisionIndex: 0,
      videoSink: sink,
    })
    expect(e.summary[0]).toMatch(/^The server reported Bo hitting Ana/)
    expect(e.call?.[0]).toMatch(/^Suggested call: /)
    expect(e.drawing?.subarray(1, 4).toString()).toBe("PNG")
    // From 20 s before (clamped to the session's start) to 10 s after, at 30 fps.
    expect(got.frames).toBe(15 * 30 + 1)
    expect((await readFile(join(dir, e.clip))).readUInt32LE(0)).toBe(16)
  })

  it("says where both cars were when there's no collision to measure", async () => {
    const { sink } = frames()
    const e = await gatherEvidence({
      journal,
      acRoot: join(dir, "ac"),
      outDir: dir,
      stem: "incident-2",
      carIds: [1, 2],
      atMs: 2000,
      videoSink: sink,
    })
    expect(e.call).toBeUndefined()
    expect(e.summary).toEqual([
      "At 0:02 into the session:",
      expect.stringMatching(/^Ana was doing \d+ km\/h, /),
      expect.stringMatching(/^Bo was doing \d+ km\/h, /),
      "They were side by side, 1.0 m apart along the track.",
      // The contact at 5 s is within 10 s of a report about 2 s.
      "The server reported contact between them at 0:05.",
    ])
  })

  const request = (stem: string, videoSink: (video: string) => FrameSink) => ({
    journal,
    acRoot: join(dir, "ac"),
    outDir: dir,
    stem,
    carIds: [1, 2] as [number, number],
    atMs: 2000,
    videoSink,
  })

  it("leaves nothing behind when the video fails", async () => {
    await expect(gatherEvidence(request("incident-3", writes("half", true)))).rejects.toThrow(
      "out of disk",
    )
    expect((await readdir(dir)).filter((f) => f.startsWith("incident-3"))).toEqual([])
  })

  it("leaves an earlier incident's files alone when its stem is used again", async () => {
    await gatherEvidence(request("incident-4", writes("first")))
    await expect(gatherEvidence(request("incident-4", writes("second")))).rejects.toThrow()
    expect(await readFile(join(dir, "incident-4.mp4"), "utf8")).toBe("first")
  })
})
