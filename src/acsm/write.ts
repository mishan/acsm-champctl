/**
 * Write operations against ACSM, with the rules that stop them destroying data.
 *
 * Two of these are hard refusals rather than warnings, per plan §3.2 and §5.4.
 * Losing three weeks of results to a convenience feature is the worst outcome
 * this tool can produce, so the checks live here — below any UI, on the path
 * every caller has to take.
 */

import { randomUUID } from "node:crypto"

import { findFormByAction } from "./form.js"
import { AcsmWriteError, isRedirectStatus, type AcsmSession } from "./session.js"
import type { Championship } from "./types.js"
import { GO_ZERO_TIME, eventHasStarted, events, isZeroTime } from "./view.js"

/** Path to a championship's export, for reader and session alike. */
export function exportPath(championshipId: string): string {
  return `/championship/${encodeURIComponent(championshipId)}/export`
}

export function eventEditPath(championshipId: string, eventId: string, server = 0): string {
  return `/championship/${encodeURIComponent(championshipId)}/event/${encodeURIComponent(eventId)}/edit?server=${server}`
}

export function eventSubmitPath(championshipId: string): string {
  return `/championship/${encodeURIComponent(championshipId)}/event/submit`
}

export function eventSchedulePath(championshipId: string, eventId: string): string {
  return `/championship/${encodeURIComponent(championshipId)}/event/${encodeURIComponent(eventId)}/schedule`
}

export function entrantStatusPath(championshipId: string, entrantGuid: string): string {
  return `/championship/${encodeURIComponent(championshipId)}/entrant/${encodeURIComponent(entrantGuid)}`
}

export const IMPORT_PATH = "/championship/import"

/**
 * Championship IDs, scraped from the championships page.
 *
 * `/api/championships/list.json` is premium-only (docs/acsm-write-path.md §6),
 * so on the public build the HTML is the only way to enumerate them.
 */
export async function listChampionshipIds(session: AcsmSession): Promise<string[]> {
  const html = await session.getText("/championships")
  const ids = new Set<string>()
  const re = /\/championship\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi
  for (const m of html.matchAll(re)) {
    const id = m[1]
    if (id) ids.add(id.toLowerCase())
  }
  return [...ids]
}

/**
 * A real export from this server, made safe to re-import as a copy.
 *
 * Far better than a hand-built fixture for round-trip work: a synthetic
 * championship is a guess at *this version's* Go struct, and `ImportChampionship`
 * is a single `json.Unmarshal` into it — one type mismatch anywhere and the
 * whole import fails with no usable message. An export is by definition the
 * right shape.
 *
 * Everything that could reach a league is switched off, and results are
 * stripped so `assertNoResults` doesn't refuse it.
 */
export interface CopyOptions {
  /**
   * Leave the sign-up form enabled, with its responses stripped.
   *
   * Off by default — a copy shouldn't be collecting entries. Recon turns it on
   * because `/championship/{id}/entrants` 404s when sign-ups are disabled, and
   * that page is the approve/reject queue we need to see (plan §5.3). Safe on
   * a throwaway container nobody else can reach.
   */
  keepSignUpsEnabled?: boolean
}

export async function exportAsReimportableCopy(
  session: AcsmSession,
  championshipId: string,
  name: string,
  options: CopyOptions = {},
): Promise<Championship> {
  const source = await session.getJson<Championship>(exportPath(championshipId))

  const copy: Championship = regenerateIds({
    ...source,
    Name: name,
    Description: "Created by champctl recon. Safe to delete.",
    // Results are what makes an import destructive, and a copy has no claim
    // to them anyway.
    Events: events(source).map((ev) => ({
      ...ev,
      StartedTime: GO_ZERO_TIME,
      CompletedTime: GO_ZERO_TIME,
      Sessions: {},
      ScheduledServerID: "",
    })),
    // Nothing here should be able to contact anyone.
    ACSR: false,
    ExportSecondRaceToACSR: false,
    // Responses always go: they carry names, Steam GUIDs, emails and free-text
    // answers, and the export is public (plan §5.3).
    SignUpForm: {
      ...(source.SignUpForm ?? {}),
      Enabled: options.keepSignUpsEnabled === true,
      Responses: [],
    },
  })

  return copy
}

