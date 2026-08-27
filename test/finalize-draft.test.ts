import { describe, expect, it } from "vitest"

import { type Draft, requestFrom } from "../client/src/draft.js"

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
