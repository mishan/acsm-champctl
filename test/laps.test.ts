import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

import { SqliteCache } from "../src/acsm/cache.js"
import { HttpAcsmReader } from "../src/acsm/client.js"
import type { Championship, ResultLap, ResultsListing, SessionResults } from "../src/acsm/types.js"
import { practiceSessions, type ResultsReader } from "../src/laps/practice.js"
import { practiceWindow, proposeLaps, raceMinutes, roundCars } from "../src/laps/propose.js"
import { check } from "../src/gridmom/index.js"
import { lapsForRound } from "../src/laps/round.js"
import { loadProfile } from "../src/profile/load.js"

const CHAMP = "11111111-2222-3333-4444-555555555555"
const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/synthetic/practice-results.json", import.meta.url), "utf8"),
) as SessionResults

function lap(over: Partial<ResultLap> = {}): ResultLap {
  return {
    DriverName: "Driver 1",
    DriverGuid: "76561199000000001",
    CarModel: "jtc_honda_civic_eg_gra",
    LapTime: 60_000,
    Cuts: 0,
    ...over,
  }
}

function sessionWith(laps: ResultLap[], over: Partial<SessionResults> = {}): SessionResults {
  return { ...fixture, Laps: laps, ...over }
}

const CIVIC = new Set(["jtc_honda_civic_eg_gra"])

describe("proposeLaps", () => {
  it("reads a practice file as ACSM writes one", () => {
    const p = proposeLaps([fixture], { cars: CIVIC, minutes: 20 })
    expect(p).toMatchObject({ kind: "laps", laps: 21, best: { lapMs: 57_625 }, validLaps: 1 })
  })

  it.each([
    // 60 s race minutes on 24 s laps is 2.5 laps exactly: half rounds up.
    { minutes: 1, best: 24_000, laps: 3 },
    { minutes: 1, best: 24_001, laps: 2 },
    { minutes: 20, best: 54_694, laps: 22 },
  ])("$minutes min on a $best ms lap is $laps laps", ({ minutes, best, laps }) => {
    const p = proposeLaps([sessionWith([lap({ LapTime: best })])], { cars: CIVIC, minutes })
    expect(p).toMatchObject({ kind: "laps", laps })
  })

  it.each([
    { why: "a cut", over: { Cuts: 1 } },
    { why: "a car not in the round", over: { CarModel: "ford_transit" } },
    { why: "no lap time", over: { LapTime: 0 } },
  ])("ignores a faster lap with $why", ({ over }) => {
    const sessions = [sessionWith([lap({ LapTime: 70_000 }), lap({ LapTime: 50_000, ...over })])]
    expect(proposeLaps(sessions, { cars: CIVIC, minutes: 20 })).toMatchObject({
      kind: "laps",
      best: { lapMs: 70_000 },
      validLaps: 1,
    })
  })

  it("takes the fastest lap across every session and counts who set them", () => {
    const sessions = [
      sessionWith([lap({ LapTime: 61_000 }), lap({ LapTime: 62_000, DriverGuid: "2" })], {
        SessionFile: "a",
      }),
      sessionWith([lap({ LapTime: 59_000, DriverGuid: "3", DriverName: "Driver 3" })], {
        SessionFile: "b",
      }),
    ]
    expect(proposeLaps(sessions, { cars: CIVIC, minutes: 20 })).toMatchObject({
      kind: "laps",
      best: { lapMs: 59_000, driver: "Driver 3", sessionFile: "b" },
      sessions: 2,
      validLaps: 3,
      drivers: 3,
    })
  })

  it("says why there is nothing to propose", () => {
    expect(proposeLaps([], { cars: CIVIC, minutes: 20 })).toEqual({
      kind: "none",
      reason: "nobody has run this round's practice yet",
    })
    const onlyCuts = [sessionWith([lap({ Cuts: 2 })])]
    expect(proposeLaps(onlyCuts, { cars: CIVIC, minutes: 20 })).toEqual({
      kind: "none",
      reason: "none of the 1 practice sessions has a clean lap in the round's cars",
    })
  })
})

describe("raceMinutes", () => {
  const ev = (Time: number, Laps: number) => ({ RaceSetup: { Sessions: { RACE: { Time, Laps } } } })

  it.each([
    { why: "the round's own minutes while it is still timed", ev: ev(40, 0), minutes: 40 },
    { why: "the league's once laps are set", ev: ev(0, 13), minutes: 20 },
    { why: "the league's when neither is set", ev: ev(0, 0), minutes: 20 },
  ])("uses $why", ({ ev, minutes }) => {
    expect(raceMinutes(ev, 20)).toBe(minutes)
  })
})

