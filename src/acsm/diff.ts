/**
 * Structural diff over championship JSON.
 *
 * Used for the round-trip regression test (plan §4.1): ingest a real export,
 * re-emit with no overrides, diff. Should be identical modulo the fields ACSM
 * rewrites on import. When an upgrade changes the schema, this says so before a
 * Wednesday does.
 *
 * Also used for the finalize flow's "exactly which fields change, old → new"
 * preview, so the output has to be readable, not just correct.
 */

export interface Change {
  /** Dotted path, e.g. `Events[0].RaceSetup.MaxClients`. */
  path: string
  kind: "added" | "removed" | "changed"
  before?: unknown
  after?: unknown
}

export interface DiffOptions {
  /**
   * Paths to ignore.
   *
   * A pattern with no `*` matches that path and everything under it, so
   * `SignUpForm` also hides `SignUpForm.Responses[0].GUID`.
   *
   * A `*` matches one path segment, not across `.` or `[]`, so
   * `Events[*].ScheduledServerID` covers every event and `Events[*]` covers
   * every event entirely. Note a bare field name only matches at the root —
   * `ScheduledServerID` will not match `Events[0].ScheduledServerID`.
   */
  ignore?: readonly string[]
  /**
   * Treat a zero value that came back absent as unchanged.
   *
   * Most of ACSM's struct is tagged `json:",omitempty"`, so sending
   * `Sessions: {}` or `ExportSecondRaceToACSR: false` and getting nothing back
   * means the value survived — Go just didn't serialise it. Without this the
   * round-trip report is mostly noise.
   *
   * Note it only forgives *zero* values. A non-empty string disappearing is
   * still reported, which is how the missing `Description` field showed up.
   */
  omitEmpty?: boolean
  /**
   * Compare timestamp-shaped strings as instants rather than text.
   *
   * Go trims trailing zeros from fractional seconds, so a `Created` of
   * `...58.140Z` comes back as `...58.14Z`. Same moment, different bytes.
   */
  timestampsAsInstants?: boolean
}

/** Go omits these from JSON when a field is tagged `omitempty`. */
function isGoZeroValue(v: unknown): boolean {
  if (v === null || v === undefined) return true
  if (v === false || v === 0 || v === "") return true
  if (Array.isArray(v)) return v.length === 0
  if (isPlainObject(v)) return Object.keys(v).length === 0
  return false
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/

function sameInstant(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false
  if (!TIMESTAMP.test(a) || !TIMESTAMP.test(b)) return false
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  return Number.isFinite(ta) && Number.isFinite(tb) && ta === tb
}

/**
 * ACSM housekeeping on import (plan §5.4). These are safe to ignore.
 *
 * `PracticeEntryListType` is deliberately NOT here: ACSM silently rewrote 2 to
 * 1, and allowlisting a silent value change is how the same mechanism quietly
 * changes a race later. It stays a visible diff until someone explains it.
 */
export const IMPORT_HOUSEKEEPING = [
  "Version",
  "Updated",
  // ScheduledServerID lives on the event, not the championship, so the bare
  // name matches nothing — a pattern without a wildcard is anchored at the
  // root. Both spellings are listed in case a build carries it in both places.
  "ScheduledServerID",
  "Events[*].ScheduledServerID",
] as const

export function diff(before: unknown, after: unknown, options: DiffOptions = {}): Change[] {
  const changes: Change[] = []
  const ignore = options.ignore ?? []

  const ignored = (path: string): boolean =>
    ignore.some((pattern) => matches(path, pattern))

  const walk = (a: unknown, b: unknown, path: string): void => {
    if (ignored(path)) return

    if (Object.is(a, b)) return
    if (options.timestampsAsInstants && sameInstant(a, b)) return
    // Sent a zero value, got nothing back: omitempty, not a loss.
    if (options.omitEmpty && b === undefined && isGoZeroValue(a)) return

    const aIsObj = isPlainObject(a)
    const bIsObj = isPlainObject(b)
    if (aIsObj && bIsObj) {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)])
      for (const k of [...keys].sort()) {
        const child = path ? `${path}.${k}` : k
        if (!(k in a)) {
          if (!ignored(child)) changes.push({ path: child, kind: "added", after: b[k] })
        } else if (!(k in b)) {
          if (options.omitEmpty && isGoZeroValue(a[k])) continue
          if (!ignored(child)) changes.push({ path: child, kind: "removed", before: a[k] })
        } else {
          walk(a[k], b[k], child)
        }
      }
      return
    }

    if (Array.isArray(a) && Array.isArray(b)) {
      const n = Math.max(a.length, b.length)
      for (let i = 0; i < n; i++) {
        const child = `${path}[${i}]`
        if (i >= a.length) {
          if (!ignored(child)) changes.push({ path: child, kind: "added", after: b[i] })
        } else if (i >= b.length) {
          if (!ignored(child)) changes.push({ path: child, kind: "removed", before: a[i] })
        } else {
          walk(a[i], b[i], child)
        }
      }
      return
    }

    changes.push({ path, kind: "changed", before: a, after: b })
  }

  walk(before, after, "")
  return changes
}

/**
 * Matches a path against a pattern.
 *
 * `*` inside brackets matches any array index, so `Events[*].ID` covers every
 * event. A pattern with no wildcards matches the path itself or anything below
 * it, so `Updated` also hides `Updated.Something`.
 */
function matches(path: string, pattern: string): boolean {
  if (!pattern.includes("*")) {
    return path === pattern || path.startsWith(`${pattern}.`) || path.startsWith(`${pattern}[`)
  }
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^.\\[\\]]*")
  return new RegExp(`^${source}(\\.|\\[|$)`).test(path)
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** One line per change, old → new. Readable in a terminal and in Discord. */
export function formatChanges(changes: readonly Change[], limit = 100): string {
  if (changes.length === 0) return "No differences."
  const shown = changes.slice(0, limit)
  const lines = shown.map((c) => {
    switch (c.kind) {
      case "added":
        return `+ ${c.path} = ${render(c.after)}`
      case "removed":
        return `- ${c.path} was ${render(c.before)}`
      case "changed":
        return `~ ${c.path}: ${render(c.before)} → ${render(c.after)}`
    }
  })
  if (changes.length > shown.length) {
    lines.push(`… and ${changes.length - shown.length} more`)
  }
  return lines.join("\n")
}

function render(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v)
  if (v === undefined) return "undefined"
  const s = JSON.stringify(v)
  return s !== undefined && s.length > 80 ? `${s.slice(0, 77)}…` : String(s)
}
