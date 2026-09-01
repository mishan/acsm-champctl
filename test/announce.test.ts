/**
 * The week's announcement.
 *
 * The load-bearing assertion in here is the quali time. `Scheduled` is
 * *practice* start, so an announcement that repeats it tells the league to turn
 * up an hour early — confidently, in public, once a week.
 */

import { DateTime } from "luxon"
import { describe, expect, it } from "vitest"

import type { Championship } from "../src/acsm/types.js"
import {
  announce,
  describeFormat,
  nextRound,
  NothingToAnnounce,
  partsFor,
  withZoneNote,
} from "../src/bot/announce.js"
import { championship, raceEvent, testProfile } from "./support/build.js"

/** BATL's own presets, so the format naming has something to match against. */
const leagueProfile = () =>
  testProfile({
    formats: [
      {
        name: "1x40",
        length: { kind: "minutes", minutes: 40 },
        reversedGridPositions: 0,
        mandatoryPit: true,
        extraLap: false,
      },
      {
        name: "2x20",
        length: { kind: "minutes", minutes: 20 },
        reversedGridPositions: 5,
        mandatoryPit: false,
        extraLap: false,
      },
    ],
  })

const raced = (over = {}) => raceEvent({ StartedTime: "2026-08-05T19:00:00-07:00", ...over })

describe("which round gets announced", () => {
  it("picks the next one nobody has raced", () => {
    const c = championship({ Events: [raced(), raced(), raceEvent()] })
    expect(nextRound(c)).toBe(3)
  })

  it("counts rounds by running order, not by date", () => {
    // The array is the running order, and a reorder moves what a round *is*
    // between slots while the dates stay put, so champctl must not re-sort.
    //
    // Round 1 has been raced and carries the *later* date. Sorting by date puts
    // the unraced round first and calls it round 1 — announcing a round number
    // that has already happened. The two orders have to disagree here or this
    // asserts nothing: an earlier version of this test compared round numbers
    // on two unraced events, where both readings answer 1.
    const c = championship({
      Events: [
        raced({ Scheduled: "2026-09-30T19:00:00-07:00" }),
        raceEvent({ Scheduled: "2026-09-02T19:00:00-07:00" }),
      ],
    })
    expect(nextRound(c)).toBe(2)
    expect(announce(c, { profile: leagueProfile() }).round).toBe(2)
  })

  it("says the season is over rather than throwing something scary", () => {
    const c = championship({ Events: [raced()] })
    expect(() => announce(c, { profile: leagueProfile() })).toThrow(NothingToAnnounce)
    expect(() => announce(c, { profile: leagueProfile() })).toThrow(/Every round has been raced/)
  })

  it("refuses an explicit round that has already been raced", () => {
    // An explicit --round is usually a typo for the one beside it, and "this
    // week at Suzuka" about a race that happened is worse than an error.
    const c = championship({ Events: [raced(), raceEvent()] })
    expect(() => announce(c, { profile: leagueProfile(), round: 1 })).toThrow(/already been raced/)
  })

  it("refuses a round that does not exist", () => {
    const c = championship({ Events: [raceEvent()] })
    expect(() => announce(c, { profile: leagueProfile(), round: 4 })).toThrow(/no round 4/)
  })
})

