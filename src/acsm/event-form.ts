/**
 * The event form's one field a browser does not submit the way it reads.
 *
 * **This is a data-corrupting bug in every event save champctl made before it,
 * measured against 2.4.15.** The rendered `TrackLayout` select carries every
 * track's layouts as `{track}:{layout}` and marks *none* of them `selected`.
 * By the HTML rules `parseForm` correctly follows, a select with nothing
 * selected submits its first option — so a save of a Brands Hatch Indy event
 * posted `ks_black_cat_county:layout_int`, and ACSM stored it. The event then
 * points at a layout of a different track: no layout image on the championship
 * page, and a race night at whatever the server falls back to.
 *
 * A browser never sends that because the page's JavaScript empties the select
 * on load and rebuilds it from the chosen track's layouts alone, with bare
 * values — `indy`, not `ks_brands_hatch:indy`. champctl runs no JavaScript, so
 * it has to do the same thing by reading what the server rendered.
 *
 * The server does say which one is current, in the only place it can without a
 * `selected` attribute: a third segment on the value,
 * `ks_highlands:layout_short:current`. That is what this reads.
 *
 * The same class of problem as the checkbox rewrite in `form.ts`, and for the
 * same underlying reason: ACSM's form is not a browser-standard payload, it is
 * whatever its own JavaScript produces. Anything else the page rewrites on
 * load belongs here too. See `docs/acsm-write-path.md` §1.
 */

import * as cheerio from "cheerio"

/** ACSM's spelling for "this track has no layouts to choose between". */
const NO_LAYOUT = "<default>"

/**
 * The event's track is not installed on this server.
 *
 * The `Track` select marks nothing selected, which happens for exactly one
 * reason: ACSM renders an option per installed track, so an event on a track
 * the server no longer has matches none of them. The parsed value is then the
 * first track in the list, and posting it *moves the race* — measured, a
 * `suzuka` event on a manager without Suzuka round-tripped as
 * `ks_black_cat_county`, which is alphabetically first and nothing else.
 *
 * False when the page has no `Track` select at all. That is not a failure: a
 * build rendering an input carries the value directly, and there is no
 * selection for anything to be missing from.
 *
 * The layout has the same problem and cannot use the same signal — `TrackLayout`
 * marks nothing selected *ever*, by design. See `currentTrackLayout`.
 */
export function trackIsMissingFromServer(html: string): boolean {
  const $ = cheerio.load(html)
  const select = $('select[name="Track"]')
  return select.length > 0 && select.find("option[selected]").length === 0
}

/** Marks the option holding the layout the event currently has. */
const CURRENT = "current"

/**
 * What a browser would submit as `TrackLayout` for `track`.
 *
 * `""` when the track has no layouts, and — deliberately — also when the page
 * offers layouts but marks none of them current. That second case is an event
 * whose stored layout is not one this track has: either never set, or already
 * corrupted by the bug above.
 *
 * A browser in that position posts the first layout in the list, because that
 * is what its rebuilt dropdown happens to be showing. champctl does not, and
 * the difference is the point. There is nobody looking at a dropdown here to
 * notice that Brands Hatch just became `indy` when the event said Grand Prix,
 * so guessing would write a plausible wrong answer into a race under cover of
 * a save that was about something else. `""` changes the layout to nothing,
 * which is what the event already effectively has, and gridmom says so.
 */
export function currentTrackLayout(html: string, track: string): string {
  const $ = cheerio.load(html)
  const wanted = track.trim()
  if (!wanted) return ""

  for (const el of $('select[name="TrackLayout"] option').toArray()) {
    const parts = ($(el).attr("value") ?? "").split(":")
    const [t, layout, marker] = parts
    if (t?.trim() !== wanted || !layout) continue
    if (layout === NO_LAYOUT) continue

    // The third segment, not the first match: the select lists every track on
    // the server, so `ks_brands_hatch:gp` appears whether or not this event is
    // at Brands Hatch, let alone on the GP layout.
    if (marker?.trim() === CURRENT) return layout.trim()
  }

  // Either the track has only `<default>`, which ACSM stores as `""`, or it has
  // layouts and none is current. Both submit empty; see the doc comment.
  return ""
}
