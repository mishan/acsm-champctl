/**
 * The grid cap, and which track is responsible for it (plan §4.5, §5.1 step 5).
 *
 * `MaxClients` is how many cars can be on track, and across a month it is
 * bounded by the *smallest* pit count among the chosen tracks — a 24-box club
 * circuit caps every night of a month that includes it.
 *
 * The review screen has to name that track. "Capped at 24" invites someone to
 * argue with the number; "capped at 24 by Brands Hatch Indy" tells them which
 * track to drop if they want a bigger grid. Same fact, one of them actionable.
 *
 * **Entry list length is a separate number and must not be derived from this**
 * (plan §4.4). BATL runs 30 slots against `MaxClients: 18` deliberately, on the
 * assumption not everyone shows. Sizing the entry list down to the smallest
 * track would lock people out of a *championship* for a constraint that only
 * applies on one night of it.
 */

import { humanList } from "../gridmom/finding.js"
import type { PitTable } from "../pits/table.js"

export interface TrackRef {
  track: string
  layout?: string
}

export interface GridCap {
  /** What to write as `MaxClients`. */
  maxClients: number
  /** The track that set it, when one did. */
  bindingTrack?: string
  /** Tracks with no pit count on file, so the cap is a guess without them. */
  unknownTracks: string[]
  /** One sentence for a review screen. */
  summary: string
}

/**
 * How many cars a month can run, given its tracks.
 *
 * An unknown pit count is *not* treated as unlimited. A month whose tracks are
 * all unknown gets no cap at all and says so, rather than quietly emitting a
 * number derived from nothing — that's the same fail-loud choice the pit table
 * makes elsewhere, where a missing count degrades gridmom to a warning rather
 * than a guess.
 */
export function gridCap(
  tracks: readonly TrackRef[],
  pits?: PitTable,
  options: { fallback?: number; reservedBoxes?: number } = {},
): GridCap {
  const fallback = options.fallback ?? 0
  // Boxes that are spoken for before any driver is. The spectator car occupies
  // one, and gridmom's grid.max-clients counts it against the track's capacity
  // — so a cap set to the raw pit count emitted a month its own checker
  // refused, off by exactly the number of spectator cars.
  const reserved = options.reservedBoxes ?? 0
  const unknownTracks: string[] = []
  let smallest: { label: string; boxes: number } | undefined

  for (const t of tracks) {
    // No trim here on purpose: `pitKey` normalises both values, so the lookup
    // and the label already agree about " spa " and "spa". Repeating it at the
    // call site would be a second copy of a rule that has one home, and the
    // kind that drifts. `test/infra.test.ts` pins the boundary.
    const label = trackPhrase(t)
    const record = pits?.get(t.track, t.layout ?? "")
    if (!record || typeof record.pitboxes !== "number" || record.pitboxes <= 0) {
      if (!unknownTracks.includes(label)) unknownTracks.push(label)
      continue
    }
    const usable = record.pitboxes - reserved
    if (usable <= 0) {
      // Every box is reserved. Not a cap anyone can race under, and silently
      // emitting 0 is the bug this module already refuses elsewhere.
      if (!unknownTracks.includes(label)) unknownTracks.push(label)
      continue
    }
    if (!smallest || usable < smallest.boxes) {
      smallest = { label, boxes: usable }
    }
  }

  if (!smallest) {
    return {
      maxClients: fallback,
      unknownTracks,
      summary:
        unknownTracks.length === 0
          ? "No tracks, so no grid cap."
          : `No pit counts on file for ${humanList(unknownTracks)}, so the grid cap is unknown. ` +
            `Add them to the track pit table before pushing.`,
    }
  }

  const reservedNote = reserved > 0 ? ` (${reserved} reserved for the spectator car)` : ""
  const summary =
    unknownTracks.length === 0
      ? `Capped at ${smallest.boxes} by ${smallest.label}${reservedNote}.`
      : `Capped at ${smallest.boxes} by ${smallest.label}${reservedNote}, but ${humanList(unknownTracks)} ` +
        `${unknownTracks.length === 1 ? "has" : "have"} no pit count on file and could be smaller.`

  return {
    maxClients: smallest.boxes,
    bindingTrack: smallest.label,
    unknownTracks,
    summary,
  }
}

/**
 * A track for the middle of a sentence — "brands_hatch (indy)" — as read in the
 * grid summary and the unknown-track list.
 *
 * Trimmed, because untrimmed values produce two entries that look identical —
 * "spa" and "spa " — in a list whose whole job is telling someone which track
 * to add a pit count for.
 *
 * Deliberately not `trackLabel`, which is exported from acsm/view.ts and
 * produces the identifier form `brands_hatch/indy`. Same idea, different
 * audience, and one name for both is how "capped at 24 by brands_hatch/indy"
 * reaches a person.
 */
function trackPhrase(t: TrackRef): string {
  const track = t.track.trim()
  const layout = t.layout?.trim()
  return layout ? `${track} (${layout})` : track
}