/**
 * Keys that must never be assigned onto a rebuilt object.
 *
 * `out[k] = value` on a plain object whose key is `__proto__` *reparents* the
 * object rather than adding a field. An ACSM export is parsed JSON, where
 * `__proto__` survives as an ordinary own property, so any code that rebuilds
 * an object key by key can silently give it a new prototype — and everything
 * downstream then reads inherited fields nobody set.
 *
 * Exported because rebuilding is a pattern rather than a place: `deepMerge`
 * and the emitter's id sweep both do it, and two copies of this list is one
 * that gets updated and one that doesn't.
 */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
])

/**
 * Rewrites every UUID in a championship so an import creates a new object.
 *
 * ACSM preserves UUIDs exactly as sent, which makes this load-bearing rather
 * than tidy: re-importing an unmodified export overwrites the championship it
 * came from (plan §5.4).
 *
 * Identity is remapped consistently — a given old ID always becomes the same
 * new one — so internal references survive.
 */
export function regenerateIds<T>(value: T): T {
  const mapping = new Map<string, string>()
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const NIL = "00000000-0000-0000-0000-000000000000"

  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (!UUID.test(v) || v === NIL) return v
      const existing = mapping.get(v)
      if (existing) return existing
      const fresh = randomUUID()
      mapping.set(v, fresh)
      return fresh
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v)) {
        // Dropped rather than copied. This walk rebuilds every object in the
        // championship, so an export carrying `__proto__` as an own property
        // reparented the rebuilt copy — measured: the emitted month inherited
        // `polluted: true` from a template that merely contained it, and every
        // check downstream then read fields nobody had set. `deepMerge` has
        // guarded this since it was written; the sweep did not.
        if (FORBIDDEN_KEYS.has(k)) continue
        out[k] = walk(val)
      }
      return out
    }
    return v
  }

  return walk(value) as T
}

/**
 * How this ACSM build wants a championship handed to it.
 *
 * Not the same across versions. 1.7.9 renders a `<textarea name="import">` and
 * reads it with `r.FormValue("import")`; 2.4.5 renders a file input and takes a
 * multipart upload. Guessing wrong produces no error — ACSM adds a flash and
 * re-renders the page with a 200 — so the mechanism is read off the form.
 */
export type ImportMechanism = { kind: "textarea"; field: string } | { kind: "file"; field: string }

/** Works out how to import by looking at what the import page renders. */
export async function detectImportMechanism(session: AcsmSession): Promise<ImportMechanism> {
  const html = await session.getText(IMPORT_PATH)
  const form = findFormByAction(html, IMPORT_PATH, { pageUrl: session.url(IMPORT_PATH) })

  if (!form) {
    throw new AcsmWriteError(
      `No form posting to ${IMPORT_PATH} on the import page. Is this account allowed to import?`,
    )
  }
  // File first: a build offering both would mean the upload is the real path.
  const file = form.fileFields[0]
  if (file) return { kind: "file", field: file }

  const textArea = form.textAreaFields[0]
  if (textArea) return { kind: "textarea", field: textArea }

  throw new AcsmWriteError(
    `The import form has neither a file input nor a textarea; fields are: ` +
      `${form.fields.map((f) => f.name).join(", ") || "(none)"}`,
  )
}

export interface ImportOptions {
  /**
   * Assign fresh UUIDs before importing. Default true, and you should have a
   * concrete reason to turn it off.
   */
  freshIds?: boolean
  /**
   * Allow importing over an ID that already exists. Default false.
   *
   * Only relaxes "something is already there". A target that has results is
   * refused regardless — delete it in ACSM first if that is really the intent.
   */
  allowOverwrite?: boolean
  /**
   * Skip the form probe and use this mechanism. Leave unset — detecting it is
   * one cheap GET and it's the difference between working on 1.7.x and 2.4.x.
   */
  mechanism?: ImportMechanism
  /** Stamp `Created` at import time rather than inheriting it (plan §5.5). */
  stampCreated?: boolean
  now?: Date
}

export interface ImportResult {
  /** Always set: importChampionship throws when ACSM does not redirect. */
  championshipId: string
  /** The payload actually sent, so a caller can diff against the re-export. */
  sent: Championship
  /** Which mechanism this build turned out to use. Worth reporting in recon. */
  mechanism: ImportMechanism
}