describe("roundCars", () => {
  it("is the round's cars without the league's furniture", () => {
    const c: Championship = { Classes: [{ AvailableCars: ["other"] }] }
    const ev = { RaceSetup: { Cars: "jtc_honda_civic_eg_gra;ford_transit" } }
    expect([...roundCars(c, ev, ["ford_transit"])]).toEqual(["jtc_honda_civic_eg_gra"])
  })

  it("falls back to the championship's classes when the round names none", () => {
    const c: Championship = {
      Classes: [{ AvailableCars: ["a", "ford_transit"] }, { AvailableCars: ["b"] }],
    }
    expect([...roundCars(c, {}, ["ford_transit"])].sort()).toEqual(["a", "b"])
  })
})

describe("practiceWindow", () => {
  const raced = (completed: string) => ({ CompletedTime: completed })
  const upcoming = (scheduled: string) => ({
    Scheduled: scheduled,
    CompletedTime: "0001-01-01T00:00:00Z",
  })

  it("runs from the end of the previous round to this round's practice start", () => {
    const c: Championship = {
      Events: [raced("2026-10-29T04:17:47Z"), upcoming("2026-11-04T19:00:00-08:00")],
    }
    expect(practiceWindow(c, 1)).toEqual({
      since: new Date("2026-10-29T04:17:47Z"),
      until: new Date("2026-11-05T03:00:00Z"),
    })
  })

  it.each([
    { why: "a first round", before: [] },
    { why: "a round after one not yet raced", before: [upcoming("2026-10-28T19:00:00-07:00")] },
  ])("leaves the start open for $why, so the last race night ends it", ({ before }) => {
    const c: Championship = { Events: [...before, upcoming("2026-11-04T19:00:00-08:00")] }
    expect(practiceWindow(c, before.length)).toEqual({ until: new Date("2026-11-05T03:00:00Z") })
  })

  it.each([{ Scheduled: undefined }, { Scheduled: "0001-01-01T00:00:00Z" }, { Scheduled: "soon" }])(
    "refuses a round whose practice start is $Scheduled",
    ({ Scheduled }) => {
      const c: Championship = { Events: [Scheduled ? { Scheduled } : {}] }
      expect(() => practiceWindow(c, 0)).toThrow(/no practice start/)
    },
  )
})

function listing(date: string, over: Partial<ResultsListing> = {}): ResultsListing {
  const file = `${date}_PRACTICE`
  return {
    track: "rt_lime_rock_park",
    track_layout: "chicane",
    session_type: "PRACTICE",
    date,
    results_json_url: `/results/download/${file}.json`,
    ...over,
  }
}

/** Pages of a results list, newest first, and the files behind them. */
function readerOver(pages: ResultsListing[][], files: Record<string, SessionResults> = {}) {
  const asked = { pages: [] as number[], files: [] as string[] }
  const reader: ResultsReader = {
    async resultsPage(page) {
      asked.pages.push(page)
      return { num_pages: pages.length, results: pages[page] ?? [] }
    },
    async resultFile(name) {
      asked.files.push(name)
      return files[name] ?? sessionWith([lap()], { SessionFile: name, ChampionshipID: CHAMP })
    },
  }
  return { reader, asked }
}

const query = {
  championshipId: CHAMP,
  track: "rt_lime_rock_park",
  layout: "chicane",
  until: new Date("2026-11-05T03:00:00Z"),
}

