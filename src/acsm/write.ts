/**
 * Write operations against ACSM, with the rules that stop them destroying data.
 *
 * Two of these are hard refusals rather than warnings, per plan §3.2 and §5.4.
 * Losing three weeks of results to a convenience feature is the worst outcome
 * this tool can produce, so the checks live here — below any UI, on the path
 * every caller has to take.
 */

import { randomUUID } from "node:crypto"

import { AcsmError, type AcsmReader } from "./client.js"
import { findFormByAction } from "./form.js"
import { AcsmWriteError, type AcsmSession } from "./session.js"
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
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) ids.add(m[1]!.toLowerCase())
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
      for (const [k, val] of Object.entries(v)) out[k] = walk(val)
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
export type ImportMechanism =
  | { kind: "textarea"; field: string }
  | { kind: "file"; field: string }

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
   * Allow importing over an ID that already exists on the server. Default
   * false. Even when true, a championship with results is still refused.
   */
  allowOverwrite?: boolean
  /**
   * Reader used to check whether the ID already exists. Optional: without one
   * the collision check is skipped and only the local results check applies.
   */
  reader?: AcsmReader
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
  championshipId: string | undefined
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

  let payload: Championship = options.freshIds === false ? championship : regenerateIds(championship)

  if (options.stampCreated !== false) {
    const now = (options.now ?? new Date()).toISOString()
    payload = { ...payload, Created: now, Updated: now }
  }

  if (payload.ID && options.allowOverwrite !== true && options.reader) {
    const existing = await idExists(options.reader, payload.ID)
    if (existing === "yes") {
      throw new AcsmWriteError(
        `Championship ${payload.ID} already exists on this server. Importing would overwrite it; ` +
          `generate fresh IDs or pass allowOverwrite.`,
      )
    }
    if (existing === "unknown") {
      // Fail closed. The check exists to stop an overwrite, so an inconclusive
      // answer has to block — treating it as "free" would let a network blip
      // authorise the thing the check is here to prevent.
      throw new AcsmWriteError(
        `Couldn't determine whether championship ${payload.ID} already exists, so the import is ` +
          `refused rather than risk overwriting it. Retry, or pass allowOverwrite if you're sure. ` +
          `(Leaving freshIds on — the default — sidesteps this entirely.)`,
      )
    }
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
 * Whether a championship ID is already on the server.
 *
 * Deliberately three-valued. Swallowing errors and returning false would turn
 * a network blip into "that ID is free", and the caller's next move is an
 * import that overwrites a live championship — the exact outcome the plan calls
 * the worst thing this tool can do. So "couldn't tell" is its own answer and
 * the caller refuses on it.
 */
type Existence = "yes" | "no" | "unknown"

async function idExists(reader: AcsmReader, id: string): Promise<Existence> {
  try {
    const list = await reader.listChampionships()
    return list.some((c) => c.ID === id) ? "yes" : "no"
  } catch {
    // A build without the list endpoint (docs/acsm-write-path.md §6) can't
    // answer that way. Ask for the export instead.
  }

  try {
    await reader.exportChampionship(id)
    return "yes"
  } catch (e) {
    // Only a 404 means the championship isn't there. A 401, a 500, a timeout
    // or a DNS failure all mean we don't know, and must not read as "free".
    const status = e instanceof AcsmError ? e.status : undefined
    return status === 404 ? "no" : "unknown"
  }
}

/** ACSM redirects to `/championship/{id}` after a successful import. */
export function championshipIdFromRedirect(res: Response): string | undefined {
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
