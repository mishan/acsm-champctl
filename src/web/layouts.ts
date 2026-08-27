/**
 * Which layouts each installed track has.
 *
 * **Off an event edit form, because ACSM will not say anywhere else.** The
 * `/tracks` listing carries none. The track page renders
 * `track-layout-wrapper` from JavaScript with no data in the HTML.
 * `ui/meta_data.json` has a `layouts` key that was `{}` for a track the form
 * said had three. `/content/tracks/{id}/ui/` is a browsable directory, and on
 * ac.batlracing.com those directories are empty — `npm run recon:layouts` is
 * the script that asked, and the answer is in plan §3.4.
 *
 * What that costs is the reason this is separate from the cars-and-tracks
 * index rather than part of the same walk:
 *
 * - **It needs a login.** `champctl-serve` holds no credentials of its own, so
 *   this can only run on the session of whoever is asking. It cannot be warmed
 *   at boot the way the content walk is.
 * - **It needs a championship with an event** to hang the form off, which is
 *   why it goes looking for one rather than hitting a fixed URL.
 * - **The form is large** — 600KB on a manager with a couple of hundred cars,
 *   since it renders every car and every track as options. One request, but not
 *   a small one, which is why the answer is held for an hour like the rest.
 *
 * Read-only despite coming from a form: this fetches the edit page and parses
 * it. Nothing is posted, and the session is the caller's own.
 */

import type { AcsmReader } from "../acsm/client.js"
import { layoutsFrom } from "../acsm/content.js"
import { eventEditPath } from "../acsm/paths.js"
import type { AcsmSession } from "../acsm/session.js"
import type { Championship } from "../acsm/types.js"
import { events } from "../acsm/view.js"

/** Track folder name to its layouts. A track with no choice has no entry. */
export type TrackLayouts = Record<string, string[]>

/**
 * How many championships to open looking for one with an event.
 *
 * Nearly always the first. The bound is for a manager whose recent
 * championships are all empty shells — reading every one of them to fill a
 * dropdown would be a walk of the whole server.
 */
const MAX_CANDIDATES = 5

/**
 * The layout index, or `null` for "champctl could not find one".
 *
 * The distinction is the whole reason for the return type. An empty map is an
 * answer — a manager where every track has a single layout — and a screen can
 * act on it by not offering a choice. `null` is the absence of an answer, and
 * a screen that treats the two alike hides the layout field on a server whose
 * layouts champctl simply failed to read, leaving no way to set one at all.
 */
export async function readTrackLayouts(
  session: AcsmSession,
  reader: AcsmReader,
): Promise<TrackLayouts | null> {
  const summaries = await reader.listChampionships()

  let looked = 0
  for (const summary of summaries) {
    const id = typeof summary.ID === "string" ? summary.ID : undefined
    if (!id) continue
    if (looked >= MAX_CANDIDATES) break
    looked++

    let championship: Championship
    try {
      championship = await reader.exportChampionship(id)
    } catch {
      // A championship that will not export is one to skip, not a reason to
      // give up on layouts entirely.
      continue
    }

    const eventId = events(championship).find((ev) => (ev.ID ?? "").trim())?.ID
    if (!eventId) continue

    // The form for *some* event. Which one does not matter: the select lists
    // every track on the server, not the ones this event uses.
    const html = await session.getText(eventEditPath(id, eventId))
    // `undefined` means the page had no `TrackLayout` select — a build that
    // renders the form differently, and another championship's event form
    // would be the same page. Reported as "no index" rather than as an empty
    // one, so the screen offers free text instead of insisting every track
    // here has a single layout.
    return layoutsFrom(html) ?? null
  }

  // Nothing to read a form off, so there is nothing to say about layouts. A
  // manager with no championships is one where the create screen has nothing
  // to clone either, so this is not the failure anyone is about to hit.
  return null
}
