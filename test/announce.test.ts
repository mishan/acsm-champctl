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
  RoundRefused,
  withZoneNote,
} from "../src/bot/announce.js"
import { championship, NOW, raceEvent, testProfile } from "./support/build.js"

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

/** A round that genuinely happened: it started *and* it finished. */
const raced = (over = {}) =>
  raceEvent({
    StartedTime: "2026-08-05T19:00:00-07:00",
    CompletedTime: "2026-08-05T20:30:00-07:00",
    ...over,
  })

/**
 * A round nobody has raced, with a practice server open on it.
 *
 * ACSM stamps `StartedTime` from the UDP new-session callback and a looping
 * practice writes its own `CompletedTime` each loop, so both marks are on an
 * untouched round. This is BATL's normal state for the round coming up.
 */
const practiceOpen = (over = {}) =>
  raceEvent({
    StartedTime: "2026-08-30T18:00:00-07:00",
    Sessions: {
      PRACTICE: {
        StartedTime: "2026-08-30T18:00:00-07:00",
        CompletedTime: "2026-08-30T19:00:00-07:00",
      },
    },
    ...over,
  })

/**
 * A round that was never raced and whose date has gone by — a server that
 * crashed, a round rained off. Practice 19:00 on 19 August, five days before
 * `NOW`; no results ever landed.
 */
const lapsed = (over = {}) => raceEvent({ Scheduled: "2026-08-19T19:00:00-07:00", ...over })

describe("which round gets announced", () => {
  it("picks the next one nobody has raced", () => {
    const c = championship({ Events: [raced(), raced(), raceEvent()] })
    expect(nextRound(c, leagueProfile(), NOW)).toBe(3)
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
    expect(nextRound(c, leagueProfile(), NOW)).toBe(2)
    expect(announce(c, { profile: leagueProfile(), now: NOW }).round).toBe(2)
  })

  it("does not count a round as raced because its practice server is open", () => {
    // The bug this exists for: on `eventHasStarted` a looping practice server
    // made round 2 look raced, so the bot announced round 3 — wrong track and
    // wrong date, to the channel drivers set an alarm by.
    const c = championship({ Events: [raced(), practiceOpen(), raceEvent()] })
    expect(nextRound(c, leagueProfile(), NOW)).toBe(2)
  })

  it("still counts a round raced off qualifying results alone", () => {
    // Qualifying with results is a session somebody may go back to the replay
    // of, so it counts. Practice, which loops, does not.
    const c = championship({
      Events: [raceEvent({ Sessions: { QUALIFY: { Results: { Result: [] } } } }), raceEvent()],
    })
    expect(nextRound(c, leagueProfile(), NOW)).toBe(2)
  })

  it("passes over a round that was never raced once its date has gone by", () => {
    // On results alone a round with none stayed "next" for the rest of the
    // season, so every weekly run announced it again — with a date in the past.
    const c = championship({ Events: [raced(), lapsed(), raceEvent()] })
    expect(nextRound(c, leagueProfile(), NOW)).toBe(3)
    expect(announce(c, { profile: leagueProfile(), now: NOW }).content).toContain("2 September")
  })

  it("still announces tonight's round between practice and quali", () => {
    // Gone by means quali has started, not practice. Practice start is what
    // `Scheduled` holds, and going by that would drop tonight's round from a
    // run at 19:30 with quali still half an hour away.
    const at = new Date("2026-09-02T19:30:00-07:00")
    const c = championship({
      Events: [raceEvent(), raceEvent({ Scheduled: "2026-09-09T19:00:00-07:00" })],
    })
    expect(nextRound(c, leagueProfile(), at)).toBe(1)
    expect(nextRound(c, leagueProfile(), new Date("2026-09-02T20:00:00-07:00"))).toBe(2)
  })

  it("keeps a round with no date as a candidate, since it has nothing to go by", () => {
    const c = championship({ Events: [raceEvent({ Scheduled: "" }), raceEvent()] })
    expect(nextRound(c, leagueProfile(), NOW)).toBe(1)
  })

  it("announces the round a practice server is open on, not the one after", () => {
    const c = championship({
      Events: [
        practiceOpen({ RaceSetup: { Track: "suzuka" } }),
        raceEvent({ RaceSetup: { Track: "spa" } }),
      ],
    })
    const out = announce(c, { profile: testProfile(), now: NOW })
    expect(out.round).toBe(1)
    expect(out.content).toContain("suzuka")
    expect(out.content).not.toContain("spa")
  })

  it("does not refuse an explicit round whose practice server is merely open", () => {
    const c = championship({ Events: [practiceOpen(), raceEvent()] })
    expect(announce(c, { profile: testProfile(), round: 1, now: NOW }).round).toBe(1)
  })

  it("says the season is over rather than throwing something scary", () => {
    const c = championship({ Events: [raced()] })
    const run = () => announce(c, { profile: leagueProfile(), now: NOW })
    expect(run).toThrow(NothingToAnnounce)
    expect(run).toThrow(/Every round has been raced/)
  })

  it("counts a season whose last round lapsed as over, not as a mistake", () => {
    const c = championship({ Events: [raced(), lapsed()] })
    expect(() => announce(c, { profile: leagueProfile(), now: NOW })).toThrow(NothingToAnnounce)
  })
})

