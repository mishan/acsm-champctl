/**
 * Reading a track's layouts off an event edit form.
 *
 * The markup is trimmed from what 2.4.15 actually served. It is the only place
 * ACSM will say what layouts a track has: the listing pages carry none, the
 * track page builds its own from JavaScript, and `/content/tracks/{t}/ui/` on
 * a real league's manager holds no layout folders at all.
 */

import { describe, expect, it } from "vitest"

import { layoutsFrom } from "../src/acsm/content.js"

/** As ACSM renders it: the value carries `{track}:{layout}`. */
const select = (values: string[]): string =>
  `<select class="form-control" name="TrackLayout" id="TrackLayout">${values
    .map(
      (v) =>
        `<option value="${v}" data-track-name="${v.split(":")[1]}">${v.split(":")[1]}</option>`,
    )
    .join("")}</select>`

describe("layouts off the event form", () => {
  it("groups them by the track they belong to", () => {
    expect(
      layoutsFrom(
        select([
          "ks_black_cat_county:layout_int",
          "ks_black_cat_county:layout_long",
          "ks_highlands:layout_drift",
        ]),
      ),
    ).toEqual({
      ks_black_cat_county: ["layout_int", "layout_long"],
      ks_highlands: ["layout_drift"],
    })
  })

  /**
   * `<default>` is how ACSM spells "this track has no layouts". Measured on
   * 2.4.15: ten tracks carried only it, seven carried only real layouts, and
   * none carried both — so it is a sentinel, not a layout, and offering it as
   * one would put the literal string `<default>` into `RaceSetup.TrackLayout`.
   */
  it("drops the no-layout sentinel rather than offering it", () => {
    expect(layoutsFrom(select(["spa:<default>", "monza:<default>"]))).toEqual({})
  })

  it("leaves a track out entirely when it has nothing to choose", () => {
    const map = layoutsFrom(select(["spa:<default>", "ks_highlands:layout_int"]))
    expect("spa" in map).toBe(false)
    expect(map["ks_highlands"]).toEqual(["layout_int"])
  })

  it("reads the value, not the label", () => {
    // A build that labelled the option "Indy Circuit" would still have to
    // submit the folder name, and the folder name is what champctl stores.
    const html = `<select name="TrackLayout">
      <option value="ks_brands_hatch:indy">Indy Circuit</option>
    </select>`
    expect(layoutsFrom(html)).toEqual({ ks_brands_hatch: ["indy"] })
  })

  it("has nothing to say about a page with no such select", () => {
    expect(layoutsFrom("<html><body>no form here</body></html>")).toEqual({})
  })

  it("ignores an option that is not track:layout", () => {
    expect(layoutsFrom(select(["spa"]) + select([":x"]) + select(["y:"]))).toEqual({})
  })
})
