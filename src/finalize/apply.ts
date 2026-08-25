/**
 * Applying a finalize plan. This is the part that writes.
 *
 * The guard here is the reason this module is separate from `plan.ts`. Plan
 * §5.3, and worth quoting because it is the sharpest edge in the whole tool:
 *
 * > The event edit form is a full-list replace, so an approval landing between
 * > form fetch and form POST will be silently reverted. Someone approves a
 * > driver in ACSM while the tool has an edit screen open, the tool saves, and
 * > the new entrant vanishes with no error anywhere. **This is the most likely
 * > way champctl could destroy data while appearing to work.**
 *
 * So the entry list is fingerprinted when the screen opens, and the form is
 * re-fetched and re-fingerprinted immediately before the POST. Different means
 * refuse and reload — never merge, never "probably fine". The window doesn't
 * close entirely (ACSM has no conditional write), but it shrinks from "however
 * long the screen was open" to "one round trip", and the failure becomes loud.
 *
 * The write itself is a round-trip: the re-fetched form's own fields are
 * posted back with only the planned values replaced. Nothing is assembled from
 * the export, because `EntryList.*` keys are parallel positional arrays and
 * rebuilding them is how an entry list gets scrambled (docs §1).
 */

import { findFormByAction, setOne, type ParsedForm } from "../acsm/form.js"
import { AcsmWriteError, isRedirectStatus, type AcsmSession } from "../acsm/session.js"
import { eventEditPath, eventSchedulePath, eventSubmitPath } from "../acsm/write.js"
import { formFieldsFor } from "./format.js"
import { entryListFingerprint, findEventForm, FinalizeError, type FinalizePlan } from "./plan.js"
import { SCHEDULE_FIELD } from "./schedule.js"

/**
 * The entry list changed between the preview and the write.
 *
 * Its own type because the caller has to do something specific about it —
 * reload the screen and show the new list — rather than report a generic
 * failure. Nothing was written when this is thrown.
 */
export class EntryListChangedError extends FinalizeError {
  constructor(
    readonly championshipId: string,
    readonly eventId: string,
  ) {
    super(
      `The entry list for this event changed while the preview was open, so the save was ` +
        `refused and nothing was written. ACSM's event form replaces the whole entry list, ` +
        `so saving now would silently delete whoever was added — most likely a sign-up ` +
        `approved in ACSM in the last few moments. Reload the event and redo the change.`,
    )
    this.name = "EntryListChangedError"
  }
}

export interface ApplyOptions {
  /**
   * Proceed despite gridmom WARN findings. Has no effect on ERROR, which
   * nothing overrides — a plan that is `blocked` cannot be applied.
   */
  acknowledgeWarnings?: boolean
}

export interface ApplyResult {
  /** True when the event form was posted. */
  eventSaved: boolean
  /** True when the schedule form was posted. A separate request (plan §5.2). */
  scheduleSaved: boolean
  /** What was sent, for an audit line. */
  formChanges: FinalizePlan["formChanges"]
}