describe("an explicit round", () => {
  // Refused as `RoundRefused`, which the CLI exits 2 on. These used to throw
  // `NothingToAnnounce` and exit 0, so a typo'd round read to cron as a post.

  it("is refused when it has already been raced", () => {
    // Usually a typo for the one beside it, and "this week at Suzuka" about a
    // race that happened is worse than an error.
    const c = championship({ Events: [raced(), raceEvent()] })
    const run = () => announce(c, { profile: leagueProfile(), round: 1, now: NOW })
    expect(run).toThrow(RoundRefused)
    expect(run).toThrow(/already been raced/)
  })

  it("is refused when its quali has gone by, even with no results", () => {
    const c = championship({ Events: [lapsed(), raceEvent()] })
    const run = () => announce(c, { profile: leagueProfile(), round: 1, now: NOW })
    expect(run).toThrow(RoundRefused)
    expect(run).toThrow(/20:00 on Wednesday 19 August, which has gone by/)
  })

  it("is refused when it does not exist, starting one past the last", () => {
    const c = championship({ Events: [raceEvent()] })
    const run = (round: number) => () => announce(c, { profile: leagueProfile(), round, now: NOW })
    expect(run(2)).toThrow(RoundRefused)
    expect(run(2)).toThrow(/no round 2 — this championship has 1/)
    expect(run(1)).not.toThrow()
  })
})

