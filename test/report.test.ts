import { describe, expect, it } from "vitest"

import { check } from "../src/gridmom/index.js"
import { Severity } from "../src/gridmom/finding.js"
import { formatDiscord, formatText, summaryLine } from "../src/gridmom/report.js"
import { humanList } from "../src/gridmom/finding.js"
import {
  NOW,
  championship,
  championshipClass,
  driver,
  emptySlots,
  entryList,
  pitTable,
  raceEvent,
  suzukaPits,
  testProfile,
} from "./support/build.js"

const report = (c: Parameters<typeof check>[0], suppress: string[] = []) =>
  check(c, testProfile(), { pits: pitTable([suzukaPits]), now: NOW, suppress })

describe("humanList", () => {
  it("writes lists the way a person says them", () => {
    expect(humanList([3, 16, 27])).toBe("3, 16 and 27")
    expect(humanList([3, 16])).toBe("3 and 16")
    expect(humanList([3])).toBe("3")
    expect(humanList([])).toBe("")
  })
})

describe("gridmom's Discord voice", () => {
  /** The exact scenario the plan uses as the example message (§6). */
  const suzukaMess = () =>
    championship({
      Name: "Suzuka",
      Classes: [championshipClass({ Entrants: entryList(emptySlots(4)) })],
      Events: [
        raceEvent({
          EntryList: entryList([
            { ...driver("a"), PitBox: 3 },
            { ...driver("b"), PitBox: 3 },
            { ...driver("c"), PitBox: 16 },
            { ...driver("d"), PitBox: 16 },
            { ...driver("e"), PitBox: 27 },
            { ...driver("f"), PitBox: 27 },
          ]),
          RaceSetup: {
            Sessions: { Practice: { Time: 60 }, Qualifying: { Time: 20 }, Race: { Time: 0, Laps: 0 } },
          },
        }),
      ],
    })

  it("names the thing and where it is, with no severity jargon", () => {
    const out = formatDiscord(report(suzukaMess()))
    expect(out).toMatch(/^\*\*gridmom:\*\* /)
    expect(out).toContain("duplicate pit boxes at 3, 16 and 27")
    expect(out).toContain("Nobody set the race length")
    expect(out).not.toMatch(/\bERROR\b|\bWARN\b|\bINFO\b|severity/i)
  })

  it("joins two findings as one person talking", () => {
    const out = formatDiscord({
      findings: [
        { code: "a", severity: Severity.ERROR, message: "Suzuka has duplicate pit boxes at 3, 16 and 27." },
        { code: "b", severity: Severity.ERROR, message: "Nobody set the lap count." },
      ],
      counts: { ERROR: 2, WARN: 0, INFO: 0 },
      ok: false,
    })
    expect(out).toBe(
      "**gridmom:** Suzuka has duplicate pit boxes at 3, 16 and 27. Also Nobody set the lap count.",
    )
  })

  it("hides INFO by default so the nightly report stays readable", () => {
    const out = formatDiscord({
      findings: [{ code: "x", severity: Severity.INFO, message: "Something differs from the baseline." }],
      counts: { ERROR: 0, WARN: 0, INFO: 1 },
      ok: true,
    })
    expect(out).toContain("looks fine to me")
  })

  it("says so plainly when there's nothing to report", () => {
    expect(formatDiscord({ findings: [], counts: { ERROR: 0, WARN: 0, INFO: 0 }, ok: true })).toContain(
      "looks fine to me",
    )
  })
})

describe("text report", () => {
  it("says so plainly when a championship is clean", () => {
    const out = formatText(report(championship()))
    expect(out).toContain("gridmom — Test Championship")
    expect(out).toContain("Nothing to report")
  })

  it("tags each finding and summarises at the end", () => {
    const out = formatText(
      report(
        championship({
          Events: [
            raceEvent({
              RaceSetup: { Sessions: { Practice: { Time: 60 }, Qualifying: { Time: 20 }, Race: {} } },
            }),
          ],
        }),
      ),
    )
    expect(out).toContain("ERROR")
    expect(out).toContain("Nobody set the race length")
    expect(out).toMatch(/\d+ (error|errors), \d+ (warning|warnings), \d+ (note|notes)\./)
  })

  it("refuses to bless a championship with errors", () => {
    const r = report(
      championship({
        Events: [
          raceEvent({
            RaceSetup: { Sessions: { Practice: { Time: 60 }, Qualifying: { Time: 20 }, Race: {} } },
          }),
        ],
      }),
    )
    expect(r.ok).toBe(false)
    expect(summaryLine(r)).toContain("Fix the errors before pushing")
  })
})

describe("suppression", () => {
  it("hides an exact code", () => {
    const c = championship({
      Events: [
        raceEvent({
          RaceSetup: { Sessions: { Practice: { Time: 60 }, Qualifying: { Time: 20 }, Race: {} } },
        }),
      ],
    })
    expect(report(c).findings.map((f) => f.code)).toContain("format.race-length-missing")
    expect(report(c, ["format.race-length-missing"]).findings.map((f) => f.code)).not.toContain(
      "format.race-length-missing",
    )
  })

  it("hides a whole namespace by prefix", () => {
    const c = championship({
      Events: [
        raceEvent({
          RaceSetup: { Sessions: { Practice: { Time: 60 }, Qualifying: { Time: 20 }, Race: {} } },
        }),
      ],
    })
    expect(report(c, ["format"]).findings.every((f) => !f.code.startsWith("format."))).toBe(true)
  })
})

describe("robustness", () => {
  it("survives an empty object without throwing", () => {
    const r = check({}, testProfile(), { now: NOW })
    expect(r.findings.map((f) => f.code)).toContain("champ.no-events")
    expect(r.findings.some((f) => f.code === "internal.check-failed")).toBe(false)
  })

  it("survives junk in place of the structures it expects", () => {
    const junk = {
      ID: "x",
      Classes: null,
      Events: [{ RaceSetup: null, EntryList: "nope" }],
      SignUpForm: { Responses: "nope" },
    } as unknown as Parameters<typeof check>[0]
    const r = check(junk, testProfile(), { now: NOW })
    expect(r.findings.some((f) => f.code === "internal.check-failed")).toBe(false)
  })
})
