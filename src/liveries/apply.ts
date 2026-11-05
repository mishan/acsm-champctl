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
  type ChampionshipForm,
  currentNames,
  findEntrantRow,
  setEntrantSkin,
} from "../acsm/championship-form.js"
import {
  ChampionshipChangedError,
  type ChampionshipEdit,
  checkChampionshipSave,
} from "../acsm/championship-save.js"
import { getAll } from "../acsm/form.js"
import { carSkinUploadPath, championshipPath, eventPracticePath } from "../acsm/paths.js"
import { AcsmWriteError, isRedirectStatus, type AcsmSession } from "../acsm/session.js"

import { ACSM_SKIN_FILES, MAX_UPLOAD_REQUEST_BYTES, type Livery } from "./pack.js"
import type { LiveryPlan } from "./plan.js"
import type { LiverySource, RecordResult, LiveryRecorder } from "./store.js"

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
/**
 * The liveries are on the server and champctl failed to write them down.
 *
 * Its own type, and its own sentence, because the obvious message is wrong in
 * both directions. "Failed to apply liveries" would send an operator to
 * re-upload something that is already applied; swallowing it would leave a
 * carset quietly missing cars that are on the grid, which nobody discovers
 * until a driver asks why they can't see one.
 */
export class LiveryRecordError extends LiveryApplyError {
  constructor(override readonly cause: unknown) {
    super(
      `The liveries are uploaded and assigned — that part worked. What failed was ` +
        `recording them locally, so they'll be missing from the carset pack until the next ` +
        `time they're applied: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
    this.name = "LiveryRecordError"
  }
}

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

/**
 * The championship has more than one class, and champctl will not write it.
 *
 * `docs/acsm-champ-form.md` §4.4: the championship form renders no
 * `EntryList.EntrantID`, so ACSM's `BuildEntryList` falls back to `PitBox = i`
 * — and it runs that loop once per class, with `i` restarting at 0 each time.
 * Two classes therefore produce two entrants both claiming `CAR_0`, and
 * `AddInPitBox` overwrites on collision, so one of them is silently gone from
 * the entry list the next time a session starts.
 *
 * Nobody has measured a multi-class save against a real manager, and the way to
 * measure it is not on a league's championship the evening before a race. BATL
 * runs one class plus the spectator van, so this refusal costs BATL nothing —
 * and champctl is deliberately public, so the league it does not cost nothing
 * is somebody else's.
 *
 * A refusal rather than a warning because there is no safe half-measure: the
 * form save is a whole-championship replace (§4.5), so the damage is done by
 * the one POST this would otherwise make.
 */
export class MultiClassError extends LiveryApplyError {
  constructor(readonly classCount: number) {
    super(
      `This championship has ${classCount} classes, and champctl only writes single-class ` +
        `championships. The championship form carries no EntryList.EntrantID, so ACSM rebuilds ` +
        `the pit boxes by position and restarts the numbering for each class — two classes means ` +
        `two drivers assigned the same pit box, and one of them is dropped from the entry list ` +
        `when the session starts. Nothing was written, and any skins already uploaded are ` +
        `harmless. Assign the skins in ACSM by hand, or see docs/acsm-champ-form.md §4.4.`,
    )
    this.name = "MultiClassError"
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
  /**
   * Where to record what was applied, for the carset pack
   * (docs/discord-livery-upload.md §6).
   *
   * Hung off the apply rather than off each caller so that every route in gets
   * recorded by construction — an operator's `--zip` as much as the Discord
   * drain. A carset assembled from only one of those routes is wrong in a way
   * nobody can see: the file is on the server, absent from the pack, and the
   * driver who installed the pack still cannot see that car.
   *
   * An interface rather than the store itself, so this module keeps its
   * distance from SQLite. The CLI does the wiring.
   */
  record?: LiveryRecorder
  /** Recorded as-is. Not branched on; it is there for the audit trail. */
  source?: LiverySource
  /**
   * Where to keep the championship as it was before the save, read logged in.
   *
   * The save replaces the whole championship, and the first one on BATL's
   * updated build damaged it. Putting it back took an export read *logged
   * in*: the public one leaves out the sign-up responses and the server
   * password, and restoring from it would have erased both. Omit only where
   * there is nothing to lose, as in tests.
   */
  backupDir?: string
  /** The most one skin upload request carries; `MAX_UPLOAD_REQUEST_BYTES` unless set. */
  maxRequestBytes?: number
}

export interface ApplyLiveriesResult {
  uploaded: { driverName: string; carModel: string; skinFolder: string; files: number }[]
  /** True when the championship form was posted. */
  championshipSaved: boolean
  /** True when the practice restart was requested. */
  practiceRestarted: boolean
  /** What the recorder did, when there was one. */
  recorded?: RecordResult
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

  // Every check before anything is written: the backup, the form, the
  // description, the deadline. Checked after the uploads, as they used to be,
  // a refusal left the skins on the server behind it.
  const checked =
    plan.skinChanges.length > 0
      ? await liveryChanged(() =>
          checkChampionshipSave(session, plan.championshipId, skinEdit(plan), options.backupDir),
        )
      : undefined

  for (const assignment of plan.assignments) {
    await uploadSkin(
      session,
      assignment.carModel,
      assignment.livery,
      options.maxRequestBytes ?? MAX_UPLOAD_REQUEST_BYTES,
    )
    result.uploaded.push({
      driverName: assignment.driverName,
      carModel: assignment.carModel,
      skinFolder: assignment.skinFolder,
      files: assignment.livery.files.length,
    })
  }

  // Only when a `Skin` field actually differs. The uploads above have already
  // replaced the files the entry list points at, so a re-upload onto skins that
  // are already assigned needs no write — and this write is a
  // whole-championship replace, which is not a thing to do for nothing.
  if (plan.skinChanges.length > 0) {
    await liveryChanged(() => checked!.save())
    result.championshipSaved = true
  }

  // Last, after the uploads and after any write they needed. Everything in
  // `assignments` is recorded, including the ones that produced no
  // `skinChanges` — a driver who fixed a wrong sponsor and resubmitted keeps
  // the same skin folder, so the entry list needs no edit and the *bytes* are
  // still new. Recording only what moved the form would leave the carset
  // handing the whole grid the livery that was just replaced.
  //
  // A throw anywhere above means nothing is recorded, which is the right way
  // round: a skin that never reached the server has no business in the carset.
  if (options.record) {
    try {
      result.recorded = await options.record.record(
        plan.championshipId,
        plan.assignments.map((a) => a.livery),
        new Date(),
        options.source ?? "unknown",
      )
    } catch (e) {
      throw new LiveryRecordError(e)
    }
  }

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
 * Requests per skin rather than one for the lot, so a failure names the
 * driver it failed for, and as many per skin as keep each under
 * `maxRequestBytes`. A skin that half-arrived is harmless: nothing points at it
 * until the championship save, and a re-run uploads every file again.
 */
async function uploadSkin(
  session: AcsmSession,
  carModel: string,
  livery: Livery,
  maxRequestBytes: number,
): Promise<void> {
  const batches: Livery["files"][] = []
  let size = 0
  for (const file of livery.files.filter((f) => ACSM_SKIN_FILES.has(f.name))) {
    const last = batches.at(-1)
    if (last && size + file.bytes.length <= maxRequestBytes) {
      last.push(file)
      size += file.bytes.length
    } else {
      batches.push([file])
      size = file.bytes.length
    }
  }
  for (const files of batches) await uploadSkinFiles(session, carModel, livery, files)
}

async function uploadSkinFiles(
  session: AcsmSession,
  carModel: string,
  livery: Livery,
  files: Livery["files"],
): Promise<void> {
  const path = carSkinUploadPath(carModel)
  const bytes = files.reduce((total, f) => total + f.bytes.length, 0)
  const parts = files.map((f) => ({
    // The field name is arbitrary — ACSM iterates r.MultipartForm.File and
    // ignores the keys. `files` is what the page's own uploader calls it.
    field: "files",
    fileName: `${livery.skinFolder}/${f.name}`,
    bytes: f.bytes,
  }))

  let res: Response
  try {
    res = await session.postFiles(path, parts, {
      // The handler ends with `http.Redirect(w, r, r.Referer(), 302)`. With no
      // Referer that is a redirect to the empty string, which is a 302 carrying
      // nothing — survivable, but it makes a successful upload
      // indistinguishable from a confused one in the logs.
      referer: session.url(`/car/${encodeURIComponent(carModel)}`),
      timeoutMs: uploadTimeoutMs(bytes),
    })
  } catch (e) {
    // A timeout here reads as "the request failed", which sends whoever is
    // holding the zip looking at ACSM. It is far more often the uplink.
    const why = e instanceof Error ? e.message : String(e)
    if (/timed out/i.test(why)) {
      throw new LiveryApplyError(
        `Uploading ${livery.driverName}'s livery for ${carModel} timed out. That request ` +
          `was ${mb(bytes)} across ${files.length} files, and champctl allowed ` +
          `${Math.round(uploadTimeoutMs(bytes) / 1000)}s for it — so either the connection to the ` +
          `server is slower than ${mb(SLOWEST_ASSUMED_UPLOAD_BYTES_PER_SECOND)}/s or the server ` +
          `stopped answering. Nothing was assigned; re-running re-uploads only what is missing.`,
      )
    }
    throw e
  }

  if (!isRedirectStatus(res.status)) {
    throw new LiveryApplyError(
      `ACSM didn't accept ${livery.driverName}'s livery for ${carModel} (HTTP ${res.status}, no ` +
        `redirect). It answers a successful skin upload with a 302 and a failure with a 500, so ` +
        `anything else is something other than Server Manager answering. Nothing was assigned.`,
    )
  }
}

