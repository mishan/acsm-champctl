import { describe, expect, it } from "vitest"

import { type Draft, nightFrom, requestFrom } from "../client/src/draft.js"

const draft = (over: Partial<Draft> = {}): Draft => ({
  track: "suzuka",
  layout: "",
  venueWas: { track: "suzuka", layout: "" },
  lengthKind: "laps",
  laps: "18",
  minutes: "40",
  reversed: "0",
  mandatoryPit: false,
  extraLap: false,
  qualiDate: "",
  qualiTime: "",
  practiceMinutes: "60",
  qualiMinutes: "15",
  lengthsWas: { practice: 60, quali: 15 },
  ...over,
})

describe("turning the finalize form into a request", () => {
  /**
   * A move is sent only when there is one.
   *
   * Not an optimisation. Sending the round's own track on every preview would
   * ask the server to write it every time, and the server refuses a write to a
   * round whose layout is already wrong — so the screen could never show the
   * round it exists to repair.
   */
  it("says nothing about the track when it hasn't moved", () => {
    expect(requestFrom(draft())).not.toHaveProperty("venue")
  })

  it("sends the track and layout once either changes", () => {
    expect(requestFrom(draft({ track: "ks_brands_hatch", layout: "indy" }))).toMatchObject({
      venue: { track: "ks_brands_hatch", layout: "indy" },
    })
    // A layout set on a round that had none is the repair this is here for,
    // and it is a change even though the track has not moved.
    expect(
      requestFrom(
        draft({ track: "suzuka", layout: "west", venueWas: { track: "suzuka", layout: "" } }),
      ),
    ).toMatchObject({ venue: { track: "suzuka", layout: "west" } })
  })

  it("previews nothing while the track is blank", () => {
    expect(requestFrom(draft({ track: "  " }))).toBeNull()
  })

  it("leaves the schedule alone when both quali fields are blank", () => {
    // An unscheduled round starts this way, and "no opinion about the time" is
    // a legitimate thing to preview.
    const body = requestFrom(draft())
    expect(body).not.toBeNull()
    expect(body).not.toHaveProperty("quali")
  })

  it("sends the schedule when both are filled in", () => {
    const body = requestFrom(draft({ qualiDate: "2026-09-02", qualiTime: "20:00" }))
    expect(body).toMatchObject({ quali: { date: "2026-09-02", time: "20:00" } })
  })

  /**
   * The case this exists for. A half-filled wall clock used to drop the quali
   * change and preview the *rest* of the format cleanly, so the screen showed a
   * date the push was never going to apply, next to a button happy to apply it.
   *
   * Returning null puts it on the same footing as a lap count of "abc": no
   * plan, and nothing pushable until the field is finished.
   */
  it.each([
    ["a date with no time", { qualiDate: "2026-09-02", qualiTime: "" }],
    ["a time with no date", { qualiDate: "", qualiTime: "20:00" }],
    ["whitespace standing in for a time", { qualiDate: "2026-09-02", qualiTime: "   " }],
  ])("refuses %s rather than previewing a different change", (_why, over) => {
    expect(requestFrom(draft(over))).toBeNull()
  })

  it("still refuses a draft that isn't a number, as before", () => {
    expect(requestFrom(draft({ laps: "abc" }))).toBeNull()
    expect(requestFrom(draft({ reversed: "-1" }))).toBeNull()
  })
})

describe("session lengths in the request", () => {
  it.each([
    { typed: { practiceMinutes: "45" }, sends: { practiceMinutes: 45 } },
    { typed: { qualiMinutes: "120" }, sends: { qualiMinutes: 120 } },
    { typed: { practiceMinutes: "60", qualiMinutes: "15" }, sends: {} },
  ])("sends $sends for $typed", ({ typed, sends }) => {
    const body = requestFrom(draft(typed))
    expect(body).not.toBeNull()
    expect({
      ...("practiceMinutes" in body! ? { practiceMinutes: body.practiceMinutes } : {}),
      ...("qualiMinutes" in body! ? { qualiMinutes: body.qualiMinutes } : {}),
    }).toEqual(sends)
  })

  it.each(["", "0", "1.5", "abc"])("previews nothing for a practice of %j", (typed) => {
    // 0 isn't a short practice to ACSM's readers, it's "use the default".
    expect(requestFrom(draft({ practiceMinutes: typed }))).toBeNull()
  })

  it("ignores the length of a session the round doesn't run", () => {
    const body = requestFrom(
      draft({ practiceMinutes: "", lengthsWas: { practice: null, quali: 15 } }),
    )
    expect(body).not.toBeNull()
    expect(body).not.toHaveProperty("practiceMinutes")
  })
})

describe("the race night a draft describes", () => {
  it.each([
    {
      night: "the league's usual",
      over: { qualiTime: "20:00" },
      times: { practice: "19:00", quali: "20:00", race: "20:15" },
    },
    {
      night: "a 23 minute practice",
      over: { qualiTime: "20:00", practiceMinutes: "23" },
      times: { practice: "19:37", quali: "20:00", race: "20:15" },
    },
    {
      night: "a two hour quali running past midnight",
      over: { qualiTime: "23:00", qualiMinutes: "120" },
      times: { practice: "22:00", quali: "23:00", race: "01:00" },
    },
    {
      night: "no practice",
      over: { qualiTime: "20:00", lengthsWas: { practice: null, quali: 15 } },
      times: { practice: null, quali: "20:00", race: "20:15" },
    },
  ])("works out $night", ({ over, times }) => {
    expect(nightFrom(draft({ qualiDate: "2026-11-04", ...over }))).toEqual(times)
  })

  it.each([
    { why: "no quali time", over: { qualiTime: "" } },
    { why: "a practice still being typed", over: { qualiTime: "20:00", practiceMinutes: "" } },
  ])("has nothing to say with $why", ({ over }) => {
    expect(nightFrom(draft({ qualiDate: "2026-11-04", ...over }))).toBeNull()
  })
})
