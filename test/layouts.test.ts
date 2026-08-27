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
    const map = layoutsFrom(select(["spa:<default>", "ks_highlands:layout_int"])) ?? {}
    expect("spa" in map).toBe(false)
    expect(map["ks_highlands"]).toEqual(["layout_int"])
  })

  /**
   * The option for the layout the event is on carries a third segment, and it
   * is not part of the layout's name.
   *
   * Exactly one option per page has it, which is how it survived: the index
   * looked right for every track except the one being looked at. It reached
   * the create screen as an unpickable option, and it would have had gridmom
   * report the layout ACSM is actually running as one its track does not have.
   */
  it("drops the marker on the layout the event is currently using", () => {
    const map = layoutsFrom(
      select(["ks_highlands:layout_short:current", "ks_highlands:layout_int"]),
    )
    expect(map?.["ks_highlands"]).toEqual(["layout_short", "layout_int"])
  })

  it("reads the value, not the label", () => {
    // A build that labelled the option "Indy Circuit" would still have to
    // submit the folder name, and the folder name is what champctl stores.
    const html = `<select name="TrackLayout">
      <option value="ks_brands_hatch:indy">Indy Circuit</option>
    </select>`
    expect(layoutsFrom(html)).toEqual({ ks_brands_hatch: ["indy"] })
  })

  /**
   * No select is not the same answer as a select with nothing in it.
   *
   * A manager where every track has one layout gives `{}`, and a screen should
   * respond by not offering a choice. A page champctl cannot find the select
   * on gives no answer at all, and the same response there would hide the
   * layout field on a server that has layouts — leaving no way to set one.
   */
  it("says it found nothing, rather than that there is nothing", () => {
    expect(layoutsFrom("<html><body>no form here</body></html>")).toBeUndefined()
    expect(layoutsFrom(select(["spa:<default>"])), "a select with only defaults").toEqual({})
  })

  it("ignores an option that is not track:layout", () => {
    expect(layoutsFrom(select(["spa"]) + select([":x"]) + select(["y:"]))).toEqual({})
  })
})
