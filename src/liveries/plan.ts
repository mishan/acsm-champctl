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

import type { Championship, ChampionshipEvent, Entrant, SessionKey } from "../acsm/types.js"
import { classes, events, eventSession, isZeroTime, slots } from "../acsm/view.js"
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
  /**
   * Every livery in the pack, matched to its entrant. All of these upload.
   *
   * This used to hold only the ones whose `Skin` field would change, with the
   * rest in an `unchanged` list that was never uploaded and a `noop` flag that
   * skipped the run entirely. That conflated two different questions. The skin
   * *folder* is always the driver's own name, so `fromSkin === skinFolder` only
   * says "this ran for them before" — it says nothing about the bytes. A driver
   * who fixed a wrong sponsor and resubmitted got "Already assigned, nothing to
   * do", zero requests, and the old livery still on the server.
   *
   * Nothing here can answer whether the bytes changed: ACSM offers no way to
   * ask what is in a skin folder. So the upload is unconditional, which is what
   * the upload being additive and overwriting-by-filename is for. What stays
   * conditional is the *write* — see `skinChanges`.
   */
  assignments: LiveryAssignment[]
  /**
   * The assignments whose `EntryList.Skin` on the championship form has to
   * change. Empty means the uploads happen and the championship is not posted.
   */
  skinChanges: LiveryAssignment[]
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
  // Refused here as well as at the write, and this is the one that saves
  // anybody anything: the export is public, so the preview learns it before a
  // single byte is uploaded or a password is needed. The write-path refusal in
  // `apply.ts` is what makes it a guarantee rather than a courtesy — it reads
  // the form, which is what actually gets posted. See `MultiClassError` and
  // docs/acsm-champ-form.md §4.4 for what ACSM does with the second class.
  const classCount = classes(championship).length
  if (classCount > 1) {
    throw new LiveryPlanError(
      `This championship has ${classCount} classes, and champctl only assigns liveries in ` +
        `single-class championships. Saving the championship form rebuilds every pit box by ` +
        `position, and ACSM restarts that numbering for each class — so two classes means two ` +
        `drivers holding the same pit box, and one of them disappears from the entry list when ` +
        `the next session starts. Nothing has been uploaded. Assign these skins in ACSM by hand, ` +
        `or see docs/acsm-champ-form.md §4.4.`,
    )
  }

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

  return {
    championshipId,
    championshipName: (championship.Name ?? "").trim() || championshipId,
    assignments,
    skinChanges: assignments.filter((a) => a.fromSkin !== a.skinFolder),
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

/**
 * Has this round actually been raced?
 *
 * Not `eventHasStarted`, which is what this used to call and which reported a
 * round as raced while its *practice server* was running. ACSM stamps
 * `StartedTime` from the UDP new-session callback:
 *
 *     case udp.SessionInfo:
 *         if a.Event() == udp.EventNewSession {
 *             if championship.Events[i].StartedTime.IsZero() {
 *                 championship.Events[i].StartedTime = time.Now()
 *
 * and a looping practice is a session on the active championship like any
 * other, so an untouched round that somebody opened practice on looks started.
 * `eventHasStarted` is right where it is used — refusing an import over an
 * event that has begun is the safe side of that question — and wrong here,
 * where the answer only decides whether to print a sentence about replays.
 *
 * Results are the thing being asked about, so results are what this reads:
 * ACSM's own `ChampionshipSession.Completed()` is `!CompletedTime.IsZero() &&
 * Results != nil`.
 *
 * **And only the sessions that are a race weekend.** Reading every session in
 * the map put the original bug straight back: a looping practice server writes
 * its own `CompletedTime` each time a loop ends, so the untouched round was
 * reported as raced again about an hour later. Practice and booking are
 * excluded by name; qualifying counts, because a qualifying session with
 * results is a session whose replay somebody may go back to.
 *
 * Read through `eventSession` rather than off `Sessions` directly — the map is
 * keyed by ACSM's `SessionType`, whose spelling varies by build, and a lookup
 * that misses reports "not raced" without saying so.
 */
const RACED_SESSIONS: readonly SessionKey[] = ["Qualifying", "Race"]

function eventHasResults(ev: ChampionshipEvent | undefined): boolean {
  if (!ev) return false
  if (!isZeroTime(ev.CompletedTime)) return true
  for (const key of RACED_SESSIONS) {
    const session = eventSession(ev, key)
    if (!session) continue
    if (session.Results) return true
    if (!isZeroTime(session.CompletedTime)) return true
  }
  return false
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