describe("what the announcement says", () => {
  it("announces quali start, not the Scheduled field", () => {
    // Scheduled is 19:00 with a 60 minute practice, so quali is 20:00. Reading
    // Scheduled straight out would tell everyone to turn up an hour early.
    const c = championship({ Events: [raceEvent()] })
    const out = announce(c, { profile: leagueProfile(), now: NOW }).content

    expect(out).toContain("Quali 20:00")
    expect(out).not.toContain("19:00")
  })

  it("names the track and the round", () => {
    const out = announce(championship({ Events: [raceEvent()] }), {
      profile: leagueProfile(),
      now: NOW,
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
    expect(announce(c, { profile: leagueProfile(), now: NOW }).content).toContain("Format: 1x40")
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

  it("says the format isn't set rather than announcing a race of 0 minutes", () => {
    // A Race session with neither laps nor time reads as zero minutes, and this
    // posted "Format: 0 minutes." to the league about a round nobody had set up.
    const c = championship({
      Events: [
        raceEvent({
          RaceSetup: { Sessions: { PRACTICE: { Time: 60 }, RACE: { Time: 0, Laps: 0 } } },
        }),
      ],
    })
    const out = announce(c, { profile: leagueProfile(), now: NOW }).content
    expect(out).toContain("Format not set yet.")
    expect(out).not.toContain("0 minutes")
  })

  it("links to the championship page, which is where sign-ups are", () => {
    const c = championship({ Events: [raceEvent()] })
    const out = announce(c, {
      profile: leagueProfile(),
      baseUrl: "https://acsm.example/",
      now: NOW,
    }).content
    expect(out).toContain(`https://acsm.example/championship/${c.ID}`)
  })

  it("does not invite sign-ups to a championship that isn't taking them", () => {
    const withForm = (Enabled: boolean) =>
      announce(championship({ Events: [raceEvent()], SignUpForm: { Enabled } }), {
        profile: leagueProfile(),
        baseUrl: "https://acsm.example",
        now: NOW,
      }).content

    expect(withForm(true)).toContain("Sign up: https://acsm.example/championship/")
    expect(withForm(false)).toContain("Details: https://acsm.example/championship/")
    expect(withForm(false)).not.toContain("Sign up")
  })

  it("says the quali time isn't set rather than printing an invalid date", () => {
    const c = championship({ Events: [raceEvent({ Scheduled: "" })] })
    const out = announce(c, { profile: leagueProfile(), now: NOW }).content

    expect(out).toContain("Quali time not set yet")
    expect(out).not.toContain("Invalid")
  })

  it("names the timezone once, at the end", () => {
    const out = announce(championship({ Events: [raceEvent()] }), {
      profile: leagueProfile(),
      now: NOW,
    })
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
    const before = new Date("2026-06-01T12:00:00-07:00")
    const noteFor = (scheduled: string) =>
      announce(championship({ Events: [raceEvent({ Scheduled: scheduled })] }), {
        profile: leagueProfile(),
        now: before,
      }).content

    expect(noteFor("2026-07-01T19:00:00-07:00")).toContain("All times PDT")
    expect(noteFor("2026-11-04T19:00:00-08:00")).toContain("All times PST")
  })

  it("says nothing about a timezone when it stated no time", () => {
    // A message with no clock in it has no zone to qualify.
    const noTime = announce(championship({ Events: [raceEvent({ Scheduled: "" })] }), {
      profile: leagueProfile(),
      now: NOW,
    }).content
    expect(noTime).not.toContain("All times")

    const noQuali = announce(championship({ Events: [raceEvent()] }), {
      profile: testProfile({ discord: { announce: { quali: false } } }),
      now: NOW,
    }).content
    expect(noQuali).not.toContain("All times")
  })

  it("puts the abbreviation on the instant it was handed", () => {
    const at = DateTime.fromISO("2026-11-04T20:00:00", { zone: "America/Los_Angeles" })
    expect(withZoneNote("Quali 20:00.", at)).toBe("Quali 20:00.\n-# All times PST.")
  })

  it("refuses a message Discord would refuse, rather than cutting the name", () => {
    // Everything else is bounded, so this is a championship name, and Discord
    // turns away anything over 2000 characters — the post failed after login.
    const c = championship({ Name: "x".repeat(2100), Events: [raceEvent()] })
    expect(() => announce(c, { profile: leagueProfile(), now: NOW })).toThrow(/over Discord's 2000/)
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
    const out = announce(c, { profile, baseUrl: "https://acsm.example", now: NOW }).content

    expect(out).toContain("Quali 20:00")
    expect(out).not.toContain("Format")
    expect(out).not.toContain("Sign up:")
  })

  it("still says which round it is when the track is turned off", () => {
    const profile = testProfile({ discord: { announce: { track: false } } })
    const out = announce(championship({ Events: [raceEvent()] }), { profile, now: NOW }).content

    expect(out).toContain("round 1")
    expect(out).not.toContain("suzuka")
  })
})

describe("robustness", () => {
  it("says a championship with no rounds has none, rather than that the season is over", () => {
    const run = () => announce(championship({ Events: [] }), { profile: leagueProfile(), now: NOW })
    expect(run).toThrow(NothingToAnnounce)
    expect(run).toThrow(/no rounds/)
  })

  it("says what it doesn't know about a round with no setup at all", () => {
    // Junk where the structures should be: no Scheduled, no RaceSetup. It read
    // that as a 0-minute race; now it says neither time nor format is set.
    const junk = { ID: "x", Name: "J", Events: [{ RaceSetup: null }] } as unknown as Championship
    const out = announce(junk, { profile: leagueProfile(), now: NOW }).content
    expect(out).toContain("Quali time not set yet.")
    expect(out).toContain("Format not set yet.")
  })
})