/**
 * The plan's skins as an edit of the championship form.
 *
 * Each driver's row is found by name on every read of the form, and a driver
 * the form no longer has is refused: a sign-up approved while the preview was
 * open would otherwise be the one that gets moved.
 */
function skinEdit(plan: LiveryPlan): ChampionshipEdit {
  const rows = (form: ChampionshipForm) => {
    if (form.entrantsPerClass.length > 1) throw new MultiClassError(form.entrantsPerClass.length)
    return plan.assignments.map((a) => {
      const row = findEntrantRow(form, a.driverName)
      if (row === undefined) {
        throw new RosterChangedError(
          `champctl matched ${a.driverName} against the championship export, and the ` +
            `entry list on the form does not have them.`,
        )
      }
      return { row, skin: a.skinFolder }
    })
  }
  return {
    what: "the liveries",
    leftBehind: "The skins are uploaded either way, and are harmless on their own.",
    check: rows,
    apply: (fields, form) => {
      for (const { row, skin } of rows(form)) setEntrantSkin(fields, row, skin)
    },
    skins: new Map(
      plan.assignments.map((a) => [a.driverName.normalize("NFC").trim(), a.skinFolder]),
    ),
  }
}

/** The shared save's "changed since the checks", as the liveries have always said it. */
async function liveryChanged<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f()
  } catch (e) {
    if (e instanceof ChampionshipChangedError) throw new RosterChangedError(e.detail)
    throw e
  }
}

