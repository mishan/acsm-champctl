/**
 * Applying a livery plan. This is the part that writes.
 *
 * Three steps, in this order, and the order is the point:
 *
 *   1. upload each skin to `POST /car/{model}/skin`
 *   2. one save of the championship form, setting `EntryList.Skin`
 *   3. restart the looping practice server for the round
 *
 * Uploads first because they are additive and independently harmless — a skin
 * folder nobody references is disk space, where an entry list pointing at a
 * folder that isn't there is a driver who can't join. If step 2 fails, the
 * server has some unused skins and the championship is untouched, which is a
 * state somebody can walk away from.
 *
 * Only the championship form is written. The per-event entry lists are left
 * exactly as they are — see `plan.ts` for why the class list is the one that
 * matters, and `unreachableRounds` for how a plan says so when it isn't.
 */

import {
  CHAMPIONSHIP_REQUIRED_ENTRY_LIST_FIELDS,
  type ChampionshipForm,
  currentNames,
  entrantRowIndex,
  findChampionshipForm,
  setEntrantSkin,
} from "../acsm/championship-form.js"
import { getAll, setOne } from "../acsm/form.js"
import {
  CHAMPIONSHIP_SUBMIT_PATH,
  carSkinUploadPath,
  championshipEditPath,
  championshipPath,
  eventPracticePath,
} from "../acsm/paths.js"
import { AcsmWriteError, isRedirectStatus, type AcsmSession } from "../acsm/session.js"
import type { Livery } from "./pack.js"
import type { LiveryPlan } from "./plan.js"

export class LiveryApplyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LiveryApplyError"
  }
}

/**
 * The entry list moved between the preview and the write.
 *
 * Its own type because the caller has to do something specific — look again —
 * rather than report a generic failure. Nothing was written to the championship
 * when this is thrown, though any skins already uploaded are still there.
 */
export class RosterChangedError extends LiveryApplyError {
  constructor(readonly detail: string) {
    super(
      `The championship's entry list changed while the preview was open, so the save was refused ` +
        `and no livery was assigned. ${detail} Re-run to see the list as it is now. ` +
        `(Any skins already uploaded are on the server and are harmless — the upload only adds files.)`,
    )
    this.name = "RosterChangedError"
  }
}

/**
 * The championship saved and the practice restart didn't.
 *
 * Worth its own type for the same reason `PartialWriteError` is in the finalize
 * path: the remedy is not "run it again". The liveries are assigned; only the
 * running practice session is stale, and re-running would re-post a whole
 * championship to fix something a click in ACSM fixes.
 */
export class PracticeRestartError extends LiveryApplyError {
  constructor(
    round: number,
    override readonly cause: unknown,
  ) {
    const why = cause instanceof Error ? cause.message : String(cause)
    super(
      `The liveries are uploaded and assigned, and only the practice restart failed: ${why}. ` +
        `The new liveries are in the championship and will be picked up the next time round ` +
        `${round}'s practice starts — restart it in ACSM rather than re-running this.`,
    )
    this.name = "PracticeRestartError"
  }
}

export interface ApplyLiveriesOptions {
  /**
   * Round whose looping practice server to restart, 1-based. Omit to skip it.
   *
   * `GET /championship/{id}/event/{eventID}/practice` rebuilds `entry_list.ini`
   * from the stored championship with `LoopMode = 1`, which is what makes a
   * reassigned livery take effect. `/process/restart` does not — it replays the
   * config captured when the session started.
   */
  restartPracticeRound?: number
  /** Event ids by round, 1-based, from the export. Needed for the restart. */
  eventIds?: readonly string[]
}

export interface ApplyLiveriesResult {
  uploaded: { driverName: string; carModel: string; skinFolder: string; files: number }[]
  /** True when the championship form was posted. */
  championshipSaved: boolean
  /** True when the practice restart was requested. */
  practiceRestarted: boolean
}

export async function applyLiveries(
  session: AcsmSession,
  plan: LiveryPlan,
  options: ApplyLiveriesOptions = {},
): Promise<ApplyLiveriesResult> {
  const result: ApplyLiveriesResult = {
    uploaded: [],
    championshipSaved: false,
    practiceRestarted: false,
  }

  if (plan.noop) return result

  for (const assignment of plan.assignments) {
    await uploadSkin(session, assignment.carModel, assignment.livery)
    result.uploaded.push({
      driverName: assignment.driverName,
      carModel: assignment.carModel,
      skinFolder: assignment.skinFolder,
      files: assignment.livery.files.length,
    })
  }

  await saveChampionshipSkins(session, plan)
  result.championshipSaved = true

  const round = options.restartPracticeRound
  if (round !== undefined) {
    const eventId = options.eventIds?.[round - 1]
    if (!eventId) {
      throw new PracticeRestartError(
        round,
        new Error(`this championship has no round ${round} to restart`),
      )
    }
    try {
      await restartPractice(session, plan.championshipId, eventId)
    } catch (e) {
      throw new PracticeRestartError(round, e)
    }
    result.practiceRestarted = true
  }

  return result
}

/**
 * `POST /car/{car}/skin`, one request per skin.
 *
 * ACSM walks every file part regardless of field name and writes each to
 * `content/cars/{car}/skins/<dir(filename)>/<base(filename)>` — so the skin
 * folder is a *path prefix on the part's filename*, not a field. Those
 * filenames are built here, and `pack.ts` is what guarantees neither component
 * can climb out of the skins directory.
 *
 * One request per skin rather than one for the lot, so a failure names the
 * driver it failed for. It also keeps each request near ACSM's
 * `ParseMultipartForm(32 << 20)`, where a combined upload of thirty 4K liveries
 * would be several hundred megabytes in one POST.
 */
