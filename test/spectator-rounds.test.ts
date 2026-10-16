import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { JournalWriter } from "../src/spectator/journal.js"
import {
  lastRound,
  localDate,
  organize,
  type Round,
  raceNumbers,
  roundFor,
} from "../src/spectator/rounds.js"

describe("roundFor", () => {
  const practiceServer = { index: 0, count: 1 }
  const event = (index: number) => ({ index, count: 4 })
  const going: Round = { folder: "2026-10-13-interlagos", place: "interlagos", over: false }
  const over: Round = { ...going, over: true }
  it.each([
    ["the practice server again", going, "interlagos", practiceServer, going],
    ["the event's practice after the week's", going, "interlagos", event(0), going],
    ["the event's last race", going, "interlagos", event(3), over],
    ["a rejoin in the event's last race", over, "interlagos", event(3), over],
    [
      "practice after the event, on the same track",
      over,
      "interlagos",
      practiceServer,
      { folder: "2026-10-14-interlagos", place: "interlagos", over: false },
    ],
    [
      "a new track",
      going,
      "riverside",
      practiceServer,
      { folder: "2026-10-14-riverside", place: "riverside", over: false },
    ],
    [
      "the first session there's been",
      undefined,
      "riverside",
      practiceServer,
      { folder: "2026-10-14-riverside", place: "riverside", over: false },
    ],
  ])("puts %s in the right round", (_, last, place, session, round) => {
    expect(roundFor(last, { place, ...session }, "2026-10-14", () => false)).toEqual(round)
  })

  it("numbers a second round that would take the same name", () => {
    const taken = new Set(["2026-10-14-interlagos"])
    expect(
      roundFor(over, { place: "interlagos", ...{ index: 0, count: 1 } }, "2026-10-14", (f) =>
        taken.has(f),
      ).folder,
    ).toBe("2026-10-14-interlagos-2")
  })

  it("dates a round by the league's day, not UTC's", () => {
    // 02:00 UTC on the 15th is 7 PM on the 14th in California.
    expect(localDate(new Date("2026-10-15T02:00:00Z"), "America/Los_Angeles")).toBe("2026-10-14")
  })
})

describe("organize", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rounds-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  /** A journal from before rounds, last written an hour ago unless `live`. */
  const journal = async (stem: string, track: string, extra: string[] = [], live = false) => {
    const w = new JournalWriter(join(dir, `${stem}.ndjson.gz`))
    w.write({
      t: "session",
      at: 0,
      serverName: "s",
      track,
      trackConfig: "",
      name: "Practice",
      type: 1,
      recorderCarId: 0,
    })
    await w.close()
    for (const f of extra) await writeFile(join(dir, f), "replay")
    if (live) return
    const anHourAgo = new Date(Date.now() - 3600_000)
    for (const f of [`${stem}.ndjson.gz`, ...extra])
      await utimes(join(dir, f), anHourAgo, anHourAgo)
  }

  it("files each run of sessions on a track as a round, replays and clips with them", async () => {
    const a = "2026-10-13T15-40-38-726Z-interlagos-practice"
    const b = "2026-10-15T03-24-29-113Z-interlagos-race"
    const c = "2026-10-15T04-15-47-173Z-riverside-practice"
    await journal(a, "interlagos")
    await journal(b, "interlagos", [`${b}.acreplay`, `${b}-12m35s-13m40s.acreplay`])
    await journal(c, "riverside")
    // Still being recorded.
    await journal("2026-10-15T08-51-37-934Z-riverside-practice", "riverside", [], true)

    const preview = await organize(dir, "America/Los_Angeles", { dryRun: true })
    expect(await readdir(dir)).toHaveLength(6)

    expect(await organize(dir, "America/Los_Angeles")).toEqual(preview)
    const byName = (a: { from: string }, b: { from: string }) => a.from.localeCompare(b.from)
    expect([...preview].sort(byName)).toEqual(
      [
        { from: `${a}.ndjson.gz`, to: `2026-10-13-interlagos/${a}.ndjson.gz` },
        { from: `${b}.ndjson.gz`, to: `2026-10-13-interlagos/${b}.ndjson.gz` },
        { from: `${b}.acreplay`, to: `2026-10-13-interlagos/${b}.acreplay` },
        {
          from: `${b}-12m35s-13m40s.acreplay`,
          to: `2026-10-13-interlagos/${b}-12m35s-13m40s.acreplay`,
        },
        // 04:15 UTC on the 15th is the evening of the 14th in California.
        { from: `${c}.ndjson.gz`, to: `2026-10-14-riverside/${c}.ndjson.gz` },
      ].sort(byName),
    )
    expect((await readdir(dir)).sort()).toEqual([
      "2026-10-13-interlagos",
      "2026-10-14-riverside",
      "2026-10-15T08-51-37-934Z-riverside-practice.ndjson.gz",
    ])
  })
})

describe("lastRound", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rounds-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const session = async (folder: string, stem: string, index: number, count: number) => {
    await mkdir(join(dir, folder), { recursive: true })
    const w = new JournalWriter(join(dir, folder, `${stem}.ndjson.gz`))
    w.write({
      t: "session",
      at: 0,
      serverName: "s",
      track: "interlagos",
      trackConfig: "1975",
      name: "Race",
      type: 3,
      sessionIndex: index,
      sessionCount: count,
      recorderCarId: 0,
    })
    await w.close()
  }

  it.each([
    ["still going after the event's first race", 2, false],
    ["over once its last race began", 3, true],
  ])("finds the newest round on disk, %s", async (_, index, over) => {
    await session("2026-10-06-monza", "2026-10-08T03-00-00-000Z-monza-race", 3, 4)
    await session(
      "2026-10-13-interlagos-1975",
      "2026-10-15T03-24-29-113Z-interlagos-1975-race",
      index,
      4,
    )
    expect(await lastRound(dir)).toEqual({
      folder: "2026-10-13-interlagos-1975",
      place: "interlagos-1975",
      over,
    })
  })

  it("goes past a newest journal with nothing in it, left by a recorder killed as it began", async () => {
    await session(
      "2026-10-13-interlagos-1975",
      "2026-10-15T03-24-29-113Z-interlagos-1975-race",
      2,
      4,
    )
    await new JournalWriter(
      join(
        dir,
        "2026-10-13-interlagos-1975",
        "2026-10-15T03-49-57-114Z-interlagos-1975-race.ndjson.gz",
      ),
    ).close()
    expect((await lastRound(dir))?.folder).toBe("2026-10-13-interlagos-1975")
  })
})

describe("raceNumbers", () => {
  // 8:24 and 8:50 PM in California on the 14th, and the next week's race.
  const at = (iso: string) => Date.parse(iso)
  const session = (name: string, round: string, started: string) => ({
    name,
    round,
    started: at(started),
  })
  const q = session("Qualify", "r1", "2026-10-15T03:04:00Z")
  const r1 = session("Race", "r1", "2026-10-15T03:24:00Z")
  const r2 = session("Race", "r1", "2026-10-15T03:50:00Z")
  const next = session("Race", "r2", "2026-10-22T03:24:00Z")
  const lone = session("Race", "r3", "2026-10-29T03:24:00Z")
  it("numbers a night's races in the order they started, and nothing else", () => {
    const numbers = raceNumbers(
      [r2, next, q, r1, lone],
      (s) => ({ race: s.name === "Race", round: s.round, started: s.started }),
      "America/Los_Angeles",
    )
    expect([...numbers].map(([s, n]) => [s.started, n]).sort()).toEqual([
      [r1.started, 1],
      [r2.started, 2],
    ])
  })
})