export async function applyFinalize(
  session: AcsmSession,
  plan: FinalizePlan,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  // Before the gridmom gates, not after. A plan with nothing to write cannot
  // make anything worse, so demanding an acknowledgement for pre-existing
  // warnings would be asking someone to approve a change that isn't happening.
  if (plan.noop) {
    return { eventSaved: false, scheduleSaved: false, formChanges: [] }
  }

  if (plan.blocked) {
    const errors = plan.gridmom.findings.filter((f) => f.severity === "ERROR")
    throw new FinalizeError(
      `Refusing to save: ${errors.length === 1 ? "this would" : "these would"} produce a broken ` +
        `or unfair race. ${errors.map((f) => f.message).join(" ")}`,
    )
  }

  if (plan.gridmom.counts.WARN > 0 && options.acknowledgeWarnings !== true) {
    const warns = plan.gridmom.findings.filter((f) => f.severity === "WARN")
    throw new FinalizeError(
      `Not saving without an acknowledgement: ${warns.map((f) => f.message).join(" ")}`,
    )
  }

  // Re-fetch immediately before writing. See the module comment.
  const path = eventEditPath(plan.championshipId, plan.eventId)
  const fresh = findEventForm(await session.getText(path), session.url(path), plan.championshipId)

  if (entryListFingerprint(fresh.fields) !== plan.entryListFingerprint) {
    throw new EntryListChangedError(plan.championshipId, plan.eventId)
  }

  let eventSaved = false
  if (plan.formChanges.length > 0) {
    // Post the *fresh* form's fields, not the planned one's. They are
    // equivalent for the entry list — that is what the fingerprint just
    // established — but anything else ACSM changed in the meantime should be
    // echoed back as it now stands rather than reverted to what we first read.
    const fields = [...fresh.fields]

    // The two keys that say *which* save this is (plan §5.2). `Editing` is
    // rendered by the form, so this only restates it; `action` is not — it is
    // carried by the submit button, and `parseForm` drops buttons on purpose.
    // So a payload built purely from the parsed form is missing it, which is
    // how a browser and champctl come to send different things. Both live tests
    // that drive this endpoint set them explicitly for the same reason.
    setOne(fields, "Editing", plan.eventId)
    setOne(fields, "action", "saveChampionship")

    for (const [name, value] of Object.entries(formFieldsFor(plan.desired))) {
      // setOne refuses a repeated key, so a build that renders one of these
      // more than once fails loudly instead of scrambling a positional array.
      setOne(fields, name, value)
    }

    // postForm re-checks the EntryList.* arity before sending.
    const res = await session.postForm(eventSubmitPath(plan.championshipId), fields)
    assertAccepted(res, "event", eventSubmitPath(plan.championshipId))
    eventSaved = true
  }

  let scheduleSaved = false
  if (plan.schedule) {
    await saveSchedule(session, plan)
    scheduleSaved = true
  }

  return { eventSaved, scheduleSaved, formChanges: plan.formChanges }
}

/**
 * The second request. The event submit form does not carry `Scheduled`, so
 * changing quali time is its own POST (plan §5.2).
 *
 * Ordered after the event save deliberately: if the event save fails, the
 * schedule is left alone and the event is unchanged, which is a coherent
 * state. The reverse order can leave a race rescheduled to a time whose format
 * never got applied.
 */
async function saveSchedule(session: AcsmSession, plan: FinalizePlan): Promise<void> {
  const schedule = plan.schedule
  if (!schedule) return

  const path = eventSchedulePath(plan.championshipId, plan.eventId)
  const html = await session.getText(path)
  const form = findScheduleForm(html, session.url(path), path)

  const fields = [...form.fields]
  for (const [name, value] of Object.entries(schedule.values)) {
    // Recurrence is the exception: keep whatever the form already holds.
    // Blanking it would cancel a repeat somebody set up in ACSM, and champctl
    // does not model recurrence yet so it has no business changing it.
    if (name === SCHEDULE_FIELD.recurrence) continue
    setOne(fields, name, value)
  }

  const res = await session.postForm(path, fields)
  assertAccepted(res, "schedule", path)
}

/**
 * The schedule form, by action.
 *
 * Its own error wording rather than `findEventForm`'s, because by the time
 * this can fail the event save has already gone through — the person needs to
 * know the format landed and only the time didn't.
 */
function findScheduleForm(html: string, pageUrl: string, action: string): ParsedForm {
  const form = findFormByAction(html, action, { pageUrl })
  if (!form) {
    throw new FinalizeError(
      `The schedule page has no form posting to ${action}. The event save already went through, ` +
        `so the format is applied and only the quali time is unchanged. Set it in ACSM, or ` +
        `reload and try again.`,
    )
  }
  return form
}

/**
 * ACSM reports a rejected form by re-rendering the page with a flash message
 * and a 200, so a redirect is the only success signal there is.
 */
function assertAccepted(res: Response, what: string, path: string): void {
  if (isRedirectStatus(res.status)) return
  throw new AcsmWriteError(
    `ACSM didn't accept the ${what} save (HTTP ${res.status}, no redirect). It reports form ` +
      `errors by re-rendering the page rather than in the response, so check the event in ACSM ` +
      `before retrying.`,
    res.status,
    path,
  )
}