describe("what the announcement says", () => {
  it("announces quali start, not the Scheduled field", () => {
    // Scheduled is 19:00 with a 60 minute practice, so quali is 20:00. Reading
    // Scheduled straight out would tell everyone to turn up an hour early.
    const c = championship({ Events: [raceEvent()] })
    const out = announce(c, { profile: leagueProfile() }).content

    expect(out).toContain("Quali 20:00")
    expect(out).not.toContain("19:00")
  })

  it("names the track and the round", () => {
    const out = announce(championship({ Events: [raceEvent()] }), {
      profile: leagueProfile(),
    }).content
    expect(out).toContain("round 1: suzuka")
  })

  it("uses the league's own name for a format it recognises", () => {
    const c = championship({
      Events: [
        raceEvent({
          RaceSetup: {
            RacePitWindowStart: 1,
            Sessions: {
              PRACTICE: { Time: 60 },
              QUALIFY: { Time: 20 },
              RACE: { Time: 40, Laps: 0 },
            },
          },
        }),
      ],
    })
    // "40 minutes with a mandatory stop" describes what the racers voted on in
    // words they did not use.
    expect(announce(c, { profile: leagueProfile() }).content).toContain("Format: 1x40")
  })

  it("describes a format no preset matches, rather than inventing a name", () => {
    const format = {
      length: { kind: "laps", laps: 18 } as const,
      reversedGridPositions: 5,
      mandatoryPit: true,
      extraLap: false,
    }
    expect(describeFormat(format, leagueProfile())).toBe(
      "18 laps, reversed grid top 5, mandatory pit stop",
    )
  })

  it("links to the championship page, which is where sign-ups are", () => {
    const c = championship({ Events: [raceEvent()] })
    const out = announce(c, { profile: leagueProfile(), baseUrl: "https://acsm.example/" }).content
    expect(out).toContain(`https://acsm.example/championship/${c.ID}`)
  })

  it("says the quali time isn't set rather than printing an invalid date", () => {
    const c = championship({ Events: [raceEvent({ Scheduled: "" })] })
    const out = announce(c, { profile: leagueProfile() }).content

    expect(out).toContain("Quali time not set yet")
    expect(out).not.toContain("Invalid")
  })

  it("names the timezone once, at the end", () => {
    const out = announce(championship({ Events: [raceEvent()] }), { profile: leagueProfile() })
    expect(out.content.split("\n").at(-1)).toMatch(/^-# All times /)
    expect(out.content.match(/All times/g)).toHaveLength(1)
  })

  it("names the zone the *race* is in, not the one the job runs in", () => {
    // This read `DateTime.now()`, which is right for about fifty weeks a year
    // and wrong across a clock change: a cron run in October announcing a race
    // on 4 November said "All times PDT" about a race that runs in PST — an
    // hour out, stated confidently, to the whole league.
    //
    // Two rounds either side of the US transition, asserted together. Whatever
    // the real date is when this suite runs, the old version gives both the
    // same abbreviation, so one of the two has to fail.
    const noteFor = (scheduled: string) =>
      announce(championship({ Events: [raceEvent({ Scheduled: scheduled })] }), {
        profile: leagueProfile(),
      }).content

    expect(noteFor("2026-07-01T19:00:00-07:00")).toContain("All times PDT")
    expect(noteFor("2026-11-04T19:00:00-08:00")).toContain("All times PST")
  })

  it("says nothing about a timezone when it stated no time", () => {
    // A message with no clock in it has no zone to qualify.
    const noTime = announce(championship({ Events: [raceEvent({ Scheduled: "" })] }), {
      profile: leagueProfile(),
    }).content
    expect(noTime).not.toContain("All times")

    const noQuali = announce(championship({ Events: [raceEvent()] }), {
      profile: testProfile({ discord: { announce: { quali: false } } }),
    }).content
    expect(noQuali).not.toContain("All times")
  })

  it("puts the abbreviation on the instant it was handed", () => {
    const at = DateTime.fromISO("2026-11-04T20:00:00", { zone: "America/Los_Angeles" })
    expect(withZoneNote("Quali 20:00.", at)).toBe("Quali 20:00.\n-# All times PST.")
  })
})

describe("what a league chooses to say", () => {
  it("says everything by default", () => {
    expect(partsFor(testProfile())).toEqual({
      track: true,
      quali: true,
      format: true,
      signUp: true,
    })
  })

  it("drops the parts ACSM's own integration already posts", () => {
    const profile = testProfile({
      discord: { announce: { format: false, signUp: false } },
    })
    const c = championship({ Events: [raceEvent()] })
    const out = announce(c, { profile, baseUrl: "https://acsm.example" }).content

    expect(out).toContain("Quali 20:00")
    expect(out).not.toContain("Format:")
    expect(out).not.toContain("Sign up:")
  })

  it("still says which round it is when the track is turned off", () => {
    const profile = testProfile({ discord: { announce: { track: false } } })
    const out = announce(championship({ Events: [raceEvent()] }), { profile }).content

    expect(out).toContain("round 1")
    expect(out).not.toContain("suzuka")
  })
})

describe("robustness", () => {
  it("refuses a championship with no rounds instead of throwing a TypeError", () => {
    expect(() => announce(championship({ Events: [] }), { profile: leagueProfile() })).toThrow(
      /no rounds/,
    )
  })

  it("survives junk where the structures should be", () => {
    const junk = { ID: "x", Name: "J", Events: [{ RaceSetup: null }] } as unknown as Championship
    expect(() => announce(junk, { profile: leagueProfile() })).not.toThrow()
  })
})
