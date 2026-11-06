/**
 * Saving the championship edit form, which replaces the whole championship.
 *
 * Every champctl write of this form goes through here. The form, its traps
 * and the measurements behind each check are in `championship-form.ts` and
 * docs/acsm-champ-form.md; this is the order of operations around one save,
 * which is the same whatever the save changes:
 *
 *   1. read the championship logged in, keep it as a backup, and make every
 *      refusal that can be made, before the caller does anything else;
 *   2. just before posting, check nothing changed since, apply the edit to a
 *      fresh read of the form, and check the payload's shape again;
 *   3. read the championship back and refuse anything the edit didn't ask for.
 */

import * as cheerio from "cheerio"
import { randomBytes } from "node:crypto"
import { mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import {
  CHAMPIONSHIP_REQUIRED_ENTRY_LIST_FIELDS,
  type ChampionshipForm,
  championshipRows,
  currentNames,
  findChampionshipForm,
  SPECTATOR_MARKER,
} from "./championship-form.js"
import { type FormField, getAll, setOne } from "./form.js"
import {
  CHAMPIONSHIP_SUBMIT_PATH,
  championshipEditPath,
  championshipPath,
  exportPath,
} from "./paths.js"
import { AcsmWriteError, isRedirectStatus, type AcsmSession } from "./session.js"
import type { Championship } from "./types.js"
import { championshipIdFromRedirect } from "./write.js"

/**
 * The championship changed between the checks and the save. Nothing was
 * written; the caller looks again rather than reporting a failure.
 */
export class ChampionshipChangedError extends AcsmWriteError {
  constructor(readonly detail: string) {
    super(detail, undefined, CHAMPIONSHIP_SUBMIT_PATH)
    this.name = "ChampionshipChangedError"
  }
}

/** One change to the championship form, and what a save of it may change. */
export interface ChampionshipEdit {
  /** What it changes, for messages: "the liveries". */
  what: string
  /** Said after a refusal, about anything the caller did before the save. */
  leftBehind?: string
  /**
   * Refusals that need the championship as the save will hold itself to it:
   * the export it backs up, which nothing may change before the POST.
   */
  checkChampionship?(before: Championship): void
  /** Refusals that need the form, made before anything is written and again at the save. */
  check?(form: ChampionshipForm): void
  /** Makes the change, in place, on a fresh read of the form. */
  apply(fields: FormField[], form: ChampionshipForm): void
  /** Entrants whose skin the save may change, by NFC-trimmed name, to which folder. */
  skins?: ReadonlyMap<string, string>
  /**
   * Called immediately before the POST, after every read the save makes, to
   * refuse it: a caller holding the drain's lease checks it still does.
   */
  beforePost?(): Promise<void>
  /** Spectator cars the edit adds after the championship's own, in order. */
  addsSpectators?: readonly AddedSpectator[]
}

/** What a spectator car added by an edit has to come back as. */
export interface AddedSpectator {
  Name: string
  GUID: string
  Model: string
  Skin: string
}

/** A save every check has passed, to be made once the caller is ready. */
export interface CheckedSave {
  /** Where the championship as it was is kept, when there was somewhere to keep it. */
  readonly backup: string | undefined
  save(): Promise<void>
}

interface Preflight {
  /** The logged-in export, as text, exactly as read. */
  beforeText: string
  before: Championship
  backup: string | undefined
}

/**
 * Every refusal a championship save can make, made before anything is written.
 *
 * `backupDir` is where to keep the championship as it was, read logged in: the
 * public export leaves out the sign-up responses and the server password, and
 * restoring from it would erase both. Omit it only where there is nothing to
 * lose, as in tests.
 */
export async function checkChampionshipSave(
  session: AcsmSession,
  championshipId: string,
  edit: ChampionshipEdit,
  backupDir?: string,
): Promise<CheckedSave> {
  const beforeText = await session.getText(exportPath(championshipId))
  const before = JSON.parse(beforeText) as Championship
  const backup = backupDir ? await writeBackup(backupDir, championshipId, beforeText) : undefined
  edit.checkChampionship?.(before)

  const form = await readForm(session, championshipId, edit)
  checkDescription(before, form)
  checkSpectatorRows(before, form)
  checkPitBoxes(before)
  checkClassRows(before, form)
  registrationDeadline(before)
  const checked = { beforeText, before, backup }
  return { backup, save: () => saveChampionship(session, championshipId, edit, checked) }
}

/**
 * The form, fetched rather than reused. The save is a whole-championship
 * replace: a sign-up approved since the last read would be silently dropped by
 * posting a form read before it landed.
 */
async function readForm(
  session: AcsmSession,
  championshipId: string,
  edit: ChampionshipEdit,
): Promise<ChampionshipForm> {
  const path = championshipEditPath(championshipId)
  const form = findChampionshipForm(await session.getText(path), session.url(path))
  edit.check?.(form)
  // docs/acsm-champ-form.md §4.4: with no EntrantID on the form, a second
  // class's pit boxes restart at 0 and collide with the first's.
  if (form.entrantsPerClass.length > 1) {
    throw new AcsmWriteError(
      `This championship has ${form.entrantsPerClass.length} classes, and champctl only writes ` +
        `single-class championships (docs/acsm-champ-form.md §4.4). Nothing was written.`,
      undefined,
      CHAMPIONSHIP_SUBMIT_PATH,
    )
  }
  return form
}

async function saveChampionship(
  session: AcsmSession,
  championshipId: string,
  edit: ChampionshipEdit,
  checked: Preflight,
): Promise<void> {
  // The championship has to be as it was when it was backed up. An admin
  // editing it in the meantime would otherwise read, after the save, as drift
  // champctl caused — and the backup would not have their edit in it.
  const nowText = await session.getText(exportPath(championshipId))
  if (nowText !== checked.beforeText) {
    throw new ChampionshipChangedError(
      `The championship changed between champctl's checks and its save — someone edited it, or ` +
        `a sign-up arrived. Nothing was written to it; the next pass will start again from the ` +
        `championship as it now is.`,
    )
  }

  const form = await readForm(session, championshipId, edit)
  checkDescription(checked.before, form)
  checkSpectatorRows(checked.before, form)

  const fields = [...form.fields]
  edit.apply(fields, form)
  // Held to the same rules as the page it came from, so an edit can't post a
  // payload ACSM would read rows of differently.
  const shape = championshipRows(fields)
  const adds = edit.addsSpectators?.length ?? 0
  if (shape.spectatorRows !== form.spectatorRows + adds || shape.rows !== form.rows + adds) {
    throw new AcsmWriteError(
      `Editing the championship form changed its rows (${form.rows} to ${shape.rows}, ` +
        `${form.spectatorRows} to ${shape.spectatorRows} spectator cars), where the edit adds ` +
        `${adds}. Nothing was written.`,
      undefined,
      CHAMPIONSHIP_SUBMIT_PATH,
    )
  }

  const deadline = registrationDeadline(checked.before)
  if (deadline) {
    setOne(fields, "Championship.SignUpForm.RegistrationDeadlineDate", deadline.date)
    setOne(fields, "Championship.SignUpForm.RegistrationDeadlineTime", deadline.time)
    setOne(fields, "Championship.SignUpForm.RegistrationDeadlineTimezone", deadline.timezone)
  }

  // Which save this is. `Editing` is rendered by the form so this only restates
  // it; the ACSM UI carries `action` on the submit button, and `parseForm` drops
  // buttons on purpose, so a payload built purely from the parsed form lacks it.
  setOne(fields, "action", "saveChampionship")

  await edit.beforePost?.()

  let res: Response | undefined
  let sendError: unknown
  try {
    res = await session.postForm(CHAMPIONSHIP_SUBMIT_PATH, fields, {
      // The event form's list would refuse this outright: the championship form
      // genuinely renders no EntryList.EntrantID. See the constant's comment.
      requiredEntryListFields: CHAMPIONSHIP_REQUIRED_ENTRY_LIST_FIELDS,
      // Marks the spectator cars' rows; findChampionshipForm has counted them.
      entryListMarkers: [SPECTATOR_MARKER],
    })
  } catch (e) {
    // Refused before sending, or lost on the way. Either way ACSM may or may
    // not have it, so the check below runs regardless.
    sendError = e
  }

  // Then check what it did, whatever the response said. A redirect says ACSM
  // took the form, not what it made of it: the save that moved every driver a
  // row redirected exactly like a good one. And a 500 or a timeout does not
  // prove nothing was written. Everything but what the edit asked for has to
  // come back as it went in — the export for the championship, and the edit
  // page for the description, which the export can't show (it inlines images,
  // whatever is stored).
  let drift: string[]
  try {
    const after = JSON.parse(await session.getText(exportPath(championshipId))) as Championship
    drift = championshipDrift(
      checked.before,
      after,
      edit.skins ?? new Map(),
      edit.addsSpectators ?? [],
    )
    const pageAfter = await session.getText(championshipEditPath(championshipId))
    if (descriptionOf(pageAfter) !== form.description) drift.push(".Info changed on the page")
  } catch (e) {
    throw new ChampionshipUnverifiedError(championshipId, e, checked.backup)
  }
  if (drift.length > 0) {
    throw new ChampionshipDriftError(championshipId, edit.what, drift, checked.backup)
  }

  if (sendError !== undefined) throw sendError
  if (!res || !isRedirectStatus(res.status)) {
    throw new AcsmWriteError(
      `ACSM didn't accept the championship save (HTTP ${res?.status}, no redirect), and the ` +
        `championship is unchanged. It reports form errors by re-rendering the page rather than ` +
        `in the response.${edit.leftBehind ? ` ${edit.leftBehind}` : ""}`,
      res?.status,
      CHAMPIONSHIP_SUBMIT_PATH,
    )
  }

  // Which championship it landed on, not just that it landed somewhere.
  //
  // `/championships/new/submit` serves create *and* edit — an edit is a create
  // carrying an existing ID (`paths.ts`, docs §4.5) — so the 3xx alone does not
  // say this was an edit of the intended championship, and two ordinary
  // failures both arrive as a 302. A session that lapsed between the form GET
  // and this POST redirects to the login page: nothing written, reported as
  // saved. And a payload whose identity field didn't survive the round trip is
  // treated as a *create*: the real championship is untouched and a duplicate
  // now holds the entry list, again reported as saved.
  //
  // The `Location` header is the only place the answer is written down.
  const landedOn = championshipIdFromRedirect(res)
  if (!sameChampionshipId(landedOn, championshipId)) {
    throw new AcsmWriteError(
      `The championship save redirected to ${landedOn ? `championship ${landedOn}` : `"${res.headers.get("location") ?? ""}"`}, ` +
        `not to ${championshipId}. ACSM serves create and edit from the same endpoint, so ` +
        `this is either a session that expired mid-write — in which case nothing was saved — or ` +
        `a save that ACSM took as a new championship, in which case ${championshipId} is ` +
        `untouched and there is a duplicate to delete. Check ` +
        `${championshipPath(championshipId)}.${edit.leftBehind ? ` ${edit.leftBehind}` : ""}`,
      res.status,
      CHAMPIONSHIP_SUBMIT_PATH,
    )
  }
}

/** The description as the edit page holds it, for comparing before and after. */
function descriptionOf(editPage: string): string {
  return cheerio.load(editPage)("#ChampionshipInfoHolder").html()?.trim() ?? ""
}

/**
 * The form's leading rows have to be the championship's spectator cars, in
 * order. ACSM reads them as such by count alone, so this is the check that
 * they are what the count says.
 */
function checkSpectatorRows(before: Championship, form: ChampionshipForm): void {
  const stored = (before.SpectatorCars ?? []).map((c) => c.GUID ?? "")
  const onForm = getAll(form.fields, "EntryList.GUID").slice(0, form.spectatorRows)
  if (stored.length !== onForm.length || stored.some((g, i) => g !== onForm[i])) {
    throw new AcsmWriteError(
      `The edit page's ${form.spectatorRows} spectator-car rows don't match the ` +
        `championship's ${stored.length} spectator cars, by GUID and in order, so champctl ` +
        `can't tell which rows ACSM would read as drivers. Nothing was written.`,
      undefined,
      CHAMPIONSHIP_SUBMIT_PATH,
    )
  }
}

/**
 * Every class's pit boxes have to be 0 to n-1 already. The form has no
 * EntrantID, so a save numbers each class's entrants by position (§4.4): any
 * other numbering would move somebody, and the drift check matches entrants by
 * pit box on that understanding.
 */
function checkPitBoxes(before: Championship): void {
  for (const [i, cls] of (before.Classes ?? []).entries()) {
    const boxes = Object.values(cls.Entrants ?? {})
      .map((e) => e.PitBox)
      .sort((a, b) => (a ?? -1) - (b ?? -1))
    if (boxes.some((b, n) => b !== n)) {
      throw new AcsmWriteError(
        `Class ${i + 1}'s pit boxes are ${boxes.join(", ")}, and saving the championship form ` +
          `renumbers them 0 to ${boxes.length - 1} by position, which would move somebody. ` +
          `Nothing was written. Saving the championship once in ACSM renumbers them.`,
        undefined,
        CHAMPIONSHIP_SUBMIT_PATH,
      )
    }
  }
}

/**
 * The form's class rows have to be the export's entrants in pit-box order,
 * which is how 2.4.15 renders them and what a save numbers them by. Any other
 * order would move drivers, and the drift check would only see it afterwards.
 * Single class only, as `readChampionshipForm` refuses more.
 */
function checkClassRows(before: Championship, form: ChampionshipForm): void {
  const byBox = Object.values(before.Classes?.[0]?.Entrants ?? {}).sort(
    (a, b) => (a.PitBox ?? 0) - (b.PitBox ?? 0),
  )
  const names = currentNames(form).slice(form.spectatorRows)
  const guids = getAll(form.fields, "EntryList.GUID").slice(form.spectatorRows)
  const out = byBox.findIndex((e, i) => (e.Name ?? "") !== names[i] || (e.GUID ?? "") !== guids[i])
  if (out >= 0 || names.length !== byBox.length) {
    throw new AcsmWriteError(
      `The edit page doesn't list the drivers in pit-box order (first difference at pit box ` +
        `${out >= 0 ? out : byBox.length}), and saving it would number them by that order, ` +
        `moving somebody. Nothing was written.`,
      undefined,
      CHAMPIONSHIP_SUBMIT_PATH,
    )
  }
}

/**
 * The description has to be on the page if the championship has one.
 *
 * It is posted from the page's `#ChampionshipInfoHolder`, which is what a
 * browser posts: ACSM stores images in it as `/content/...` URLs. The export
 * inlines those as base64, so it can't be the source — posted, it stored a
 * 12 KB description as 2 MB inline, and a description with a few large images
 * exceeds Go's 10 MB form limit outright (measured on 2.4.15). A page and an
 * export that disagree about whether there is one at all is a page champctl
 * doesn't understand.
 */
function checkDescription(before: Championship, form: ChampionshipForm): void {
  const stored = typeof before.Info === "string" ? before.Info.trim() : ""
  if (Boolean(stored) !== Boolean(form.description)) {
    throw new AcsmWriteError(
      `The championship ${stored ? "has a description the edit page doesn't show" : "edit page shows a description the export doesn't have"}, ` +
        `so champctl can't tell what saving the form would leave behind. Nothing was written.`,
      undefined,
      CHAMPIONSHIP_SUBMIT_PATH,
    )
  }
}

/**
 * The registration deadline, as fields that can't move it.
 *
 * The form renders the deadline's date and time and leaves its timezone to the
 * page's script, which fills in the browser's. Posted empty, ACSM read the wall
 * clock as UTC: a 19:00 Los Angeles deadline came back as 19:00 UTC, seven
 * hours earlier, on every save (measured on 2.4.15).
 *
 * So it is sent from the export, in the offset it was stored in, named as the
 * fixed-offset zone ACSM's Go can load: `-07:00` is `Etc/GMT+7` (the sign is
 * POSIX's, inverted). Sent as UTC instead it kept the instant but came back
 * written as `Z`, which is a different stored value. An offset that isn't a
 * whole hour has no such zone, so a deadline in one is refused rather than
 * moved. Undefined when no deadline is set, which the form already posts
 * correctly.
 */
function registrationDeadline(
  before: Championship,
): { date: string; time: string; timezone: string } | undefined {
  const raw: unknown = before.SignUpForm?.RegistrationDeadline
  if (typeof raw !== "string" || raw.startsWith("0001-01-01")) return undefined
  const m =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(raw)
  const whole = m && (m[3] === "Z" || m[6] === "00")
  if (!m || !whole || (m[3] !== "Z" && Number.isNaN(Number(m[5])))) {
    throw new AcsmWriteError(
      `The championship's registration deadline is "${raw}", which champctl can't send back ` +
        `without moving it. Nothing was written.`,
      undefined,
      CHAMPIONSHIP_SUBMIT_PATH,
    )
  }
  const hours = m[3] === "Z" ? 0 : Number(m[5])
  const timezone = hours === 0 ? "UTC" : `Etc/GMT${m[4] === "-" ? "+" : "-"}${hours}`
  return { date: m[1]!, time: m[2]!, timezone }
}

/**
 * Two championship ids, compared the way ACSM's router compares them.
 *
 * Case-insensitively, because the two sides come from different places: one is
 * whatever the operator typed on the command line, the other is whatever Go's
 * `uuid.String()` wrote into `Location`, which is always lowercase. ACSM parses
 * the id case-insensitively, so a championship pasted as `1E9F4A2B-...` reads
 * and saves perfectly — and a `!==` here would then call that successful save a
 * duplicate-creating failure, which is a worse answer than the one this check
 * was added to replace.
 */
function sameChampionshipId(a: string | undefined, b: string): boolean {
  return a !== undefined && a.toLowerCase() === b.toLowerCase()
}

/**
 * The save changed something champctl didn't ask it to.
 *
 * Not recoverable from here: the championship is already written. The backup
 * is what to put back, with an import of the same id — read logged in, it has
 * everything the public export leaves out. The drain stops on this and stays
 * stopped (see `SqliteSubmissionQueue.haltDrain`): another pass would plan
 * against the damaged championship and save over it again.
 */
export class ChampionshipDriftError extends AcsmWriteError {
  constructor(
    championshipId: string,
    what: string,
    readonly drift: readonly string[],
    readonly backup?: string,
  ) {
    super(
      `The championship save for ${championshipId} changed more than ${what}: ` +
        `${drift.slice(0, 8).join("; ")}${drift.length > 8 ? `; and ${drift.length - 8} more` : ""}. ` +
        (backup
          ? `The championship as it was before is in ${backup}. champctl has stopped writing it; restore it before anything else is saved.`
          : `There is no backup of it from this run. champctl has stopped writing it; check the championship in ACSM.`),
      undefined,
      CHAMPIONSHIP_SUBMIT_PATH,
    )
    this.name = "ChampionshipDriftError"
  }
}

/**
 * A save reached ACSM and champctl couldn't read back what it did.
 *
 * Treated like drift: a save that can't be checked is not one to repeat.
 */
export class ChampionshipUnverifiedError extends AcsmWriteError {
  constructor(
    championshipId: string,
    override readonly cause: unknown,
    readonly backup?: string,
  ) {
    super(
      `champctl saved championship ${championshipId} and then couldn't read it back to check the ` +
        `save (${cause instanceof Error ? cause.message : String(cause)}). champctl has stopped writing it ` +
        `until someone looks${backup ? `; the championship as it was before is in ${backup}` : ""}.`,
      undefined,
      CHAMPIONSHIP_SUBMIT_PATH,
    )
    this.name = "ChampionshipUnverifiedError"
  }
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000"

/**
 * Every difference between two exports except the ones a save of the edit makes.
 *
 * Allowed: `Updated`; the `Skin` of an entrant named in `skins` changing to the
 * folder given for them; and an entrant's `ClassID` becoming the nil UUID or
 * its class's id, which ACSM does on every save of this form — a browser saving
 * it unchanged does the same, measured on 2.4.15. Anything else — an entrant in
 * a different slot, a spectator car gone, a description emptied — is listed by
 * path.
 *
 * Class entrants are compared by pit box rather than by `CAR_n` key: a save
 * re-keys them so `CAR_n` holds pit box n, and BATL's exports had keys out of
 * that order. Their InternalUUIDs are all nil, so can't be the key instead.
 * Spectator cars come back with pit box i and race number 0, the form having
 * no field for either, and not necessarily in the order they were posted in,
 * so they are compared by GUID (all measured on 2.4.15).
 */
export function championshipDrift(
  before: unknown,
  after: unknown,
  skins: ReadonlyMap<string, string>,
  added: readonly AddedSpectator[] = [],
): string[] {
  const out: string[] = []
  const walk = (x: unknown, y: unknown, path: string, entrant?: string, classId?: string) => {
    if (x !== null && y !== null && typeof x === "object" && typeof y === "object") {
      if (Array.isArray(x) !== Array.isArray(y)) {
        out.push(`${path} changed`)
        return
      }
      const xo = x as Record<string, unknown>
      const yo = y as Record<string, unknown>
      // The class a run of entrants belongs to, for the ClassID allowance.
      const cls = /\.Classes\.\d+$/.test(path) ? String(yo["ID"] ?? "") : classId
      for (const key of new Set([...Object.keys(xo), ...Object.keys(yo)])) {
        const here = `${path}.${key}`
        if (here === ".Updated") continue
        if (!(key in xo) || !(key in yo)) {
          out.push(`${here} ${key in xo ? "removed" : "added"}`)
          continue
        }
        const name = /\.Classes\.\d+\.Entrants\.[^.]+$/.test(here)
          ? String((yo[key] as { Name?: unknown })?.Name ?? "")
          : entrant
        if (
          key === "ClassID" &&
          entrant !== undefined &&
          (yo[key] === NIL_UUID || (cls !== undefined && cls !== "" && yo[key] === cls))
        ) {
          continue
        }
        if (
          key === "Skin" &&
          entrant !== undefined &&
          skins.get(entrant.normalize("NFC").trim()) === yo[key] &&
          String((xo as { Name?: unknown }).Name ?? "") === entrant
        ) {
          continue
        }
        walk(xo[key], yo[key], here, name, cls)
      }
      return
    }
    if (JSON.stringify(x) !== JSON.stringify(y)) out.push(`${path} changed`)
  }
  walk(asSaved(before, added), inOrderOf(before, after, added), "")
  return out
}

/** `before` as a save that changed nothing would return it, for `championshipDrift`. */
function asSaved(before: unknown, added: readonly AddedSpectator[]): unknown {
  if (before === null || typeof before !== "object") return before
  const c = structuredClone(before) as Championship
  if (c.SpectatorCars) {
    c.SpectatorCars = c.SpectatorCars.map((car, i) => ({ ...car, PitBox: i, RaceNumber: 0 }))
  }
  if (added.length > 0) {
    const own = c.SpectatorCars?.length ?? 0
    c.SpectatorCars = [
      ...(c.SpectatorCars ?? []),
      ...added.map((car, i) => ({
        ...car,
        ...ADDED_ROW,
        PitBox: own + i,
        RaceNumber: 0,
        InternalUUID: ASSIGNED,
      })),
    ]
  }
  for (const cls of c.Classes ?? []) {
    const entrants = Object.values(cls.Entrants ?? {})
    const boxes = new Set(entrants.map((e) => e.PitBox))
    // Ambiguous or missing pit boxes stay keyed as they were, and checkPitBoxes
    // refuses such a championship before it is written.
    if (boxes.size !== entrants.length || entrants.some((e) => typeof e.PitBox !== "number")) {
      continue
    }
    cls.Entrants = Object.fromEntries(entrants.map((e) => [`CAR_${e.PitBox}`, e]))
  }
  return c
}

/**
 * `after` with its spectator cars in `before`'s order, matched by GUID, then
 * the ones the edit added. A GUID that isn't unique on both sides leaves the
 * order alone, for the walk to flag.
 */
function inOrderOf(before: unknown, after: unknown, added: readonly AddedSpectator[]): unknown {
  const guids = (c: unknown) =>
    ((c as Championship | null)?.SpectatorCars ?? []).map((car) => car.GUID)
  const was = [...guids(before), ...added.map((a) => a.GUID)]
  const now = guids(after)
  if (new Set(was).size !== was.length || new Set(now).size !== now.length) return after
  const cars = (after as Championship).SpectatorCars
  if (!cars) return after
  const rank = (g: string | undefined) => {
    const i = was.indexOf(g)
    return i < 0 ? was.length : i
  }
  const own = was.length - added.length
  return {
    ...(after as Championship),
    // An added car is held to what the edit set and ACSM is known to: the
    // rest of it is ACSM's defaults for a new row, which nobody asked for.
    SpectatorCars: [...cars]
      .sort((a, b) => rank(a.GUID) - rank(b.GUID))
      .map((car) => {
        const i = rank(car.GUID)
        if (i < own || i >= was.length) return car
        const uuid = car.InternalUUID
        return {
          Name: car.Name,
          GUID: car.GUID,
          Model: car.Model,
          Skin: car.Skin,
          ...Object.fromEntries(
            Object.keys(ADDED_ROW).map((k) => [k, (car as Record<string, unknown>)[k]]),
          ),
          PitBox: car.PitBox,
          RaceNumber: car.RaceNumber,
          InternalUUID: uuid && uuid !== NIL_UUID ? ASSIGNED : uuid,
        }
      }),
  }
}

/**
 * What an added car comes back with for the rest of what `addSpectatorCars`
 * posts, and the spectator flag (measured on 2.4.15). ACSM's own defaults for
 * what nobody posts, such as CSPCarFlags, aren't held to anything.
 */
const ADDED_ROW = {
  Team: "",
  Ballast: 0,
  Restrictor: 0,
  FixedSetup: "",
  ConnectAsSpectator: true,
}

/** Stands for whatever InternalUUID ACSM gave a car it was sent without one. */
const ASSIGNED = "assigned by ACSM"

/** Backups kept per championship; older ones are removed as new ones land. */
const BACKUPS_KEPT = 20

export async function writeBackup(
  dir: string,
  championshipId: string,
  text: string,
): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const stamp = new Date().toISOString().replaceAll(":", "")
  const file = join(dir, `${championshipId}-${stamp}-${randomBytes(3).toString("hex")}.json`)
  // 0600: a logged-in export carries the sign-up responses and the server
  // password. `wx`, so a collision fails rather than overwriting a backup.
  await writeFile(file, text, { mode: 0o600, flag: "wx" })

  // Oldest first by name, which starts with the timestamp.
  const mine = (await readdir(dir))
    .filter((f) => f.startsWith(`${championshipId}-`) && f.endsWith(".json"))
    .sort()
  for (const old of mine.slice(0, Math.max(0, mine.length - BACKUPS_KEPT))) {
    await rm(join(dir, old), { force: true })
  }
  return file
}
