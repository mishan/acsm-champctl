/**
 * Applying a reorder. This is the part that writes.
 *
 * One event-form POST per round that moves, each with the same entry-list guard
 * the weekly finalize has — `saveEventForm` is shared rather than reimplemented,
 * so the guard is one piece of code and cannot drift between the two callers.
 *
 * **A reorder is several writes and ACSM has no transaction.** That is the fact
 * this module is built around. Round 2's new track lands, round 4's POST fails,
 * and the championship is left with a calendar that is neither the old one nor
 * the new one — two rounds at Monza and none at Spa. Nothing can prevent that;
 * what this can do is refuse to be vague about it. `PartialReorderError` names
 * every round that was written and every round that was not, because "the
 * reorder failed" sends someone to look at the wrong end of a season.
 *
 * The writes go in slot order, which is not an accident either: a person
 * checking the damage reads the championship page top to bottom, and a prefix
 * of the new calendar followed by a suffix of the old one is far easier to
 * reason about than a scatter.
 */

import { saveEventForm } from "../finalize/apply.js"
import { formFieldsFor } from "../finalize/format.js"
import type { AcsmSession } from "../acsm/session.js"
import { ReorderError, type ReorderPlan, type SlotChange } from "./plan.js"

/**
 * Some rounds moved and some didn't, and the championship is mid-permutation.
 *
 * Its own type because the remedy is specific and is not "try again": the
 * rounds listed as written are already at their new tracks, so re-running the
 * same reorder would move them a second time. Reload and reorder from where it
 * now is.
 */
export class PartialReorderError extends ReorderError {
  constructor(
    readonly written: readonly number[],
    readonly pending: readonly number[],
    override readonly cause: unknown,
  ) {
    const why = cause instanceof Error ? cause.message : String(cause)
    const list = (rounds: readonly number[]): string => rounds.join(", ")
    super(
      `This reorder stopped part way through and the calendar is now neither the old one nor the ` +
        `new one. ${written.length === 1 ? "Round" : "Rounds"} ${list(written)} ` +
        `${written.length === 1 ? "was" : "were"} moved; ${pending.length === 1 ? "round" : "rounds"} ` +
        `${list(pending)} still ${pending.length === 1 ? "holds" : "hold"} what ` +
        `${pending.length === 1 ? "it" : "they"} held before. The reason was: ${why}. Do not re-run ` +
        `this reorder — the rounds already moved would move again. Reload the championship and ` +
        `reorder it from where it now is.`,
    )
    this.name = "PartialReorderError"
  }
}

export interface ApplyReorderOptions {
  /**
   * Proceed despite gridmom WARN findings. No effect on ERROR, which nothing
   * overrides — a plan that is `blocked` cannot be applied.
   */
  acknowledgeWarnings?: boolean
}

export interface ReorderResult {
  /** The rounds written, in the order they were written. */
  rounds: number[]
}

export async function applyReorder(
  session: AcsmSession,
  plan: ReorderPlan,
  options: ApplyReorderOptions = {},
): Promise<ReorderResult> {
  // Before the gridmom gates, same reasoning as finalize: a plan with nothing
  // to write cannot make anything worse, so asking someone to acknowledge
  // pre-existing warnings would be asking them to approve a change that isn't
  // happening.
  if (plan.noop) return { rounds: [] }

  if (plan.blocked) {
    const errors = plan.gridmom.findings.filter((f) => f.severity === "ERROR")
    throw new ReorderError(
      `Refusing to reorder: ${errors.length === 1 ? "this would" : "these would"} produce a ` +
        `broken or unfair season. ${errors.map((f) => f.message).join(" ")}`,
    )
  }

  if (plan.gridmom.counts.WARN > 0 && options.acknowledgeWarnings !== true) {
    const warns = plan.gridmom.findings.filter((f) => f.severity === "WARN")
    throw new ReorderError(
      `Not reordering without an acknowledgement: ${warns.map((f) => f.message).join(" ")}`,
    )
  }

  const written: number[] = []
  for (const move of plan.moves) {
    try {
      await saveEventForm(session, {
        championshipId: plan.championshipId,
        eventId: move.eventId,
        entryListFingerprint: move.entryListFingerprint,
        fields: fieldsFor(move),
      })
    } catch (e) {
      // The first write is the one case where nothing has landed, so the
      // underlying failure is the whole story and wrapping it would bury the
      // reason — a refused entry list, an expired session — under a paragraph
      // about damage that did not happen.
      if (written.length === 0) throw e
      throw new PartialReorderError(
        written,
        plan.moves.slice(written.length).map((m) => m.round),
        e,
      )
    }
    written.push(move.round)
  }

  return { rounds: written }
}

/**
 * The fields one moved round posts.
 *
 * Every field the target format and venue imply, not only the ones `formChanges`
 * listed as different. Those differences were measured against the form as it
 * was at *plan* time, and `saveEventForm` round-trips the form as it is at
 * *apply* time — so a field that matched when the preview was built and has
 * been edited in ACSM since would be left at its new value and quietly excluded
 * from the move. `applyFinalize` posts the whole set for the same reason.
 *
 * The venue goes last: `findEventForm` corrects `TrackLayout` to the layout the
 * event currently *has*, and a move is the one write that wants a different
 * answer.
 */
function fieldsFor(move: SlotChange): Record<string, string> {
  return {
    ...formFieldsFor(move.format.to),
    Track: move.venue.to.track,
    TrackLayout: move.venue.to.layout,
  }
}