describe("practiceSessions", () => {
  it("keeps this round's practice files and stops paging once past the window", async () => {
    const { reader, asked } = readerOver([
      [
        listing("2026-11-05T03:00:00Z"), // tonight's practice: outside the window
        listing("2026-11-03T11:42:00Z"),
        listing("2026-11-03T09:42:00Z", { track: "vir" }),
        listing("2026-11-03T05:40:00Z", { track_layout: "full" }),
        listing("2026-11-03T03:40:00Z", { session_type: "QUALIFY" }),
      ],
      [listing("2026-10-30T05:15:00Z"), listing("2026-10-29T03:03:00Z")],
      [listing("2026-10-20T00:00:00Z")],
    ])
    const got = await practiceSessions(reader, {
      ...query,
      since: new Date("2026-10-29T04:17:47Z"),
    })
    expect(got.map((s) => s.SessionFile)).toEqual([
      "2026-11-03T11:42:00Z_PRACTICE",
      "2026-10-30T05:15:00Z_PRACTICE",
    ])
    expect(asked.pages).toEqual([0, 1])
  })

  it("matches a track with no layout, which the list leaves out", async () => {
    const { track_layout: _, ...baku } = listing("2026-11-03T11:42:00Z", { track: "baku" })
    const { reader } = readerOver([[baku]])
    const got = await practiceSessions(reader, {
      ...query,
      track: "baku",
      layout: "",
      since: new Date("2026-11-01T00:00:00Z"),
    })
    expect(got).toHaveLength(1)
  })

  it("drops a file from another championship at the same track", async () => {
    const { reader } = readerOver([[listing("2026-11-03T11:42:00Z")]], {
      "2026-11-03T11:42:00Z_PRACTICE": sessionWith([lap()], { ChampionshipID: "someone-else" }),
    })
    expect(
      await practiceSessions(reader, { ...query, since: new Date("2026-11-01T00:00:00Z") }),
    ).toEqual([])
  })

  it("without a start, stops at the previous race night's race", async () => {
    const { reader, asked } = readerOver([
      [listing("2026-11-03T11:42:00Z"), listing("2026-10-29T13:10:00Z")],
      [
        listing("2026-10-29T04:17:00Z", { track: "thomson", session_type: "RACE" }),
        listing("2026-10-28T16:57:00Z"),
      ],
      [listing("2026-10-20T00:00:00Z")],
    ])
    const got = await practiceSessions(reader, query)
    expect(got).toHaveLength(2)
    expect(asked.pages).toEqual([0, 1])
  })

  it("reads a file once when a new session shifts it onto the next page", async () => {
    const shifted = listing("2026-11-03T09:42:00Z")
    const { reader, asked } = readerOver([
      [listing("2026-11-03T11:42:00Z"), shifted],
      [shifted, listing("2026-10-20T00:00:00Z")],
    ])
    await practiceSessions(reader, { ...query, since: new Date("2026-11-01T00:00:00Z") })
    expect(asked.files).toEqual(["2026-11-03T11:42:00Z_PRACTICE", "2026-11-03T09:42:00Z_PRACTICE"])
  })

  it("keeps paging a list that doesn't say how long it is, until a page comes back empty", async () => {
    const pages = [[listing("2026-11-03T11:42:00Z")], [listing("2026-11-02T11:42:00Z")], []]
    let asked = 0
    const reader: ResultsReader = {
      async resultsPage(page) {
        asked++
        return { results: pages[page] ?? [] }
      },
      resultFile: readerOver([]).reader.resultFile,
    }
    const got = await practiceSessions(reader, {
      ...query,
      since: new Date("2026-11-01T00:00:00Z"),
    })
    expect(got).toHaveLength(2)
    expect(asked).toBe(3)
  })

  it("refuses a list with a row it can't date", async () => {
    const { reader } = readerOver([
      [listing("2026-11-03T11:42:00Z"), listing("2026-11-03T09:42:00Z", { date: "yesterday" })],
    ])
    await expect(
      practiceSessions(reader, { ...query, since: new Date("2026-11-01T00:00:00Z") }),
    ).rejects.toThrow(/no readable date/)
  })

  it("refuses a practice row whose file it can't name", async () => {
    const { reader } = readerOver([
      [listing("2026-11-03T11:42:00Z", { results_json_url: "https://elsewhere/x.json" })],
    ])
    await expect(
      practiceSessions(reader, { ...query, since: new Date("2026-11-01T00:00:00Z") }),
    ).rejects.toThrow(/which file/)
  })

  it("refuses rather than propose from a window it couldn't finish reading", async () => {
    const pages = Array.from({ length: 50 }, (_, i) => [
      listing(new Date(Date.UTC(2026, 10, 3) - i * 3_600_000).toISOString()),
    ])
    const { reader } = readerOver(pages)
    await expect(practiceSessions(reader, { ...query, maxPages: 5 })).rejects.toThrow(/5 pages/)
  })
})

describe("HttpAcsmReader results", () => {
  it("re-reads the list every time and each results file once", async () => {
    // The list shifts a row down a page with every new session, so a cached
    // page beside a fresh one skips or repeats a file; a results file never changes.
    const cache = await SqliteCache.open({ path: ":memory:" })
    const fetched: string[] = []
    const r = new HttpAcsmReader({
      baseUrl: "https://acsm.example",
      rateLimit: false,
      cache,
      fetch: async (url) => {
        fetched.push(String(url))
        return new Response(
          JSON.stringify(String(url).includes("list") ? { results: [] } : fixture),
        )
      },
    })
    await r.resultsPage(0)
    await r.resultsPage(0)
    await r.resultFile("2026_10_29_13_10_PRACTICE")
    await r.resultFile("2026_10_29_13_10_PRACTICE")
    expect(fetched).toEqual([
      "https://acsm.example/api/results/list.json?page=0",
      "https://acsm.example/api/results/list.json?page=0",
      "https://acsm.example/results/download/2026_10_29_13_10_PRACTICE.json",
    ])
    cache.close()
  })
})

