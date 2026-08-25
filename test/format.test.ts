import { describe, expect, it } from "vitest"

import { check } from "../src/gridmom/index.js"
import { formatChecks } from "../src/gridmom/checks/format.js"
import {
  NOW,
  championship,
  championshipClass,
  pitTable,
  raceEvent,
  suzukaPits,
  testProfile,
} from "./support/build.js"

const run = (c: Parameters<typeof check>[0]) =>
  check(c, testProfile(), { pits: pitTable([suzukaPits]), now: NOW, checks: formatChecks })

const codes = (c: Parameters<typeof check>[0]) => run(c).findings.map((f) => f.code)

const withRace = (race: Record<string, number>, rest: Record<string, unknown> = {}) =>
  championship({
    Events: [
      raceEvent({
        RaceSetup: {
          ...rest,
          Sessions: {
            Practice: { Time: 60 },
            Qualifying: { Time: 20 },
            Race: race,
          },
        },
      }),
    ],
  })

describe("race length", () => {
  it("errors when nobody set it — the line from the plan", () => {
    const f = run(withRace({ Time: 0, Laps: 0 })).findings.find(
      (x) => x.code === "format.race-length-missing",
    )
    expect(f?.severity).toBe("ERROR")
    expect(f?.message).toContain("Nobody set the race length")
  })

  it("errors when both laps and minutes are set", () => {
    const f = run(withRace({ Time: 40, Laps: 20 })).findings.find(
      (x) => x.code === "format.race-length-both",
    )
    expect(f?.severity).toBe("ERROR")
  })

  it("accepts laps alone", () => {
    expect(codes(withRace({ Time: 0, Laps: 20 }))).not.toContain("format.race-length-missing")
  })

  it("accepts minutes alone", () => {
    expect(codes(withRace({ Time: 40, Laps: 0 }))).not.toContain("format.race-length-both")
  })
})

describe("mandatory pit window", () => {
  it("warns when a 1x40 has no pit window", () => {
    // Imola: 1x40 with a mandatory stop wants RacePitWindowStart = 1.
    const c = withRace(
      { Time: 0, Laps: 40 },
      { RacePitWindowStart: 0, ReversedGridRacePositions: 0 },
    )
    const f = run(c).findings.find((x) => x.code === "format.pit-window-missing")
    expect(f?.severity).toBe("WARN")
    expect(f?.message).toContain("no mandatory stop")
    // Hyphenated: it's an adjective before "single race".
    expect(f?.message).toContain("a 40-lap single race")
  })

  it("hyphenates a minutes-based length too", () => {
    const c = withRace(
      { Time: 45, Laps: 0 },
      { RacePitWindowStart: 0, ReversedGridRacePositions: 0 },
    )
    const f = run(c).findings.find((x) => x.code === "format.pit-window-missing")
    expect(f?.message).toContain("a 45-minute single race")
  })

  it("accepts a 1x40 with the window opening at lap 1", () => {
    const c = withRace(
      { Time: 0, Laps: 40 },
      { RacePitWindowStart: 1, ReversedGridRacePositions: 0 },
    )
    expect(codes(c)).not.toContain("format.pit-window-missing")
  })

  it("accepts a 2x20 with no pit window", () => {
    // Suzuka and all five Legends events: 2x20 with RacePitWindowStart 0.
    const c = withRace(
      { Time: 0, Laps: 20 },
      { RacePitWindowStart: 0, ReversedGridRacePositions: 5 },
    )
    expect(codes(c)).not.toContain("format.pit-window-missing")
    expect(codes(c)).not.toContain("format.pit-window-unexpected")
  })

  it("warns when a 2x20 has a pit window set anyway", () => {
    const c = withRace(
      { Time: 0, Laps: 20 },
      { RacePitWindowStart: 1, ReversedGridRacePositions: 5 },
    )
    const f = run(c).findings.find((x) => x.code === "format.pit-window-unexpected")
    expect(f?.message).toContain("reversed grid")
  })
})

describe("reversed grid", () => {
  it("warns when the second race scores nothing", () => {
    const c = championship({
      Classes: [
        championshipClass({
          Points: { Places: [25, 18, 15], SecondRaceMultiplier: 0 },
        }),
      ],
      Events: [raceEvent({ RaceSetup: { ReversedGridRacePositions: 5, SecondRaceMultiplier: 0 } })],
    })
    const f = run(c).findings.find((x) => x.code === "format.reversed-grid-multiplier")
    expect(f?.severity).toBe("WARN")
  })

  it("is quiet for a single race", () => {
    const c = championship({
      Events: [raceEvent({ RaceSetup: { ReversedGridRacePositions: 0, SecondRaceMultiplier: 0 } })],
    })
    expect(codes(c)).not.toContain("format.reversed-grid-multiplier")
  })

  it("stays quiet when any class scores the second race", () => {
    // Falling back to Classes[0] alone would warn here, even though the GT4
    // field scores normally.
    const c = championship({
      Classes: [
        championshipClass({ Name: "GT3", Points: { Places: [25], SecondRaceMultiplier: 0 } }),
        championshipClass({ Name: "GT4", Points: { Places: [25], SecondRaceMultiplier: 1 } }),
      ],
      Events: [raceEvent({ RaceSetup: { ReversedGridRacePositions: 5 } })],
    })
    delete c.Events![0]!.RaceSetup!.SecondRaceMultiplier
    expect(codes(c)).not.toContain("format.reversed-grid-multiplier")
  })

  it("warns when no class scores the second race, and says so", () => {
    const c = championship({
      Classes: [
        championshipClass({ Name: "GT3", Points: { Places: [25], SecondRaceMultiplier: 0 } }),
        championshipClass({ Name: "GT4", Points: { Places: [25], SecondRaceMultiplier: 0 } }),
      ],
      Events: [raceEvent({ RaceSetup: { ReversedGridRacePositions: 5 } })],
    })
    delete c.Events![0]!.RaceSetup!.SecondRaceMultiplier
    const f = run(c).findings.find((x) => x.code === "format.reversed-grid-multiplier")
    expect(f?.severity).toBe("WARN")
    expect(f?.message).toContain("any of the 2 classes")
    expect(f?.data).toMatchObject({ classMultipliers: [0, 0] })
  })

  it("lets the event-level value override the classes", () => {
    const c = championship({
      Classes: [championshipClass({ Points: { Places: [25], SecondRaceMultiplier: 1 } })],
      Events: [raceEvent({ RaceSetup: { ReversedGridRacePositions: 5, SecondRaceMultiplier: 0 } })],
    })
    expect(codes(c)).toContain("format.reversed-grid-multiplier")
  })
})

describe("baseline drift", () => {
  it("notes a differing entry list type without blocking", () => {
    const c = championship({ Events: [raceEvent({ RaceSetup: { EntryListType: 0 } })] })
    const report = run(c)
    const f = report.findings.find((x) => x.code === "format.baseline")
    expect(f?.severity).toBe("INFO")
    expect(report.ok).toBe(true)
  })

  it("notes a non-standard quali length", () => {
    const c = withRace({ Laps: 20 })
    c.Events![0]!.RaceSetup!.Sessions!.Qualifying = { Time: 35 }
    const f = run(c).findings.find((x) => x.code === "format.quali-length")
    expect(f?.severity).toBe("INFO")
    expect(f?.message).toContain("35 minute quali")
  })
})
