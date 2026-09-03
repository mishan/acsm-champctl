/**
 * Working out what a livery pack would change, before anything is written.
 *
 * Two jobs. Matching each livery to a class entrant, which is ordinary and
 * fails closed; and answering whether a championship-level write reaches the
 * races at all, which is not ordinary and is the reason this file has a whole
 * section about UUIDs.
 *
 * **Why the class list.** `ChampionshipEvent.CombineEntryLists` builds the list
 * ACSM writes to `entry_list.ini` from `championship.AllEntrants()` — the class
 * entrants — and then lets the event's own entrant overwrite six properties on
 * top, `Skin` among them. Setting a skin on the class list is therefore the one
 * write that applies to every round at once. champctl never posts to an event
 * form here.
 *
 * **When it wouldn't reach.** That overwrite is keyed on `InternalUUID`, with a
 * guard:
 *
 *     if entrant.InternalUUID != uuid.Nil &&
 *        entrant.InternalUUID == eventEntrant.InternalUUID &&
 *        entrant.Model == eventEntrant.Model {
 *         entrant.OverwriteProperties(eventEntrant)
 *     }
 *
 * So if a class entrant has a real UUID that matches a round's entrant, that
 * round's stored skin wins and the class skin never shows up on track. Measured
 * on BATL's manager the class entrants carry no usable UUID at all, so nothing
 * matches and the class skin is what races — but that is a measurement of one
 * championship, not a law. `reachability` recomputes it per run, and a plan
 * that cannot reach a round says so rather than reporting a success that only
 * happened in the database.
 */

import type { Championship, Entrant } from "../acsm/types.js"
import { classes, events, slots } from "../acsm/view.js"
import type { Livery, LiveryPack } from "./pack.js"

export class LiveryPlanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LiveryPlanError"
  }
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000"

/** See `normalise` in `pack.ts` — both sides of the name match use NFC. */
function normalise(value: string): string {
  return value.normalize("NFC")
}

function hasRealUuid(entrant: Entrant): boolean {
  const id = (entrant.InternalUUID ?? "").trim()
  return id !== "" && id !== NIL_UUID
}

export interface LiveryAssignment {
  driverName: string
  carModel: string
  skinFolder: string
  /** Index into `Championship.Classes`. */
  classIndex: number
  /** Index within that class's entrants, in `CAR_n` order. */
  entrantIndex: number
  /** The skin the class entrant has now. */
  fromSkin: string
  /** The livery's files, for the upload. */
  livery: Livery
  /**
   * Rounds whose own entry list would override this skin, 1-based.
   *
   * Empty is the normal and wanted case. Non-empty means the class write lands
   * and the race still runs the old livery.
   */
  overriddenInRounds: number[]
}

export interface LiveryPlan {
  championshipId: string
  championshipName: string
  assignments: LiveryAssignment[]
  /** Assignments whose skin is already what the pack sets. Nothing to write. */
  unchanged: LiveryAssignment[]
  /** True when no assignment would change anything. */
  noop: boolean
  /** Rounds that already have results, 1-based. Not blocking; a skin is cosmetic. */
  racedRounds: number[]
}

/**
 * Matches the pack to the championship, refusing anything ambiguous.
 *
 * Every refusal here is total: no assignment is applied unless all of them can
 * be. A livery drop that half-happened leaves the operator diffing a Discord
 * thread against an entry list at nine at night, and the cost of the other
 * choice is re-zipping a file.
 */
export function planLiveries(
  championship: Championship,
  championshipId: string,
  pack: LiveryPack,
): LiveryPlan {
  const roster = rosterOf(championship)

  const assignments: LiveryAssignment[] = []
  for (const livery of pack.liveries) {
    // Normalised here as well as in `pack.ts`, because this is the function
    // doing the comparing. Depending on the caller to have normalised means the
    // day something else builds a `Livery` — the Discord bot, a test — the
    // match silently stops working for exactly the drivers it was fixed for.
    const driverName = normalise(livery.driverName)
    const carModel = normalise(livery.carModel)
    const matches = roster.filter((r) => r.name === driverName)

    if (matches.length === 0) {
      throw new LiveryPlanError(
        `No entrant called "${driverName}" in this championship. Names are matched exactly, ` +
          `so a trailing space or different capitalisation in the zip is enough to miss. ` +
          `${nearbyNames(roster, driverName)}`,
      )
    }
    if (matches.length > 1) {
      throw new LiveryPlanError(
        `"${driverName}" appears ${matches.length} times in the entry list, so champctl ` +
          `can't tell which one the livery is for. Fix the duplicate in ACSM first.`,
      )
    }

    const match = matches[0]!
    if (match.model !== carModel) {
      throw new LiveryPlanError(
        `${driverName} is entered in ${match.model || "no car"}, but the livery is filed ` +
          `under ${carModel}. Uploading it would put the skin on a car they don't drive. ` +
          `Move it to the right folder in the pack, or fix their car in ACSM.`,
      )
    }

    assignments.push({
      driverName,
      carModel,
      skinFolder: normalise(livery.skinFolder),
      classIndex: match.classIndex,
      entrantIndex: match.entrantIndex,
      fromSkin: match.skin,
      livery,
      overriddenInRounds: overridingRounds(championship, match.entrant),
    })
  }

  const changed = assignments.filter((a) => a.fromSkin !== a.skinFolder)
  const unchanged = assignments.filter((a) => a.fromSkin === a.skinFolder)

  return {
    championshipId,
    championshipName: (championship.Name ?? "").trim() || championshipId,
    assignments: changed,
    unchanged,
    noop: changed.length === 0,
    racedRounds: events(championship)
      .map((ev, i) => (eventHasResults(ev) ? i + 1 : 0))
      .filter((n) => n > 0),
  }
}

