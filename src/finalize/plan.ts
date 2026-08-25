/**
 * The finalize plan: what would change, and what would be sent.
 *
 * Plan §5.2. Building a plan performs **no writes** — it fetches the event
 * form, works out the difference, runs gridmom against the championship as it
 * *would* be, and hands back something a person can read and approve. Applying
 * it is `apply.ts`, deliberately a separate call.
 *
 * Two levels of change come out of this, and both matter:
 *
 * - `changes` is the diff a person reads. "Race length: 40 minutes → 18 laps."
 *   Computed from the export, which is typed and semantic.
 * - `formChanges` is what will actually be posted, field by field. It exists so
 *   the preview cannot lie: if the form would send something the human-readable
 *   diff didn't mention, it shows up here.
 *
 * The entry-list fingerprint is taken here, at screen-open time, and checked
 * again immediately before the POST. See `apply.ts` for why.
 */

import { createHash } from "node:crypto"

import {
  findFormByAction,
  getAll,
  getOne,
  shape,
  NON_ARRAY_ENTRY_LIST_FIELDS,
  UNPAIRED_ENTRY_LIST_CHECKBOXES,
  type FormField,
  type ParsedForm,
} from "../acsm/form.js"
import type { AcsmSession } from "../acsm/session.js"
import type { Championship, ChampionshipEvent } from "../acsm/types.js"
import { eventEditPath, eventSubmitPath } from "../acsm/write.js"
import { events } from "../acsm/view.js"
import { check, type CheckReport } from "../gridmom/index.js"
import type { LeagueProfile } from "../profile/types.js"
import type { PitTable } from "../pits/table.js"
import {
  applyFormat,
  describeLength,
  formFieldsFor,
  readFormat,
  sameFormat,
  type Change,
  type FormFieldChange,
  type RaceFormat,
} from "./format.js"
import {
  currentQualiStart,
  practiceMinutesFor,
  qualiStartFrom,
  scheduledFromQuali,
  scheduleFormValues,
  type ScheduleFormValues,
} from "./schedule.js"

export class FinalizeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FinalizeError"
  }
}

// `Change` and `FormFieldChange` are declared in `format.ts` and re-exported
// here, where they are produced. They moved because the browser needs them and
// this module imports `node:crypto`; `format.ts` imports only the export's own
// types, so a client can follow the type and stop there.
export type { Change, FormFieldChange }

export interface FinalizePlan {
  championshipId: string
  eventId: string
  /** 1-based, as a league counts rounds. */
  round: number
  current: RaceFormat
  desired: RaceFormat
  changes: Change[]
  formChanges: FormFieldChange[]
  /** Present only when quali timing moves; it is a second request. */
  schedule?: {
    from: string | undefined
    to: string
    values: ScheduleFormValues
  }
  gridmom: CheckReport
  /** Blocking, i.e. gridmom found an ERROR in the would-be championship. */
  blocked: boolean
  /** Nothing to do — the event already matches. */
  noop: boolean
  /**
   * Fingerprint of the entry list as rendered at plan time. Opaque; compared
   * for equality against a re-fetch just before the write.
   */
  entryListFingerprint: string
  /** The parsed form, kept so the caller can show what was read. */
  form: ParsedForm
}

export interface PlanOptions {
  championship: Championship
  championshipId: string
  eventId: string
  format: RaceFormat
  /** League-local quali start. Omit to leave the schedule alone. */
  qualiStart?: { date: string; time: string }
  profile: LeagueProfile
  pits?: PitTable
  now?: Date
}

/**
 * `EntryList.*` keys deliberately left out of the fingerprint.
 *
 * `EntrantID` is the pit box, and on 2.4.x the form renders it as the row's
 * position rather than the entrant's stored value — always `0..n-1`, whatever
 * the entrants are actually numbered. Hashing it means the fingerprint changes
 * whenever the rows move, which is on every request.
 *
 * The per-entrant checkboxes are excluded for a different reason, and it is no
 * longer the one this comment used to give. `parseForm` now emits every
 * checkbox as "1" or "0", so they *are* attributable to entrants — "a browser
 * drops the unchecked ones" describes a payload champctl stopped producing.
 * They are excluded because champctl strips them before every POST (form.ts),
 * so it neither preserves nor promises them: guarding a value the write is
 * going to discard would refuse a save over a field nobody is protecting.
 */