/**
 * Imports a championship, refusing the two cases that lose data.
 *
 * 1. The payload itself carries results — importing it would be a restore, not
 *    a create, and this is not the tool for that.
 * 2. The ID already exists on the server, unless explicitly allowed.
 */
export async function importChampionship(
  session: AcsmSession,
  championship: Championship,
  options: ImportOptions = {},
): Promise<ImportResult> {
  assertNoResults(championship)

  let payload: Championship =
    options.freshIds === false ? championship : regenerateIds(championship)

  if (options.stampCreated !== false) {
    const now = (options.now ?? new Date()).toISOString()
    payload = { ...payload, Created: now, Updated: now }
  }

  // The question is not "did we ask for fresh IDs?" but "can this payload land
  // on something that already exists?" — and those differ.
  //
  // `regenerateIds` only rewrites UUID-shaped strings, deliberately, so that it
  // can't mangle a field that merely looks like an ID. An ID that isn't a UUID
  // therefore survives regeneration untouched, and asking for fresh IDs
  // silently gets you the original one. Keying off `options.freshIds` skipped
  // the collision check for exactly those payloads, which is the case where it
  // was needed most: a non-UUID ID is far more likely to be a hand-written or
  // templated value that several imports share.
  //
  // So compare what came out against what went in. If the root ID survived,
  // this import can overwrite whatever holds that ID, however it got there.
  if (payload.ID && payload.ID === championship.ID) {
    await assertTargetSafeToOverwrite(session, payload.ID, options.allowOverwrite === true)
  }

  const mechanism = options.mechanism ?? (await detectImportMechanism(session))
  const json = JSON.stringify(payload)

  const res =
    mechanism.kind === "file"
      ? await session.postMultipart(IMPORT_PATH, mechanism.field, "championship.json", json)
      : await session.postForm(IMPORT_PATH, [{ name: mechanism.field, value: json }])

  const championshipId = championshipIdFromRedirect(res)
  if (!championshipId) {
    // ACSM redirects to the new championship on success. Anything else means
    // it rejected the JSON and re-rendered the page with an error flash, which
    // is a 200 — so there's no status code to go on.
    throw new AcsmWriteError(
      `ACSM didn't accept the championship (HTTP ${res.status}, no redirect). ` +
        `It was sent as ${mechanism.kind === "file" ? `a file part named ${mechanism.field}` : `form field ${mechanism.field}`}. ` +
        `ACSM reports import failures as "Check your JSON formatting" rather than in the response.`,
      res.status,
      IMPORT_PATH,
    )
  }

  return { championshipId, sent: payload, mechanism }
}

/**
 * The other half of plan §3.2, and the half that actually protects a season.
 *
 * `assertNoResults` inspects the payload, which says nothing about what is
 * already on the server. A results-free championship carrying a live
 * championship's ID would sail through it and overwrite three weeks of racing.
 * So before an import that can land on an existing ID, fetch the target and
 * check *its* results.
 *
 * Read through the **session**, not an AcsmReader. The session is by
 * definition the server about to be written to and it does not cache. A reader
 * is none of those things: HttpAcsmReader serves from a several-minute
 * response cache, StaticAcsmReader answers from a fixture, and either can be
 * pointed at a different host entirely. A guard that decides "no results" from
 * a stale or unrelated copy is worse than no guard, because it reads as one.
 *
 * `allowOverwrite` relaxes "something is already there". It does not relax
 * "that something has results" — nothing does. If you genuinely need to replace
 * a championship that has been raced, delete it in ACSM first, where the
 * confirmation is a human's problem rather than a flag.
 */