interface RosterEntry {
  name: string
  model: string
  skin: string
  classIndex: number
  entrantIndex: number
  entrant: Entrant
}

/**
 * Every class entrant, with the position the championship form will render it
 * at.
 *
 * `slots()` sorts by the `CAR_n` key, which is the order
 * `ChampionshipClass.Entrants.AsSlice` renders and therefore the order the form
 * lays the rows out in. Getting that order wrong puts a livery on the wrong
 * driver, so it is worth saying out loud that these two sorts are the same one.
 */
function rosterOf(championship: Championship): RosterEntry[] {
  const out: RosterEntry[] = []
  classes(championship).forEach((cls, classIndex) => {
    slots(cls.Entrants).forEach((slot, entrantIndex) => {
      out.push({
        // NFC on both sides of the comparison, matching what `pack.ts` does to
        // the zip. "Häkkinen" has a precomposed and a decomposed encoding, and
        // a macOS-made zip carries the second where ACSM will hold the first —
        // two byte sequences for text that prints identically. Normalising is
        // not a loosening of the exact-name rule: case and stray whitespace
        // still miss.
        name: normalise((slot.entrant.Name ?? "").trim()),
        model: normalise((slot.entrant.Model ?? "").trim()),
        skin: normalise((slot.entrant.Skin ?? "").trim()),
        classIndex,
        entrantIndex,
        entrant: slot.entrant,
      })
    })
  })
  return out
}

/**
 * Rounds where this entrant's own entry-list row would win over the class one.
 *
 * Both halves of ACSM's condition, because either one failing means no
 * override: a real (non-nil) `InternalUUID` on the class entrant, matched by a
 * round entrant with the same UUID *and* the same `Model`.
 */
function overridingRounds(championship: Championship, classEntrant: Entrant): number[] {
  if (!hasRealUuid(classEntrant)) return []
  const uuid = (classEntrant.InternalUUID ?? "").trim()
  const model = (classEntrant.Model ?? "").trim()

  return events(championship)
    .map((ev, i) => {
      // A round with no entry list of its own needs no special case: ACSM
      // returns the class list untouched for those, and an empty list has
      // nothing to match, so both roads arrive at "not overridden". An explicit
      // early return for it was here and was dead code — removing it changed no
      // test, which is how it was found.
      const match = slots(ev?.EntryList).find(
        (s) =>
          (s.entrant.InternalUUID ?? "").trim() === uuid &&
          (s.entrant.Model ?? "").trim() === model,
      )
      return match ? i + 1 : 0
    })
    .filter((n) => n > 0)
}

function eventHasResults(ev: { StartedTime?: string } | undefined): boolean {
  const t = ev?.StartedTime
  return !!t && !t.startsWith("0001-01-01T")
}

/**
 * A hint for the near-misses that actually happen: case, and stray whitespace.
 *
 * Deliberately not a fuzzy search. "Did you mean" on an entry list invites
 * someone to accept a suggestion, and the failure mode of accepting the wrong
 * one is a driver racing under another driver's name.
 */
function nearbyNames(roster: readonly RosterEntry[], wanted: string): string {
  const fold = (s: string) => normalise(s).toLowerCase().replace(/\s+/g, "")
  const close = roster.filter((r) => r.name && fold(r.name) === fold(wanted)).map((r) => r.name)
  if (close.length === 0) return "No entrant name is close to it either."
  return `The entry list has ${close.map((n) => `"${n}"`).join(", ")}, which differs only in case or spacing.`
}

/**
 * Rounds a plan would fail to reach, across every assignment.
 *
 * Separate from the assignments because it is a property of the plan as a
 * whole: the operator's question is "will tonight's race show the new liveries",
 * not "which drivers are affected".
 */
export function unreachableRounds(plan: LiveryPlan): number[] {
  const rounds = new Set<number>()
  for (const a of plan.assignments) for (const r of a.overriddenInRounds) rounds.add(r)
  return [...rounds].sort((a, b) => a - b)
}