const FINGERPRINT_EXCLUDED: ReadonlySet<string> = new Set<string>([
  "EntryList.EntrantID",
  ...UNPAIRED_ENTRY_LIST_CHECKBOXES,
  ...NON_ARRAY_ENTRY_LIST_FIELDS,
])

/**
 * The entry list as a set of entrants, hashed. Order-insensitive.
 *
 * This used to hash every `EntryList.*` value in document order, reasoning that
 * ACSM reads them as parallel positional arrays so a reorder is a real change.
 * The reasoning is right and the conclusion was still wrong: measured on 2.4.5
 * and 2.4.15, the event form returns entrants in a different order on
 * *consecutive fetches of an unchanged page* — Go map iteration, randomised on
 * purpose. So the guard fired on every finalize, and `champctl-finalize
 * --push` could not write at all.
 *
 * What the guard is for is someone being added, removed or edited between the
 * preview and the write — a sign-up approved in ACSM while a preview is open,
 * whom a full-form replace would silently delete (plan §5.3). That is a
 * question about the *set* of entrants, so this zips the parallel arrays back
 * into per-entrant records, sorts them and hashes that. A rename still trips
 * it; a reshuffle no longer does.
 *
 * Pit boxes are excluded on purpose — see `FINGERPRINT_EXCLUDED`. They are not
 * stable across a save on these builds, and BATL neither assigns nor promises
 * them, so treating a renumbering as tampering would block every write to
 * protect something nobody relies on.
 *
 * Still fails closed on what matters: the entrant count is hashed first, so an
 * added or removed entrant is caught even if every other field were excluded.
 *
 * The separators are escapes rather than literal bytes. They hash identically,
 * but a raw NUL in the source trips git's binary heuristic, and the whole file
 * then reads as `Bin 8991 bytes` in every diff — no review, no blame, no grep,
 * on the file holding the guard that stops a save deleting an entrant.
 */
export function entryListFingerprint(fields: readonly FormField[]): string {
  const counts = shape(fields)
  const entrants = counts["EntryList.Name"] ?? 0

  // Only keys that genuinely are one-per-entrant. Anything else cannot be
  // zipped into a record without guessing which entrant it belongs to.
  const keys = Object.keys(counts)
    .filter((k) => k.startsWith("EntryList.") && !FINGERPRINT_EXCLUDED.has(k))
    .filter((k) => counts[k] === entrants)
    .sort()

  const values = new Map(keys.map((k) => [k, getAll(fields, k)]))
  const records: string[] = []
  for (let i = 0; i < entrants; i++) {
    let record = ""
    for (const k of keys) record += `${k}\u0000${values.get(k)?.[i] ?? ""}\u0001`
    records.push(record)
  }
  records.sort()

  const h = createHash("sha256")
  h.update(`entrants\u0000${entrants}\u0001`)
  for (const r of records) h.update(r).update("\u0002")
  return h.digest("hex")
}

/** Finds the event edit form on the page, by action rather than position. */
export function findEventForm(html: string, pageUrl: string, championshipId: string): ParsedForm {
  const form = findFormByAction(html, eventSubmitPath(championshipId), { pageUrl })
  if (!form) {
    throw new FinalizeError(
      `The event page has no form posting to ${eventSubmitPath(championshipId)}. ` +
        `Either the session isn't logged in — ACSM serves the login page with a 200 — or this ` +
        `ACSM renders the event form differently and the recon capture needs redoing.`,
    )
  }
  return form
}