async function uploadSkin(session: AcsmSession, carModel: string, livery: Livery): Promise<void> {
  const path = carSkinUploadPath(carModel)
  const parts = livery.files.map((f) => ({
    // The field name is arbitrary — ACSM iterates r.MultipartForm.File and
    // ignores the keys. `files` is what the page's own uploader calls it.
    field: "files",
    fileName: `${livery.skinFolder}/${f.name}`,
    bytes: f.bytes,
  }))

  const res = await session.postFiles(path, parts, {
    // The handler ends with `http.Redirect(w, r, r.Referer(), 302)`. With no
    // Referer that is a redirect to the empty string, which is a 302 carrying
    // nothing — survivable, but it makes a successful upload indistinguishable
    // from a confused one in the logs.
    referer: session.url(`/car/${encodeURIComponent(carModel)}`),
  })

  if (!isRedirectStatus(res.status)) {
    throw new LiveryApplyError(
      `ACSM didn't accept ${livery.driverName}'s livery for ${carModel} (HTTP ${res.status}, no ` +
        `redirect). It answers a successful skin upload with a 302 and a failure with a 500, so ` +
        `anything else is something other than Server Manager answering. Nothing was assigned.`,
    )
  }
}

/**
 * The one write to the championship, with the guard that stops it eating the
 * entry list.
 *
 * The form is fetched here rather than reused from the plan, and the entrant
 * names are compared against what the plan matched. ACSM's championship save is
 * a whole-championship replace: a sign-up approved while the preview was open
 * would be silently dropped by posting a form read before it landed. That is
 * the same hazard `saveEventForm` guards, one form up.
 */
async function saveChampionshipSkins(session: AcsmSession, plan: LiveryPlan): Promise<void> {
  const path = championshipEditPath(plan.championshipId)
  const form = findChampionshipForm(await session.getText(path), session.url(path))

  const fields = [...form.fields]
  for (const assignment of plan.assignments) {
    const row = entrantRowIndex(form, assignment.classIndex, assignment.entrantIndex)
    assertRowIsWhoWeThink(form, row, assignment.driverName)
    setEntrantSkin(fields, row, assignment.skinFolder)
  }

  // Which save this is. `Editing` is rendered by the form so this only restates
  // it; the ACSM UI carries `action` on the submit button, and `parseForm` drops
  // buttons on purpose, so a payload built purely from the parsed form lacks it.
  setOne(fields, "action", "saveChampionship")

  const res = await session.postForm(CHAMPIONSHIP_SUBMIT_PATH, fields, {
    // The event form's list would refuse this outright: the championship form
    // genuinely renders no EntryList.EntrantID. See the constant's comment.
    requiredEntryListFields: CHAMPIONSHIP_REQUIRED_ENTRY_LIST_FIELDS,
  })

  if (!isRedirectStatus(res.status)) {
    throw new AcsmWriteError(
      `ACSM didn't accept the championship save (HTTP ${res.status}, no redirect). It reports ` +
        `form errors by re-rendering the page rather than in the response, so check the entry ` +
        `list at ${championshipPath(plan.championshipId)} before retrying — the skins are ` +
        `uploaded either way.`,
      res.status,
      CHAMPIONSHIP_SUBMIT_PATH,
    )
  }
}

/**
 * The row about to be written is still the driver the plan matched.
 *
 * The positional-array failure mode has no error and no symptom until race
 * night: every `EntryList.*` key is read by index, so a row that moved gives one
 * driver another's livery. Comparing the name at the index costs nothing and
 * turns that into a refusal.
 */
function assertRowIsWhoWeThink(form: ChampionshipForm, row: number, expected: string): void {
  const names = currentNames(form)
  const actual = names[row]
  if (actual === undefined) {
    throw new RosterChangedError(
      `champctl expected ${expected} at position ${row}, and the form now has ${names.length} rows.`,
    )
  }
  if (actual.trim() !== expected) {
    throw new RosterChangedError(
      `champctl expected ${expected} at position ${row} and the form has "${actual.trim()}" there.`,
    )
  }
}

/**
 * Restart the looping practice server for one round.
 *
 * A GET, which is ACSM's own routing rather than a shortcut. It rebuilds the
 * entry list from the stored championship — which is where the skins now are —
 * and starts with `LoopMode = 1`.
 */
async function restartPractice(
  session: AcsmSession,
  championshipId: string,
  eventId: string,
): Promise<void> {
  const path = eventPracticePath(championshipId, eventId)
  const res = await session.getRaw(path, { referer: championshipPath(championshipId) })
  // ACSM redirects to the championship page on success and re-renders with an
  // error flash on failure, so as everywhere else the redirect is the signal.
  if (!isRedirectStatus(res.status) && !res.ok) {
    throw new AcsmWriteError(`${res.status} ${res.statusText} from ${path}`, res.status, path)
  }
}

/** The fields a save would change, for a preview that shows the exact payload. */
export function skinFieldChanges(
  form: ChampionshipForm,
  plan: LiveryPlan,
): { row: number; name: string; from: string; to: string }[] {
  const skins = getAll(form.fields, "EntryList.Skin")
  const names = currentNames(form)
  return plan.assignments.map((a) => {
    const row = entrantRowIndex(form, a.classIndex, a.entrantIndex)
    return {
      row,
      name: names[row] ?? "",
      from: skins[row] ?? "",
      to: a.skinFolder,
    }
  })
}