/**
 * A pessimistic upload rate, in bytes per second.
 *
 * 256 KB/s is about 2 Mbit — slow for a home connection, and the point is to be
 * slower than anyone's rather than accurate. Being wrong high aborts a
 * perfectly good upload; being wrong low costs a wait on an upload that was
 * never going to finish.
 */
const SLOWEST_ASSUMED_UPLOAD_BYTES_PER_SECOND = 256 * 1024

/**
 * How long to allow one skin upload.
 *
 * `AcsmSession`'s default is 30 seconds, which is right for a page of HTML and
 * wrong for this: one request can carry 90 MB, so the default aborts a
 * legitimate upload of a large livery and reports it as a request failure. That
 * became reachable when the pack limits were doubled to fit real submissions —
 * see `DEFAULT_LIMITS` in `pack.ts`.
 */
export function uploadTimeoutMs(bytes: number): number {
  return 30_000 + Math.ceil(bytes / SLOWEST_ASSUMED_UPLOAD_BYTES_PER_SECOND) * 1000
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
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
  return plan.assignments.flatMap((a) => {
    const row = findEntrantRow(form, a.driverName)
    if (row === undefined) return []
    return [{ row, name: names[row] ?? "", from: skins[row] ?? "", to: a.skinFolder }]
  })
}
