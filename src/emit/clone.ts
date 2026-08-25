/**
 * Clone the previous championship (plan §5.1: "should be the prominent path — it will be the
 * most used").
 *
 * A clone is the template-and-overlay pipeline with the template pointed at
 * the previous championship instead of a golden fixture, and the spec read
 * back out of it. Everything else — derived `Cars`, stamped `Created`, dropped
 * results, regenerated UUIDs — is the same code, which is the point: the path
 * people use most is not the path with its own bugs.
 */

import type { Championship } from "../acsm/types.js"
import { classes, events, raceSetupCars } from "../acsm/view.js"
import { readFormat } from "../finalize/format.js"
import type { PitTable } from "../pits/table.js"
import type { LeagueProfile } from "../profile/types.js"
import {
  EmitError,
  emitChampionship,
  type EmitResult,
  type ChampionshipSpec,
  type RoundSpec,
} from "./championship.js"

/**
 * Reads a championship spec back out of a championship.
 *
 * Only the parts a league would restate: name, cars, tracks in order, the
 * format the first round ran, and how many entry-list slots it held.
 *
 * Deliberately not the schedule. The previous championship's dates are the one thing a clone
 * definitely does not want — that is what `startDate` is for — and carrying
 * them would silently produce a "new" championship that had already happened.
 */
export function specFromChampionship(source: Championship): ChampionshipSpec {
  const cls = classes(source)[0]
  const evs = events(source)
  if (evs.length === 0) {
    throw new EmitError(
      `Championship ${source.Name ?? source.ID ?? "(unnamed)"} has no events, so there is no ` +
        `championship to clone from it.`,
    )
  }

  const first = evs[0]
  // AvailableCars is the class's own list. RaceSetup.Cars is the derived,
  // semicolon-joined copy, so it is the fallback rather than the source — it
  // may carry a spectator model the class never had (plan §5.5).
  const cars = cls?.AvailableCars?.length ? [...cls.AvailableCars] : raceSetupCars(first?.RaceSetup)

  const rounds: RoundSpec[] = evs.map((ev) => {
    const track = ev.RaceSetup?.Track ?? ""
    const layout = ev.RaceSetup?.TrackLayout ?? ""
    return { track, ...(layout ? { layout } : {}) }
  })

  const spec: ChampionshipSpec = {
    name: source.Name ?? "",
    cars,
    rounds,
    ...(cls?.Name ? { className: cls.Name } : {}),
  }

  const slots = Object.keys(cls?.Entrants ?? first?.EntryList ?? {}).length
  if (slots > 0) spec.entryListSlots = slots

  if (first) spec.format = readFormat(first)

  return spec
}

export interface CloneOptions {
  /** The previous championship, used as both template and the source of the spec. */
  source: Championship
  profile: LeagueProfile
  /** Anything the new championship changes — usually name, startDate and tracks. */
  overrides?: Partial<ChampionshipSpec>
  pits?: PitTable
  now?: Date
}

/**
 * Builds this championship from the previous championship.
 *
 * `overrides` is a shallow layer over the derived spec, so passing `rounds`
 * replaces the track list outright rather than merging into it — the same
 * reasoning as arrays in `merge.ts`, and the behaviour someone reordering a
 * championship expects.
 */
export function cloneChampionship(options: CloneOptions): EmitResult {
  const derivedSpec = specFromChampionship(options.source)
  const spec: ChampionshipSpec = { ...derivedSpec, ...(options.overrides ?? {}) }

  if (!spec.name) {
    throw new EmitError(
      "A cloned championship needs a name — the source had none, so there is nothing to fall back on. " +
        "Pass one in overrides.",
    )
  }

  return emitChampionship({
    template: options.source,
    spec,
    profile: options.profile,
    ...(options.pits ? { pits: options.pits } : {}),
    ...(options.now ? { now: options.now } : {}),
  })
}
