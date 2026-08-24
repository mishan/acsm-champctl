/**
 * Write operations against ACSM, with the rules that stop them destroying data.
 *
 * Two of these are hard refusals rather than warnings, per plan §3.2 and §5.4.
 * Losing three weeks of results to a convenience feature is the worst outcome
 * this tool can produce, so the checks live here — below any UI, on the path
 * every caller has to take.
 */

import { randomUUID } from "node:crypto"

import type { AcsmReader } from "./client.js"
import { AcsmWriteError, type AcsmSession } from "./session.js"
import type { Championship } from "./types.js"
import { eventHasStarted, events, isZeroTime } from "./view.js"

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
  /** The file input's name on the import form. Discovered by recon. */
  fileFieldName?: string
  /** Stamp `Created` at import time rather than inheriting it (plan §5.5). */
  stampCreated?: boolean
  now?: Date
}

export interface ImportResult {
  championshipId: string | undefined
  /** The payload actually sent, so a caller can diff against the re-export. */
  sent: Championship
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
    if (existing) {
      throw new AcsmWriteError(
        `Championship ${payload.ID} already exists on this server. Importing would overwrite it; ` +
          `generate fresh IDs or pass allowOverwrite.`,
      )
    }
  }

  const res = await session.postMultipart(
    IMPORT_PATH,
    options.fileFieldName ?? "championshipFile",
    "championship.json",
    JSON.stringify(payload),
  )

  return { championshipId: championshipIdFromRedirect(res), sent: payload }
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

async function idExists(reader: AcsmReader, id: string): Promise<boolean> {
  try {
    const list = await reader.listChampionships()
    return list.some((c) => c.ID === id)
  } catch {
    // A build without the list endpoint (see docs/acsm-write-path.md §6) can't
    // answer this. Fall back to asking for the export directly.
    try {
      await reader.exportChampionship(id)
      return true
    } catch {
      return false
    }
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
