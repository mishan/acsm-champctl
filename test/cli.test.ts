import { describe, expect, it } from "vitest"

import {
  formatFrom,
  parseArgs as parseFinalizeArgs,
  renderPlan,
  UsageError as FinalizeUsageError,
} from "../src/cli/finalize.js"
import {
  parseArgs as parseMonthArgs,
  renderResult,
  UsageError as MonthUsageError,
} from "../src/cli/month.js"
import type { RaceFormat } from "../src/finalize/format.js"
import type { FinalizePlan } from "../src/finalize/plan.js"
import type { EmitResult } from "../src/emit/month.js"

const current: RaceFormat = {
  length: { kind: "minutes", minutes: 40 },
  reversedGridPositions: 5,
  mandatoryPit: true,
  extraLap: true,
}

describe("champctl-finalize arguments", () => {
  it("takes a championship id and a 1-based round", () => {
    const args = parseFinalizeArgs(["abc-123", "2", "--laps", "18"])
    expect(args).toMatchObject({ championshipId: "abc-123", round: 2, laps: 18 })
  })

  it("previews by default; writing takes an explicit flag", () => {
    // The destructive option should be the one you type, not the one you
    // forget to turn off.
    expect(parseFinalizeArgs(["abc", "1"]).push).toBe(false)
    expect(parseFinalizeArgs(["abc", "1", "--push"]).push).toBe(true)
  })

  it("refuses --laps and --minutes together", () => {
    // Two ways to say the same thing; setting both leaves the export
    // ambiguous about which applies.
    expect(() => parseFinalizeArgs(["abc", "1", "--laps", "18", "--minutes", "40"])).toThrow(
      FinalizeUsageError,
    )
  })

  it("refuses a round that isn't a whole number from 1", () => {
    for (const bad of ["0", "-1", "1.5", "two"]) {
      expect(() => parseFinalizeArgs(["abc", bad]), bad).toThrow(/Round must be/)
    }
  })

  it("rejects extra positionals and unknown options", () => {
    expect(() => parseFinalizeArgs(["abc", "1", "extra"])).toThrow(FinalizeUsageError)
    expect(() => parseFinalizeArgs(["abc", "1", "--dry"])).toThrow(/Unknown option/)
    expect(() => parseFinalizeArgs(["abc", "1", "--laps"])).toThrow(/needs a value/)
  })

  it("reads --quali as a date and a time", () => {
    expect(parseFinalizeArgs(["a", "1", "--quali", "2026-09-09", "20:00"]).quali).toEqual({
      date: "2026-09-09",
      time: "20:00",
    })
  })

  it("has separate flags for setting and clearing a boolean", () => {
    // --no-pit has to mean "off", not "unspecified", or there's no way to
    // clear a mandatory stop from the command line.
    expect(parseFinalizeArgs(["a", "1", "--pit"]).pit).toBe(true)
    expect(parseFinalizeArgs(["a", "1", "--no-pit"]).pit).toBe(false)
    expect(parseFinalizeArgs(["a", "1"]).pit).toBeUndefined()
  })
})

describe("building the desired format", () => {
  it("changes only what was asked for", () => {
    // --laps 18 means "make it 18 laps", not "and reset everything I didn't
    // mention".
    expect(formatFrom(current, { laps: 18 })).toEqual({
      length: { kind: "laps", laps: 18 },
      reversedGridPositions: 5,
      mandatoryPit: true,
      extraLap: true,
    })
  })

  it("switches a timed race to laps and back", () => {
    expect(formatFrom(current, { laps: 18 }).length).toEqual({ kind: "laps", laps: 18 })
    expect(formatFrom(current, { minutes: 20 }).length).toEqual({ kind: "minutes", minutes: 20 })
  })

  it("keeps the current length when neither was given", () => {
    expect(formatFrom(current, { reversed: 0 }).length).toEqual(current.length)
  })

  it("can clear a boolean, not just set it", () => {
    expect(formatFrom(current, { pit: false }).mandatoryPit).toBe(false)
    expect(formatFrom(current, { extraLap: false }).extraLap).toBe(false)
  })

  it("treats zero as a value rather than as absent", () => {
    // `?? current` would be right here but `|| current` would not: 0 reversed
    // positions means a single race, and is the most common setting there is.
    expect(formatFrom(current, { reversed: 0 }).reversedGridPositions).toBe(0)
    expect(formatFrom(current, { laps: 0 }).length).toEqual({ kind: "laps", laps: 0 })
  })
})

