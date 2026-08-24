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
   * Paths to ignore. A trailing `*` matches a prefix, so `Events[*].ID` needs
   * `Events[` handling — use `wildcardPath` for index-agnostic patterns.
   */
  ignore?: readonly string[]
}

/**
 * ACSM housekeeping on import (plan §5.4). These are safe to ignore.
 *
 * `PracticeEntryListType` is deliberately NOT here: ACSM silently rewrote 2 to
 * 1, and allowlisting a silent value change is how the same mechanism quietly
 * changes a race later. It stays a visible diff until someone explains it.
 */
export const IMPORT_HOUSEKEEPING = ["Version", "Updated", "ScheduledServerID"] as const

export function diff(before: unknown, after: unknown, options: DiffOptions = {}): Change[] {
  const changes: Change[] = []
  const ignore = options.ignore ?? []

  const ignored = (path: string): boolean =>
    ignore.some((pattern) => matches(path, pattern))

  const walk = (a: unknown, b: unknown, path: string): void => {
    if (ignored(path)) return

    if (Object.is(a, b)) return

    const aIsObj = isPlainObject(a)
    const bIsObj = isPlainObject(b)
    if (aIsObj && bIsObj) {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)])
      for (const k of [...keys].sort()) {
        const child = path ? `${path}.${k}` : k
        if (!(k in a)) {
          if (!ignored(child)) changes.push({ path: child, kind: "added", after: b[k] })
        } else if (!(k in b)) {
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
