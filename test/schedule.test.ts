import { describe, expect, it } from "vitest"

import { check } from "../src/gridmom/index.js"
import { scheduleChecks } from "../src/gridmom/checks/schedule.js"
import { NOW, championship, pitTable, raceEvent, suzukaPits, testProfile } from "./support/build.js"

const run = (c: Parameters<typeof check>[0]) =>
  check(c, testProfile(), { pits: pitTable([suzukaPits]), now: NOW, checks: scheduleChecks })

const codes = (c: Parameters<typeof check>[0]) => run(c).findings.map((f) => f.code)

describe("Scheduled = qualiStart - practice", () => {
  it("accepts 19:00 practice for a 20:00 quali with a 60 minute practice", () => {
    // The real Suzuka shape from the plan (§4.3).
    const c = championship({
      Events: [raceEvent({ Scheduled: "2026-09-02T19:00:00-07:00" })],
    })
    expect(codes(c)).not.toContain("schedule.derived-start")
  })

  it("warns and gives the right time when the anchor drifts", () => {
    const c = championship({
      Events: [raceEvent({ Scheduled: "2026-09-02T19:30:00-07:00" })],
    })
    const f = run(c).findings.find((x) => x.code === "schedule.derived-start")
    expect(f?.severity).toBe("WARN")
    expect(f?.message).toContain("quali at 20:30")
    expect(f?.message).toContain("should be scheduled 19:00")
    expect(f?.data).toMatchObject({ driftMinutes: 30 })
  })

  it("uses the event's own practice length when it differs", () => {
    // 30 minute practice means Scheduled should be 19:30 for a 20:00 quali.
    const c = championship({
      Events: [
        raceEvent({
          Scheduled: "2026-09-02T19:30:00-07:00",
          RaceSetup: {
            Sessions: { Practice: { Time: 30 }, Qualifying: { Time: 20 }, Race: { Laps: 20 } },
          },
        }),
      ],
    })
    expect(codes(c)).not.toContain("schedule.derived-start")
  })

  it("leaves completed events alone", () => {
    const c = championship({
      Events: [
        raceEvent({
          Scheduled: "2026-07-01T18:12:00-07:00",
          StartedTime: "2026-07-01T18:12:00-07:00",
        }),
      ],
    })
    expect(codes(c)).not.toContain("schedule.derived-start")
  })
})

describe("weekday", () => {
  it("warns on a non-Wednesday with no reason given", () => {
    const c = championship({
      Events: [raceEvent({ Scheduled: "2026-09-03T19:00:00-07:00" })], // Thursday
    })
    const f = run(c).findings.find((x) => x.code === "schedule.weekday")
    expect(f?.message).toContain("Thursday")
    expect(f?.message).toContain("Wednesday")
  })

  it("accepts a moved date when the event carries a note", () => {
    const c = championship({
      Events: [
        raceEvent({ Scheduled: "2026-09-03T19:00:00-07:00", ScheduleNote: "Labor Day week" }),
      ],
    })
    expect(codes(c)).not.toContain("schedule.weekday")
  })
})

describe("collisions and gaps", () => {
  it("warns when two events land on the same night", () => {
    const c = championship({
      Events: [
        raceEvent({ Scheduled: "2026-09-02T19:00:00-07:00" }),
        raceEvent({ Scheduled: "2026-09-02T21:00:00-07:00" }),
      ],
    })
    expect(codes(c)).toContain("schedule.collision")
  })

  it("warns about an event that never ran", () => {
    const c = championship({
      Events: [raceEvent({ Scheduled: "2026-08-05T19:00:00-07:00" })],
    })
    const f = run(c).findings.find((x) => x.code === "schedule.past")
    expect(f?.message).toContain("never started")
  })

  it("says nothing about a past event that did run", () => {
    const c = championship({
      Events: [
        raceEvent({
          Scheduled: "2026-08-05T19:00:00-07:00",
          StartedTime: "2026-08-05T19:00:03-07:00",
        }),
      ],
    })
    expect(codes(c)).not.toContain("schedule.past")
  })

  it("warns when one event is missing a server and the rest have one", () => {
    const c = championship({
      Events: [
        raceEvent({ ScheduledServerID: "server-1" }),
        raceEvent({ Scheduled: "2026-09-09T19:00:00-07:00", ScheduledServerID: "" }),
      ],
    })
    expect(codes(c)).toContain("schedule.missing-server")
  })

  it("says nothing when no event has a server yet", () => {
    const c = championship({
      Events: [
        raceEvent({ ScheduledServerID: "" }),
        raceEvent({ Scheduled: "2026-09-09T19:00:00-07:00", ScheduledServerID: "" }),
      ],
    })
    expect(codes(c)).not.toContain("schedule.missing-server")
  })
})

describe("DST", () => {
  it("notes a championship that straddles the clock change", () => {
    // US DST ends 1 November 2026, so October is -07:00 and November -08:00.
    const c = championship({
      Events: [
        raceEvent({ Scheduled: "2026-10-28T19:00:00-07:00" }),
        raceEvent({ Scheduled: "2026-11-04T19:00:00-08:00" }),
      ],
    })
    const f = run(c).findings.find((x) => x.code === "schedule.dst")
    expect(f?.severity).toBe("INFO")
    expect(f?.message).toContain("clocks change")
  })

  it("says nothing within a single offset", () => {
    const c = championship({
      Events: [
        raceEvent({ Scheduled: "2026-09-02T19:00:00-07:00" }),
        raceEvent({ Scheduled: "2026-09-09T19:00:00-07:00" }),
      ],
    })
    expect(codes(c)).not.toContain("schedule.dst")
  })

  it("keeps wall-clock time constant across the boundary", () => {
    // Both are 19:00 local, so neither should trip the derived-start check
    // even though the stored offsets differ.
    const c = championship({
      Events: [
        raceEvent({ Scheduled: "2026-10-28T19:00:00-07:00" }),
        raceEvent({ Scheduled: "2026-11-04T19:00:00-08:00" }),
      ],
    })
    expect(codes(c)).not.toContain("schedule.derived-start")
  })
})