describe("lapsForRound", () => {
  const ev = (race: { Laps?: number; Time?: number }) => ({
    ID: "ev1",
    Scheduled: "2026-11-04T19:00:00-08:00",
    RaceSetup: {
      Track: "rt_lime_rock_park",
      TrackLayout: "chicane",
      Cars: "jtc_honda_civic_eg_gra;ford_transit",
      Sessions: { RACE: { Name: "Race", ...race } },
    },
  })
  const champ = (race: { Laps?: number; Time?: number }): Championship => ({
    ID: CHAMP,
    Events: [ev(race)],
  })
  const practice = readerOver([[listing("2026-11-03T11:42:00Z")]], {
    "2026-11-03T11:42:00Z_PRACTICE": sessionWith([lap({ LapTime: 54_694 })], {
      ChampionshipID: CHAMP,
    }),
  }).reader

  async function profileWith(lapCount?: { raceMinutes: number }) {
    const { lapCount: _, ...batl } = await loadProfile("batl")
    return lapCount ? { ...batl, lapCount } : batl
  }

  it("proposes from the round's practice and the league's minutes, and says what it replaces", async () => {
    const r = await lapsForRound(
      practice,
      champ({ Laps: 13 }),
      CHAMP,
      1,
      await profileWith({ raceMinutes: 20 }),
    )
    expect(r).toMatchObject({
      round: 1,
      eventId: "ev1",
      currentLaps: 13,
      proposal: { laps: 22, minutes: 20 },
    })
  })

  it("prefers minutes it was given over the round's and the league's", async () => {
    const r = await lapsForRound(
      practice,
      champ({ Time: 40 }),
      CHAMP,
      1,
      await profileWith({ raceMinutes: 20 }),
      {
        minutes: 10,
      },
    )
    expect(r.proposal).toMatchObject({ minutes: 10, laps: 11 })
  })

  it("has gridmom check the championship with the proposed count, not the current one", async () => {
    // A race with neither laps nor minutes is something gridmom reports; once
    // the count is set it has nothing to say about the length.
    const profile = await profileWith({ raceMinutes: 20 })
    expect(check(champ({}), profile).findings.map((f) => f.code)).toContain(
      "format.race-length-missing",
    )
    const r = await lapsForRound(practice, champ({}), CHAMP, 1, profile)
    expect(r.gridmom?.findings.map((f) => f.code)).not.toContain("format.race-length-missing")
  })

  it("works from a timed round's own minutes without the league's", async () => {
    const r = await lapsForRound(practice, champ({ Time: 20 }), CHAMP, 1, await profileWith())
    expect(r.proposal).toMatchObject({ minutes: 20, laps: 22 })
  })

  it("refuses a round in laps without any race length to work from", async () => {
    await expect(
      lapsForRound(practice, champ({ Laps: 13 }), CHAMP, 1, await profileWith()),
    ).rejects.toThrow(/lapCount.raceMinutes/)
  })

  it("refuses a round with no track rather than call its week empty", async () => {
    const c = champ({ Laps: 13 })
    const [only] = c.Events ?? []
    c.Events = [{ ...only, RaceSetup: { ...only?.RaceSetup, Track: "" } }]
    await expect(
      lapsForRound(practice, c, CHAMP, 1, await profileWith({ raceMinutes: 20 })),
    ).rejects.toThrow(/no track/)
  })

  it("leaves out what the league suppresses", async () => {
    const profile = await profileWith({ raceMinutes: 20 })
    const codes = async (suppress: string[]) =>
      (
        await lapsForRound(practice, champ({}), CHAMP, 1, profile, { suppress })
      ).gridmom?.findings.map((f) => f.code)
    expect(await codes([])).toContain("content.pit-count-unknown")
    expect(await codes(["content.pit-count-unknown"])).not.toContain("content.pit-count-unknown")
  })

  it("refuses a round the championship doesn't have", async () => {
    await expect(
      lapsForRound(practice, champ({}), CHAMP, 2, await profileWith({ raceMinutes: 20 })),
    ).rejects.toThrow(/no round 2; it has 1/)
  })
})
