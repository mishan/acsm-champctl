/**
 * Reordering a championship's rounds, without re-importing it.
 *
 * ACSM has no endpoint that moves an event within a championship. The order is
 * the order of the `Events` array in the export, and the only write that can
 * rewrite that array is `POST /championship/import` — which overwrites the
 * championship at that ID, and is refused outright once anything has been raced
 * (plan §3.2). Losing three weeks of results to a convenience feature is the
 * worst outcome this tool can produce, so that route is not on the table.
 *
 * So champctl reorders the calendar by moving what a round *is* between the
 * slots, rather than moving the slots. Round 2 stays event `abc` with its own
 * entry list, its own results and its own place in the array; what changes is
 * the track it runs at and the format it runs. Every write is the ordinary
 * event-form round-trip the weekly finalize already uses, with the same
 * entry-list guard on each one.
 *
 * **What travels and what stays is the whole design, and it is a choice.**
 *
 * - *Travels with the round:* the track, the layout, and the race format. These
 *   are what makes a round "the Monza round" — and a lap count voted for Monza
 *   is about Monza, not about the third Wednesday in September.
 * - *Stays with the slot:* the date, the quali time, the round's name, and the
 *   entry list. A league reordering its calendar is saying "Monza moves to
 *   week 1", and week 1 keeps being week 1. Moving the dates too would leave
 *   the round numbers and the calendar disagreeing, which is the one thing a
 *   season schedule must not do.
 *
 * The name staying is the same argument as the date, and it also happens to be
 * the safe answer: champctl has never captured a field for the event name on
 * the edit form, so writing one would be a guess on the write path.
 *
 * Nothing here writes. `apply.ts` does that.
 */

import { layoutsFrom } from "../acsm/content.js"
import { getOne } from "../acsm/form.js"
import type { AcsmSession } from "../acsm/session.js"
import type { Championship, ChampionshipEvent } from "../acsm/types.js"
import { eventEditPath } from "../acsm/write.js"
import { eventHasStarted, events } from "../acsm/view.js"
import { check, type CheckReport } from "../gridmom/index.js"
import type { PitTable } from "../pits/table.js"
import type { LeagueProfile } from "../profile/types.js"
import {
  applyFormat,
  formFieldsFor,
  readFormat,
  type Change,
  type FormFieldChange,
  type RaceFormat,
} from "../finalize/format.js"
import {
  describeChanges,
  entryListFingerprint,
  findEventForm,
  type Venue,
} from "../finalize/plan.js"

export class ReorderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ReorderError"
  }
}

/** One slot whose contents change, and everything the write of it needs. */
export interface SlotChange {
  /** The slot being written, 1-based as a league counts rounds. */
  round: number
  /** The event that *is* that slot. It does not move; its contents change. */
  eventId: string
  /** Which round's track and format land here, 1-based. */
  cameFrom: number
  venue: { from: Venue; to: Venue }
  format: { from: RaceFormat; to: RaceFormat }
  /** The diff a person reads. */
  changes: Change[]
  /** Field by field, so the preview cannot lie about what gets posted. */
  formChanges: FormFieldChange[]
  /** The entry list of *this* slot, as rendered at plan time. */
  entryListFingerprint: string
}

export interface ReorderPlan {
  championshipId: string
  /**
   * The new calendar, as 1-based source rounds.
   *
   * `order[i]` is the round whose track and format end up in slot `i + 1`. So
   * `[3, 1, 2]` reads "round 3 comes first, then round 1, then round 2".
   */
  order: number[]
  /** Only the slots that actually change. In the order they will be written. */
  moves: SlotChange[]
  /** gridmom against the championship as it *would* be, once, for the lot. */
  gridmom: CheckReport
  blocked: boolean
  /** The order asked for is the order it is already in. */
  noop: boolean
}

export interface ReorderOptions {
  championship: Championship
  championshipId: string
  /** The new order, as 1-based source rounds. Must be a permutation of them. */
  order: readonly number[]
  profile: LeagueProfile
  pits?: PitTable
  now?: Date
}

/** Where a round runs, off the export. */
export function venueOf(ev: ChampionshipEvent): Venue {
  return {
    track: (ev.RaceSetup?.Track ?? "").trim(),
    layout: (ev.RaceSetup?.TrackLayout ?? "").trim(),
  }
}

/** "spa/gp", or just "spa" for a track with one layout. */
export function venueLabel(v: Venue): string {
  return v.layout ? `${v.track}/${v.layout}` : v.track || "no track set"
}

/**
 * Checks `order` really is a rearrangement of rounds 1..n.
 *
 * Fails closed on anything else, because a "reorder" that dropped round 4 and
 * ran round 2 twice would write round 2's track over round 4's slot and leave
 * the season a round short with no error anywhere. The array is arriving from
 * an HTTP body, so none of its shape can be assumed.
 */
export function assertPermutation(order: readonly number[], n: number): void {
  if (order.length !== n) {
    throw new ReorderError(
      `This championship has ${n} ${n === 1 ? "round" : "rounds"} and the new order lists ` +
        `${order.length}. A reorder rearranges the rounds that exist; it cannot add or remove one.`,
    )
  }
  const seen = new Set<number>()
  for (const r of order) {
    if (!Number.isInteger(r) || r < 1 || r > n) {
      throw new ReorderError(`${r} isn't one of this championship's rounds, which are 1 to ${n}.`)
    }
    if (seen.has(r)) {
      throw new ReorderError(
        `Round ${r} appears twice in the new order. Every round has to land exactly once, or ` +
          `one of them would be overwritten by another and lost.`,
      )
    }
    seen.add(r)
  }
}

/** The slots whose contents change, as 0-based indices into `Events`. */
export function movedSlots(order: readonly number[]): number[] {
  const out: number[] = []
  for (let i = 0; i < order.length; i++) if (order[i] !== i + 1) out.push(i)
  return out
}

