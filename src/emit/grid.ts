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
export function gridCap(tracks: readonly TrackRef[], pits?: PitTable, fallback = 0): GridCap {
  const unknownTracks: string[] = []
  let smallest: { label: string; boxes: number } | undefined

  for (const t of tracks) {
    const label = trackLabel(t)
    const record = pits?.get(t.track, t.layout ?? "")
    if (!record || typeof record.pitboxes !== "number" || record.pitboxes <= 0) {
      if (!unknownTracks.includes(label)) unknownTracks.push(label)
      continue
    }
    if (!smallest || record.pitboxes < smallest.boxes) {
      smallest = { label, boxes: record.pitboxes }
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

  const summary =
    unknownTracks.length === 0
      ? `Capped at ${smallest.boxes} by ${smallest.label}.`
      : `Capped at ${smallest.boxes} by ${smallest.label}, but ${humanList(unknownTracks)} ` +
        `${unknownTracks.length === 1 ? "has" : "have"} no pit count on file and could be smaller.`

  return {
    maxClients: smallest.boxes,
    bindingTrack: smallest.label,
    unknownTracks,
    summary,
  }
}

function trackLabel(t: TrackRef): string {
  return t.layout ? `${t.track} (${t.layout})` : t.track
}

function humanList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ""
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`
}