async function assertTargetSafeToOverwrite(
  session: AcsmSession,
  id: string,
  allowOverwrite: boolean,
): Promise<void> {
  let target: Championship
  try {
    target = await session.getJson<Championship>(exportPath(id))
  } catch (e) {
    const status = e instanceof AcsmWriteError ? e.status : undefined
    if (status === 404) return // Nothing there; nothing to protect.
    // Anything else is inconclusive, and an inconclusive answer must not
    // authorise the write this check exists to prevent.
    throw new AcsmWriteError(
      `Couldn't read championship ${id} to check whether importing would destroy it, so the ` +
        `import is refused. Retry once the server is reachable. (Leaving freshIds on — the ` +
        `default — sidesteps this entirely.)`,
      status,
    )
  }

  // `getJson` casts the parsed body; it does not validate it. A 200 carrying
  // `null`, `{}`, an error envelope, or anything else that parses would arrive
  // at `startedRounds` as a championship with no events — which reads as "no
  // results", the single answer that lets `allowOverwrite` go ahead. Fetching
  // the wrong thing must not be able to authorise the destructive write this
  // function exists to prevent, so the response has to identify itself as the
  // championship that was asked for first.
  const targetId = isRecord(target) ? target["ID"] : undefined
  if (typeof targetId !== "string" || !sameChampionshipId(targetId, id)) {
    throw new AcsmWriteError(
      `Reading championship ${id} to check whether importing would destroy it returned ` +
        `${describeUnidentifiedExport(target, targetId)}. champctl can't tell what is on the ` +
        `server, so the import is refused. (Leaving freshIds on — the default — sidesteps this.)`,
    )
  }

  const started = startedRounds(target)
  if (started.length > 0) {
    throw new AcsmWriteError(
      `Championship ${id} on the server has results for ${
        started.length === 1 ? "round" : "rounds"
      } ${started.join(", ")}. Importing over it would destroy them. Delete it in ACSM first ` +
        `if that is really what you want.`,
    )
  }

  if (!allowOverwrite) {
    throw new AcsmWriteError(
      `Championship ${id} already exists on this server. It has no results, so overwriting it ` +
        `is recoverable — pass allowOverwrite if that's the intent, or leave freshIds on to ` +
        `import a copy instead.`,
    )
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * ACSM's IDs are UUIDs, which it renders lower-case but which arrive here from
 * whatever the caller typed. Compare case-insensitively so a hand-pasted
 * upper-case ID doesn't fail the identity check and read as a server problem.
 */
function sameChampionshipId(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** Names what came back instead, so the refusal is diagnosable. */
function describeUnidentifiedExport(target: unknown, targetId: unknown): string {
  if (target === null) return "JSON null rather than a championship"
  if (Array.isArray(target)) return "a JSON array rather than a championship"
  if (!isRecord(target)) return `a bare JSON ${typeof target} rather than a championship`
  if (targetId === undefined) return "an object with no ID field, so it isn't a championship export"
  if (typeof targetId !== "string") return `an ID that is a ${typeof targetId}, not a string`
  return `a different championship (${targetId})`
}

/**
 * The hard rule from plan §3.2: never import over a championship that has any
 * event with a non-zero `StartedTime`.
 */
export function assertNoResults(championship: Championship): void {
  const started = events(championship)
    .map((ev, i) => ({ ev, round: i + 1 }))
    .filter(({ ev }) => eventHasStarted(ev))
  if (started.length === 0) return

  const rounds = started.map(({ round }) => round).join(", ")
  throw new AcsmWriteError(
    `Refusing to import: ${started.length === 1 ? "round" : "rounds"} ${rounds} already ` +
      `${started.length === 1 ? "has" : "have"} results. Importing over a championship with ` +
      `results destroys them.`,
  )
}

/**
 * ACSM redirects to `/championship/{id}` after a successful import.
 *
 * The status check is the load-bearing part. A *rejected* import is a 200
 * carrying the import page re-rendered with an error flash — there is no error
 * status to go on — so "did it redirect?" is the entire success signal. Reading
 * the header without checking the status means any 200 that happens to carry a
 * `Location` (a proxy, a framework, an ACSM build that sets one on error) gets
 * reported as a successful import, which is precisely the failure this function
 * exists to detect.
 */
export function championshipIdFromRedirect(res: Response): string | undefined {
  if (!isRedirectStatus(res.status)) return undefined
  const location = res.headers.get("location")
  if (!location) return undefined
  const m = /\/championship\/([0-9a-f-]{36})/i.exec(location)
  return m?.[1]
}

/** True when this export is safe to hand to `importChampionship`. */
export function isSafeToImport(championship: Championship): boolean {
  try {
    assertNoResults(championship)
    return true
  } catch {
    return false
  }
}

/** Rounds that already have results, for a UI to explain a refusal. */
export function startedRounds(championship: Championship): number[] {
  return events(championship)
    .map((ev, i) => (eventHasStarted(ev) ? i + 1 : 0))
    .filter((n) => n > 0)
}

export { isZeroTime }