/**
 * The championship as it would be, with the venues and formats permuted.
 *
 * Pure, and the thing gridmom is run against. Everything else about each event
 * — its ID, its schedule, its name, its entry list, its results — stays exactly
 * where it was, which is what makes this a rearrangement of the calendar rather
 * than a rewrite of the championship.
 */
export function reordered(c: Championship, order: readonly number[]): Championship {
  const evs = events(c)
  const next = order.map((source, i) => {
    const slot = evs[i]
    const from = evs[source - 1]
    if (!slot || !from) return slot as ChampionshipEvent
    const moved = applyFormat(slot, readFormat(from))
    const venue = venueOf(from)
    moved.RaceSetup = {
      ...(moved.RaceSetup ?? {}),
      Track: venue.track,
      TrackLayout: venue.layout,
    }
    return moved
  })
  return { ...c, Events: next }
}

/**
 * Refuses to move a round that has been raced.
 *
 * A finished event carries its results inline, and the slot's identity is what
 * those results belong to. Moving a raced round's track would leave a set of
 * lap times attached to a circuit nobody drove, and there is no undo for that.
 * The refusal names the rounds so the answer — reorder the ones still to come —
 * is obvious from the message.
 */
export function assertNothingRaced(
  evs: readonly ChampionshipEvent[],
  moved: readonly number[],
): void {
  const raced = moved
    .filter((i) => {
      const ev = evs[i]
      return ev ? eventHasStarted(ev) : false
    })
    .map((i) => i + 1)
  if (raced.length === 0) return
  throw new ReorderError(
    `${raced.length === 1 ? `Round ${raced[0]} has` : `Rounds ${raced.join(", ")} have`} already ` +
      `been raced, and this order would move ${raced.length === 1 ? "it" : "them"}. Results belong ` +
      `to the track they were set at, so champctl won't move a round that has run. Reorder the ` +
      `rounds still to come.`,
  )
}

export async function planReorder(
  session: AcsmSession,
  options: ReorderOptions,
): Promise<ReorderPlan> {
  const { championship, championshipId, profile } = options
  const evs = events(championship)
  const order = [...options.order]

  assertPermutation(order, evs.length)

  const moved = movedSlots(order)
  if (moved.length === 0) {
    return {
      championshipId,
      order,
      moves: [],
      gridmom: check(championship, profile, {
        ...(options.pits ? { pits: options.pits } : {}),
        ...(options.now ? { now: options.now } : {}),
      }),
      blocked: false,
      noop: true,
    }
  }

  // Before anything is fetched. A refusal that costs a round trip per round is
  // a refusal someone waits for.
  //
  // Checking the destinations covers the sources too: `order` is a permutation,
  // so the slots it does not fix are closed under it — a round moving out of
  // slot 3 is a round moving into some other slot that also changed.
  assertNothingRaced(evs, moved)

  const wouldBe = reordered(championship, order)

  const moves: SlotChange[] = []
  /** Read off whichever event page we happen to fetch; they all carry it. */
  let layouts: Record<string, string[]> | undefined

  for (const i of moved) {
    const slot = evs[i] as ChampionshipEvent
    const source = evs[(order[i] ?? 0) - 1] as ChampionshipEvent
    const eventId = (slot.ID ?? "").trim()
    if (!eventId) {
      throw new ReorderError(
        `Round ${i + 1} has no event id in the export, so champctl has no form to post to it. ` +
          `The export may be from a build champctl hasn't seen; reload and look at the round in ACSM.`,
      )
    }

    const path = eventEditPath(championshipId, eventId)
    const html = await session.getText(path)
    // Refuses a round whose own track isn't installed, and corrects the layout
    // select that would otherwise post a layout belonging to another track.
    const form = findEventForm(html, session.url(path), championshipId)
    layouts ??= layoutsFrom(html)

    const venue = { from: venueOf(slot), to: venueOf(source) }
    const format = { from: readFormat(slot), to: readFormat(source) }

    const changes = describeChanges(format.from, format.to)
    if (venue.from.track !== venue.to.track || venue.from.layout !== venue.to.layout) {
      changes.unshift({
        label: "Track",
        before: venueLabel(venue.from),
        after: venueLabel(venue.to),
      })
    }

    // Compared against the form, except the two venue keys — which are listed
    // whatever the form says, for the reason `planFinalize` gives: on a round
    // whose stored layout belongs to another track the form already reads as
    // the corrected `""`, and a repair to `""` would look like a change to
    // nothing and leave the round broken.
    const formChanges: FormFieldChange[] = []
    const wanted = {
      ...formFieldsFor(format.to),
      Track: venue.to.track,
      TrackLayout: venue.to.layout,
    }
    for (const [name, after] of Object.entries(wanted)) {
      const before = getOne(form.fields, name)
      if (name === "Track" || name === "TrackLayout" || before !== after) {
        formChanges.push({ name, before, after })
      }
    }

    moves.push({
      round: i + 1,
      eventId,
      cameFrom: order[i] ?? 0,
      venue,
      format,
      changes,
      formChanges,
      entryListFingerprint: entryListFingerprint(form.fields),
    })
  }

  // Once, against the fully rearranged championship. Per-round checks would
  // report a calendar halfway through the permutation — two rounds at the same
  // circuit, because one has moved and the other hasn't — which is a warning
  // about a state that never exists.
  const gridmom = check(wouldBe, profile, {
    ...(options.pits ? { pits: options.pits } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(layouts === undefined ? {} : { layouts }),
  })

  return {
    championshipId,
    order,
    moves,
    gridmom,
    blocked: gridmom.counts.ERROR > 0,
    noop: false,
  }
}
