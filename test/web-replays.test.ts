import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import Fastify, { type FastifyInstance } from "fastify"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { writeJournalReplay } from "../src/spectator/replay.js"
import { JournalWriter, type JournalRecord } from "../src/spectator/journal.js"
import type { CarState } from "ac-spectator"
import { listReplays, registerReplays } from "../src/web/replays.js"

let dir: string
let app: FastifyInstance
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "replays-"))
  app = Fastify()
  registerReplays(app, dir, "America/Los_Angeles")
})
afterEach(async () => {
  await app.close()
  await rm(dir, { recursive: true, force: true })
})

const car = (carId: number, timestamp: number): CarState => ({
  carId,
  seq: 0,
  timestamp,
  ping: 0,
  pos: [0, 0, 0],
  rot: [0, 0, 0],
  vel: [0, 0, 0],
  steer: 0,
  rpm: 3000,
  gear: 3,
  statusFlags: 0,
})

/** A recorded session and its replay, named the way the recorder names them. */
async function recorded(
  stem: string,
  name: string,
  seconds: number,
  cars = 2,
  track = "interlagos_1975",
): Promise<void> {
  await mkdir(dirname(join(dir, stem)), { recursive: true })
  const w = new JournalWriter(join(dir, `${stem}.ndjson.gz`))
  const records: JournalRecord[] = [
    {
      t: "session",
      at: 0,
      serverName: "s",
      track,
      trackConfig: "",
      name,
      type: 1,
      recorderCarId: 30,
    },
  ]
  for (let id = 1; id <= cars; id++) {
    records.push(
      { t: "pos", at: 0, car: car(id, 0) },
      { t: "pos", at: 0, car: car(id, seconds * 1000) },
    )
  }
  for (const r of records) w.write(r)
  await w.close()
  await writeJournalReplay(w.path, join(dir, `${stem}.acreplay`), { intervalMs: 1000 })
}

describe("listReplays", () => {
  it("lists each replay newest first, with its track, session, length and cars", async () => {
    await recorded("2026-10-13T03-38-46-326Z-interlagos-1975-practice", "Practice", 698, 7)
    await recorded("2026-10-14T03-00-00-000Z-interlagos-1975-race", "Race", 3600)
    expect(
      (await listReplays(dir)).map((r) => [r.session, r.track, r.durationS, r.cars, r.started]),
    ).toEqual([
      ["Race", "interlagos_1975", 3600, 2, Date.parse("2026-10-14T03:00:00.000Z")],
      ["Practice", "interlagos_1975", 698, 7, Date.parse("2026-10-13T03:38:46.326Z")],
    ])
  })

  it("reads a replay once, not on every view", async () => {
    const stem = "2026-10-13T03-38-46-326Z-interlagos-1975-practice"
    await recorded(stem, "Practice", 698)
    await listReplays(dir)
    // The session's name came from the journal; a second read would lose it.
    await rm(join(dir, `${stem}.ndjson.gz`))
    expect((await listReplays(dir))[0]?.session).toBe("Practice")
  })

  it("leaves out a file that isn't a replay rather than failing the page", async () => {
    await writeFile(join(dir, "2026-10-13T00-00-00-000Z-x.acreplay"), "half")
    expect(await listReplays(dir)).toEqual([])
  })
})

describe("/replays", () => {
  it("shows the page at /replays/ too, where a proxy's location block sends it", async () => {
    const page = await app.inject({ url: "/replays/" })
    expect([page.statusCode, page.headers["content-type"]]).toEqual([
      200,
      "text/html; charset=utf-8",
    ])
  })

  it("shows the replays in the league's time zone, linked for download", async () => {
    await recorded("2026-10-13T03-38-46-326Z-interlagos-1975-practice", "Practice", 698)
    const page = await app.inject({ url: "/replays" })
    expect(page.headers["content-type"]).toMatch(/text\/html/)
    // 03:38 UTC is 8:38 the evening before in California.
    expect(page.body).toMatch(/Oct 12, 2026, 8:38\sPM/)
    expect(page.body).toContain(
      'href="/replays/2026-10-13T03-38-46-326Z-interlagos-1975-practice.acreplay"',
    )

    const file = await app.inject({
      url: "/replays/2026-10-13T03-38-46-326Z-interlagos-1975-practice.acreplay",
    })
    expect(file.statusCode).toBe(200)
    expect(file.headers["content-disposition"]).toMatch(/^attachment/)
    expect(file.rawPayload.readUInt32LE(0)).toBe(16)
  })

  it("groups the replays by round, newest round first, and serves them from its folder", async () => {
    const week = "2026-10-13-interlagos-1975"
    await recorded(`${week}/2026-10-13T15-40-38-726Z-interlagos-1975-practice`, "Practice", 600)
    await recorded(`${week}/2026-10-15T03-24-29-113Z-interlagos-1975-race`, "Race", 1500)
    await recorded(
      "2026-10-14-riverside/2026-10-15T04-15-47-173Z-riverside-practice",
      "Practice",
      300,
      2,
      "riverside",
    )
    await recorded("2026-10-01T03-00-00-000Z-imola-race", "Race", 300)
    const page = (await app.inject({ url: "/replays" })).body
    const headings = [...page.matchAll(/<h2>(.*?)<\/h2>/g)].map((m) => m[1])
    expect(headings).toEqual([
      "riverside · Oct 14",
      "interlagos_1975 · Oct 13 – Oct 14",
      "Earlier recordings",
    ])
    const file = await app.inject({
      url: `/replays/${week}/2026-10-15T03-24-29-113Z-interlagos-1975-race.acreplay`,
    })
    expect(file.statusCode).toBe(200)
    expect(file.headers["content-disposition"]).toBe(
      'attachment; filename="2026-10-15T03-24-29-113Z-interlagos-1975-race.acreplay"',
    )
    // A link posted to Discord before the replay was filed into its round.
    const old = await app.inject({
      url: "/replays/2026-10-15T03-24-29-113Z-interlagos-1975-race.acreplay",
    })
    expect(old.statusCode).toBe(200)
  })

  it.each([
    "..%2F..%2Fetc%2Fpasswd",
    "missing.acreplay",
    "2026-10-13T03-38-46-326Z-x.ndjson.gz",
    "..%2F2026-10-13T03-38-46-326Z-x.acreplay",
    "2026-10-13-x/..%2F2026-10-13T03-38-46-326Z-x.acreplay",
  ])("refuses %s", async (file) => {
    await recorded("2026-10-13T03-38-46-326Z-x", "Practice", 300)
    expect((await app.inject({ url: `/replays/${file}` })).statusCode).toBe(404)
  })
})