describe("rendering a plan", () => {
  const plan = (over: Partial<FinalizePlan> = {}): FinalizePlan =>
    ({
      championshipId: "abc-123",
      eventId: "ev-1",
      round: 2,
      current,
      desired: current,
      changes: [{ label: "Race length", before: "40 minutes", after: "18 laps" }],
      formChanges: [{ name: "Race.Laps", before: "0", after: "18" }],
      gridmom: { findings: [], counts: { ERROR: 0, WARN: 0, INFO: 0 }, ok: true },
      blocked: false,
      noop: false,
      entryListFingerprint: "x",
      form: { action: "", method: "POST", enctype: "", fields: [], fileFields: [], textAreaFields: [] },
      ...over,
    }) as FinalizePlan

  it("shows the human diff and the fields that will be posted", () => {
    const out = renderPlan(plan())
    expect(out).toContain("Race length: 40 minutes → 18 laps")
    expect(out).toContain("Race.Laps: 0 → 18")
  })

  it("says plainly when there is nothing to do", () => {
    expect(renderPlan(plan({ changes: [], formChanges: [], noop: true }))).toContain(
      "already matches",
    )
  })

  it("mentions the second request when the schedule moves", () => {
    const out = renderPlan(
      plan({
        schedule: {
          from: "2026-09-02 20:00 PDT",
          to: "2026-09-09 20:00 PDT",
          values: {
            "event-schedule-date": "2026-09-09",
            "event-schedule-time": "19:00",
            "event-schedule-timezone": "America/Los_Angeles",
            "event-schedule-recurrence": "",
          },
        },
      }),
    )
    expect(out).toContain("Quali:")
    expect(out).toContain("separate POST to the schedule endpoint")
  })

  it("prints gridmom findings with their severity", () => {
    const out = renderPlan(
      plan({
        gridmom: {
          findings: [
            { code: "entry.duplicate-pit-box", severity: "ERROR", message: "Duplicates at 3." },
          ],
          counts: { ERROR: 1, WARN: 0, INFO: 0 },
          ok: false,
        },
      } as Partial<FinalizePlan>),
    )
    expect(out).toContain("[ERROR] Duplicates at 3.")
  })
})

describe("champctl-month arguments", () => {
  it("needs a command", () => {
    expect(parseMonthArgs([]).command).toBe("")
    expect(parseMonthArgs(["build"]).command).toBe("build")
    expect(parseMonthArgs(["clone", "abc-123"]).source).toBe("abc-123")
  })

  it("writes nothing without --out or --import", () => {
    // This command creates championships, so the default has to be inert.
    const args = parseMonthArgs(["build", "--spec", "s.json", "--template", "t.json"])
    expect(args.doImport).toBe(false)
    expect(args.out).toBeUndefined()
  })

  it("takes --import explicitly", () => {
    expect(parseMonthArgs(["build", "--import"]).doImport).toBe(true)
  })

  it("splits a track list", () => {
    expect(parseMonthArgs(["build", "--tracks", "spa, suzuka ,monza"]).tracks).toEqual([
      "spa",
      "suzuka",
      "monza",
    ])
  })

  it("rejects extra positionals and unknown options", () => {
    expect(() => parseMonthArgs(["clone", "a", "b"])).toThrow(MonthUsageError)
    expect(() => parseMonthArgs(["build", "--nope"])).toThrow(/Unknown option/)
    expect(() => parseMonthArgs(["build", "--spec"])).toThrow(/needs a value/)
  })
})

describe("rendering a month", () => {
  const result: EmitResult = {
    championship: {
      Name: "September 2026",
      Events: [
        { RaceSetup: { Track: "spa" } },
        { RaceSetup: { Track: "suzuka" } },
      ],
    },
    grid: {
      maxClients: 24,
      bindingTrack: "suzuka",
      unknownTracks: [],
      summary: "Capped at 24 by suzuka.",
    },
    schedule: [
      { round: 1, qualiStart: "2026-09-02T20:00:00-07:00", scheduled: "", overridden: false },
      {
        round: 2,
        qualiStart: "2026-09-16T20:00:00-07:00",
        scheduled: "",
        overridden: true,
        note: "clashes with the 24h",
      },
    ],
    derived: ["Created and Updated stamped from now, not inherited"],
  } as EmitResult

  it("lists the rounds with their tracks and quali times", () => {
    const out = renderResult(result)
    expect(out).toContain("1. spa")
    expect(out).toContain("2026-09-02 20:00")
  })

  it("marks a moved round and says why", () => {
    expect(renderResult(result)).toContain("(moved: clashes with the 24h)")
  })

  it("names the track that binds the grid cap", () => {
    expect(renderResult(result)).toContain("Capped at 24 by suzuka.")
  })

  it("says what was derived rather than inherited", () => {
    expect(renderResult(result)).toContain("Created and Updated stamped")
  })
})
