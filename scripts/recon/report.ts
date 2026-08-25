/**
 * Pure reporting helpers for the recon scripts.
 *
 * Separated from the scripts so they can be tested. Both of these produced
 * plausible-looking but wrong output at some point — a sentinel that read as a
 * shared pit box, and a list that re-reported fields the caller had just
 * explained — and neither failure would stop a run or look obviously wrong in
 * the log. That is exactly the kind of thing worth pinning down.
 */

import { NON_ARRAY_ENTRY_LIST_FIELDS } from "../../src/acsm/form.js"
import type { Championship } from "../../src/acsm/types.js"
import { events, slots } from "../../src/acsm/view.js"

/**
 * EntryList keys whose count doesn't match the entrant count, excluding those
 * already known not to be per-entrant arrays.
 *
 * Without the exclusion this re-reports the unpaired checkboxes and the
 * NumEntrants counter that the caller has just described, and the genuinely
 * interesting key — a counter nobody has seen before, or an array that really
 * is short — gets lost among them. Uses the same list `postForm` refuses on,
 * so this says what champctl would actually reject.
 */
export function raggedKeys(shapes: Record<string, number>, expected: number): string[] {
  const known = new Set<string>(NON_ARRAY_ENTRY_LIST_FIELDS)
  return Object.entries(shapes)
    .filter(([k, n]) => k.startsWith("EntryList.") && !known.has(k) && n !== expected)
    .map(([k, n]) => `${k}=${n}`)
}

export interface PitBoxComparison {
  sentCount: number
  returnedCount: number
  /** How many entrants didn't survive the round trip. */
  entrantsLost: number
  sentDuplicates: number[]
  /** Slots with no PitBox at all — ACSM defaults those to the list index. */
  sentWithoutPitBox: number
  sentPitBoxes: (number | undefined)[]
  returnedPitBoxes: (number | undefined)[]
}

/**
 * Does a duplicate pit box cost an entrant?
 *
 * `AddInPitBox` overwrites on collision, so if import routes through it, two
 * entrants sharing a box means one is silently deleted. Comparing the counts
 * either side of the round trip answers that.
 *
 * An entrant with no `PitBox` has no box, rather than a box numbered -1.
 * Folding those into a sentinel made them collide with each other and produced
 * "duplicate pit boxes at -1", which is a sentence about nothing. They're
 * excluded from the duplicate hunt and counted separately, since a slot whose
 * position is doing the work is worth knowing about on its own
 * (docs/acsm-write-path.md §2).
 */
export function comparePitBoxes(
  sent: Championship,
  returned: Championship,
): PitBoxComparison {
  const boxesOf = (c: Championship): (number | undefined)[] =>
    slots(events(c)[0]?.EntryList).map((s) => s.entrant.PitBox)

  const before = boxesOf(sent)
  const after = boxesOf(returned)

  const seen = new Set<number>()
  const duplicates = new Set<number>()
  for (const b of before) {
    if (typeof b !== "number") continue
    if (seen.has(b)) duplicates.add(b)
    seen.add(b)
  }

  return {
    sentCount: before.length,
    returnedCount: after.length,
    entrantsLost: Math.max(0, before.length - after.length),
    sentDuplicates: [...duplicates].sort((a, b) => a - b),
    sentWithoutPitBox: before.filter((b) => typeof b !== "number").length,
    sentPitBoxes: before,
    returnedPitBoxes: after,
  }
}
