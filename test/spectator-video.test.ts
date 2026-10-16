import { spawnSync } from "node:child_process"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCanvas } from "@napi-rs/canvas"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { JournalWriter, type JournalRecord } from "../src/spectator/journal.js"
import type { CarState } from "ac-spectator"
import { parseFastLane, Track } from "../src/spectator/track.js"
import {
  type CarTrack,
  drawFrame,
  ffmpegSink,
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

/** What `f` gives once it gives something, within two seconds. */
async function until<T>(f: () => T | undefined | Promise<T | undefined>): Promise<T> {
  for (let i = 0; i < 40; i++) {
    const v = await Promise.resolve(f()).catch(() => undefined)
    if (v !== undefined) return v
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error("gave up waiting")
}

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

  it("turns the short way across ±π, not back through 0", () => {
    const c = { ...car([0, 100], [0, 0]), yaw: [3.1, -3.1] }
    expect(Math.abs(poseAt(c, 50)!.yaw)).toBeCloseTo(Math.PI, 1)
  })

  it.each([
    ["a gap in its recording", [0, 5000], [0, 500]],
    ["a reset, 400 m in 50 ms", [0, 50], [0, 400]],
  ])("draws no car across %s, rather than gliding it", (_, t, x) => {
    expect(poseAt(car(t, x), t[1]! / 2)).toBeUndefined()
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
    const view = frameView(clip, 1000, 16 / 9)!
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

  it("points a car's arrow the way it's heading", () => {
    // Facing yaw π/2, which is AC's -x: left on screen. Away from the track, at
    // a zoom where the arrow is 36 px long.
    const c: CarTrack = {
      ...car([0, 100], [500, 500]),
      z: [500, 500],
      yaw: [Math.PI / 2, Math.PI / 2],
    }
    const clip = {
      track,
      session: { name: "Race", track: "loop" },
      cars: [c],
      hits: [],
      fromMs: 0,
      toMs: 100,
    }
    const canvas = createCanvas(320, 180)
    const ctx = canvas.getContext("2d")
    drawFrame(ctx, clip, 50, { cx: 500, cz: 500, span: 40 }, 320, 180)
    const at = (x: number) => [...ctx.getImageData(x, 90, 1, 1).data].slice(0, 3)
    expect([at(160 - 15), at(160 + 18)]).toEqual([
      [0xd9, 0x4f, 0x0f],
      [0xec, 0xee, 0xe8],
    ])
  })

  it("draws no trail across the map from where a car was reset", () => {
    // Sat at x=0, then put back on 400 m away; the frame looks at the middle.
    const c = car([0, 1000, 1050, 2000], [0, 0, 400, 400])
    const middle = (cars: CarTrack[]) => {
      const clip = {
        track,
        session: { name: "Race", track: "loop" },
        cars,
        hits: [],
        fromMs: 0,
        toMs: 2000,
      }
      const ctx = createCanvas(320, 180).getContext("2d")
      drawFrame(ctx, clip, 2000, { cx: 200, cz: 0, span: 500 }, 320, 180)
      return [...ctx.getImageData(160, 90, 1, 1).data]
    }
    expect(middle([c])).toEqual(middle([]))
  })

  it.each([
    ["exits early", "false", /ffmpeg failed/],
    ["isn't there", "champctl-no-such-ffmpeg", /needs ffmpeg/],
  ])("fails, rather than hangs, when ffmpeg %s", async (_, command, message) => {
    const clip = await loadClip(journal, track, { fromMs: 1000, toMs: 2000 })
    const sink = ffmpegSink(join(dir, "x.mp4"), 64, 36, 10, command)
    await expect(
      writeVideo(clip, sink, { fromMs: 1000, toMs: 2000, width: 64, height: 36, fps: 10 }),
    ).rejects.toThrow(message)
  })

  it("stops ffmpeg when the video stops partway", async () => {
    // An ffmpeg that would wait for frames forever, and says who it is.
    const pidFile = join(dir, "waits.pid")
    const waits = join(dir, "waits")
    await writeFile(waits, `#!/bin/sh\necho $$ > ${pidFile}\nexec cat > /dev/null\n`)
    await chmod(waits, 0o755)
    const clip = await loadClip(journal, track, { fromMs: 1000, toMs: 2000 })
    const broken = {
      ...clip,
      get cars(): never {
        throw new Error("can't draw this")
      },
    }
    const sink = ffmpegSink(join(dir, "y.mp4"), 64, 36, 10, waits)
    // Running and waiting, before anything goes wrong.
    const pid = await until(async () => Number(await readFile(pidFile, "utf8")) || undefined)
    await expect(
      writeVideo(broken, sink, { fromMs: 1000, toMs: 2000, width: 64, height: 36, fps: 10 }),
    ).rejects.toThrow("can't draw this")
    expect(
      await until(() => {
        try {
          process.kill(pid, 0)
          return undefined
        } catch {
          return true
        }
      }),
    ).toBe(true)
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
      abort: () => {},
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

describe("champctl-spectator video", () => {
  it("leaves no half-written video behind when ffmpeg fails", async () => {
    // An ffmpeg that writes the start of a file and then gives up.
    const bin = join(dir, "bin")
    await mkdir(bin, { recursive: true })
    await writeFile(
      join(bin, "ffmpeg"),
      '#!/bin/sh\nfor a; do last="$a"; done\necho half > "$last"\nexit 1\n',
    )
    await chmod(join(bin, "ffmpeg"), 0o755)
    const lane = join(dir, "ac", "content", "tracks", "loop", "ai")
    await mkdir(lane, { recursive: true })
    await writeFile(join(lane, "fast_lane.ai"), fastLane(loop("left")))
    const out = join(dir, "out")
    await mkdir(out, { recursive: true })
    const run = spawnSync(
      join("node_modules", ".bin", "tsx"),
      [
        "src/cli/spectator.ts",
        "video",
        journal,
        "--ac-root",
        join(dir, "ac"),
        "--from",
        "0:01",
        "--to",
        "0:02",
        "--out",
        join(out, "v.mp4"),
      ],
      { env: { ...process.env, PATH: `${bin}:${process.env["PATH"]}` }, encoding: "utf8" },
    )
    expect(run.status).not.toBe(0)
    expect(await readdir(out)).toEqual([])
  }, 30_000)
})