export async function planFinalize(
  session: AcsmSession,
  options: PlanOptions,
): Promise<FinalizePlan> {
  const { championship, championshipId, eventId, format, profile } = options

  const round = events(championship).findIndex((e) => e.ID === eventId) + 1
  if (round === 0) {
    throw new FinalizeError(
      `Championship ${championshipId} has no event ${eventId}. It may have been deleted, or the ` +
        `export is stale — reload before trying again.`,
    )
  }
  const ev = events(championship)[round - 1] as ChampionshipEvent

  const path = eventEditPath(championshipId, eventId)
  const html = await session.getText(path)
  const form = findEventForm(html, session.url(path), championshipId)

  const current = readFormat(ev)
  const changes = describeChanges(current, format)

  // What the form would actually send, compared against what it currently
  // holds. A field already at the target value is not a change.
  const wanted = formFieldsFor(format)
  const formChanges: FormFieldChange[] = []
  for (const [name, after] of Object.entries(wanted)) {
    const before = getOne(form.fields, name)
    if (before !== after) formChanges.push({ name, before, after })
  }

  const planned = planSchedule(ev, options)
  const schedule = planned?.schedule

  // gridmom runs against the championship as it *would* be. Checking the
  // current one would report yesterday's problems and miss the ones this
  // change is about to introduce.
  //
  // That has to include the *schedule*, not only the format. Applying the
  // format alone left `Scheduled` at its current value, so every schedule
  // check ran against the old time: moving a race onto a Saturday raised no
  // schedule.weekday, moving one into the past raised no schedule.past — and
  // moving one *out* of a stale problem still reported it, so applyFinalize
  // demanded an acknowledgement for a warning the change was fixing.
  const wouldBeEvent = applyFormat(ev, format)
  if (planned) wouldBeEvent.Scheduled = planned.scheduled
  const wouldBe = withEvent(championship, round - 1, wouldBeEvent)
  const gridmom = check(wouldBe, profile, {
    ...(options.pits ? { pits: options.pits } : {}),
    ...(options.now ? { now: options.now } : {}),
  })

  return {
    championshipId,
    eventId,
    round,
    current,
    desired: format,
    changes,
    formChanges,
    ...(schedule ? { schedule } : {}),
    gridmom,
    blocked: gridmom.counts.ERROR > 0,
    noop: formChanges.length === 0 && !schedule,
    entryListFingerprint: entryListFingerprint(form.fields),
    form,
  }
}

/**
 * The planned schedule change, plus the `Scheduled` value it implies.
 *
 * The ISO instant is returned alongside the form values because the caller
 * needs it for the would-be championship gridmom checks, and deriving it twice
 * would be two chances to derive it differently.
 */
function planSchedule(
  ev: ChampionshipEvent,
  options: PlanOptions,
): { schedule: NonNullable<FinalizePlan["schedule"]>; scheduled: string } | undefined {
  if (!options.qualiStart) return undefined

  const zone = options.profile.schedule.timezone
  const practice = practiceMinutesFor(ev, options.profile.schedule.practiceMinutes)
  // qualiStartFrom throws ScheduleError for a nonexistent or ambiguous local
  // time. Let it through rather than wrapping — the message is already
  // specific about which night the clocks move and what to do instead.
  const wanted = qualiStartFrom(options.qualiStart.date, options.qualiStart.time, zone)
  const existing = currentQualiStart(ev, zone, practice)

  // Same instant: nothing to send. Compared as instants rather than as
  // strings, so an event stored with a different but equivalent offset
  // doesn't read as a change.
  if (existing && +existing === +wanted) return undefined

  const scheduled = scheduledFromQuali(wanted, practice)
  return {
    schedule: {
      ...(existing ? { from: existing.toFormat("yyyy-MM-dd HH:mm ZZZZ") } : { from: undefined }),
      to: wanted.toFormat("yyyy-MM-dd HH:mm ZZZZ"),
      // Recurrence is filled in at apply time from the schedule form itself,
      // so an existing repeat isn't cancelled by echoing a blank.
      values: scheduleFormValues(scheduled, zone, ""),
    },
    // What ACSM will hold afterwards, in the same shape an export uses.
    scheduled: scheduled.toISO() ?? "",
  }
}

/** Replaces one event, returning a new championship. Never mutates. */
export function withEvent(c: Championship, index: number, ev: ChampionshipEvent): Championship {
  const list = [...events(c)]
  list[index] = ev
  return { ...c, Events: list }
}

export function describeChanges(before: RaceFormat, after: RaceFormat): Change[] {
  if (sameFormat(before, after)) return []
  const out: Change[] = []
  const add = (label: string, b: string, a: string): void => {
    if (b !== a) out.push({ label, before: b, after: a })
  }

  add("Race length", describeLength(before.length), describeLength(after.length))
  add(
    "Reversed grid",
    describeReversedGrid(before.reversedGridPositions),
    describeReversedGrid(after.reversedGridPositions),
  )
  add("Mandatory pit stop", yesNo(before.mandatoryPit), yesNo(after.mandatoryPit))
  add("Extra lap", yesNo(before.extraLap), yesNo(after.extraLap))
  return out
}

function describeReversedGrid(n: number): string {
  return n === 0 ? "off (single race)" : `top ${n} reversed`
}

function yesNo(b: boolean): string {
  return b ? "yes" : "no"
}
