/**
 * The `TrackLayout` round-trip.
 *
 * Every case here is a shape measured on a real 2.4.15 event form, because the
 * bug this covers was invisible to a suite whose fixture rendered a single
 * `<option value="" selected>`. That select submits `""` under any reading, so
 * the tests agreed with each other and none of them agreed with ACSM.
 */

import { describe, expect, it } from "vitest"

import { currentTrackLayout } from "../src/acsm/event-form.js"
import { FIXTURE_LAYOUTS, trackLayoutSelectHtml } from "./support/acsm-html.js"

const page = (current?: { track: string; layout: string }): string =>
  `<html><body><form>${trackLayoutSelectHtml(FIXTURE_LAYOUTS, current)}</form></body></html>`

describe("what a browser would submit as TrackLayout", () => {
  it("is the layout the page marks current", () => {
    expect(
      currentTrackLayout(page({ track: "ks_brands_hatch", layout: "gp" }), "ks_brands_hatch"),
    ).toBe("gp")
  })

  /**
   * The marker belongs to one track, and the select lists every track on the
   * server. Reading the first `:current` anywhere would put another track's
   * layout on this event — the same failure as reading the first option, one
   * step less obvious.
   */
  it("ignores a marker belonging to a different track", () => {
    const html = page({ track: "ks_black_cat_county", layout: "layout_int" })
    expect(currentTrackLayout(html, "ks_brands_hatch")).toBe("")
  })

  it("is empty for a track whose only layout is the default", () => {
    // ACSM spells this `suzuka:<default>` and stores `TrackLayout: ""`.
    expect(currentTrackLayout(page(), "suzuka")).toBe("")
  })

  /**
   * The case that matters most, and the one where champctl deliberately parts
   * company with a browser.
   *
   * A track with layouts and nothing marked current is an event whose stored
   * layout is not one this track has — never set, or already corrupted. The
   * page's JavaScript would leave its rebuilt dropdown showing the first
   * layout, and a browser would post that. champctl has no dropdown and nobody
   * watching it, so it says "none" rather than writing a guess into a race.
   */
  it("is empty when the track has layouts but none is current", () => {
    expect(currentTrackLayout(page(), "ks_brands_hatch")).toBe("")
  })

  it("is empty for a track the select does not mention", () => {
    expect(currentTrackLayout(page(), "ks_nordschleife")).toBe("")
  })

  it("is empty for a page with no such select", () => {
    expect(currentTrackLayout("<html><body><form></form></body></html>", "suzuka")).toBe("")
  })
})
