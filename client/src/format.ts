import type { RaceFormat } from "./api"

/**
 * Formats for display only.
 *
 * The server already produces the diff a person reads — `plan.changes` is
 * "Race length: 40 minutes → 18 laps", computed by the same code the CLI
 * prints. These are for the places the server has no opinion about: a row in
 * the round list, the label on a preset button.
 *
 * Kept deliberately small for that reason. Anything a push depends on is
 * described by the server, so that the preview and the write cannot disagree.
 */

export function describeLength(l: RaceFormat["length"]): string {
  return l.kind === "laps"
    ? `${l.laps} ${l.laps === 1 ? "lap" : "laps"}`
    : `${l.minutes} ${l.minutes === 1 ? "minute" : "minutes"}`
}

export function describeFormat(f: RaceFormat): string {
  const parts = [describeLength(f.length)]
  if (f.reversedGridPositions > 0) parts.push(`reversed top ${f.reversedGridPositions}`)
  if (f.mandatoryPit) parts.push("mandatory pit")
  if (f.extraLap) parts.push("extra lap")
  return parts.join(" · ")
}

/**
 * `ks_brands_hatch/indy`, or just the track when it has one layout.
 *
 * The identifier form rather than a sentence, and one function rather than a
 * template string in each of the three places that need it. It is the spelling
 * ACSM uses, the spelling the pit table is keyed by, and the one somebody
 * checking champctl's work against Server Manager is looking at.
 */
export function venueLabel(venue: { track: string; layout: string }): string {
  const track = venue.track.trim()
  if (!track) return ""
  const layout = venue.layout.trim()
  return layout ? `${track}/${layout}` : track
}

/** True when the two describe the same race. Mirrors `sameFormat` on the server. */
export function sameFormat(a: RaceFormat, b: RaceFormat): boolean {
  const sameLength =
    a.length.kind === b.length.kind &&
    (a.length.kind === "laps"
      ? a.length.laps === (b.length as { laps: number }).laps
      : a.length.minutes === (b.length as { minutes: number }).minutes)

  return (
    sameLength &&
    a.reversedGridPositions === b.reversedGridPositions &&
    a.mandatoryPit === b.mandatoryPit &&
    a.extraLap === b.extraLap
  )
}
