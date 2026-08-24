/**
 * Track pit counts (plan §4.5).
 *
 * The tool runs off-host, so `content/tracks/*​/ui/*​/ui_track.json` isn't
 * reachable. Counts come from three sources and `manual` always wins, because
 * mod tracks routinely lie in their ui file.
 *
 * This is the JSON-file implementation. When the archive gains SQLite, add a
 * table-backed `PitTable` behind the same interface — nothing else changes.
 */

import { readFile } from "node:fs/promises"

/** Ordered worst-to-best. Later sources override earlier ones. */
export const PIT_SOURCES = ["acsm", "scan", "manual"] as const
export type PitSource = (typeof PIT_SOURCES)[number]

const SOURCE_RANK: Record<PitSource, number> = {
  acsm: 0,
  scan: 1,
  manual: 2,
}

export interface PitRecord {
  track: string
  /** Empty string for a track with no separate layout. */
  layout: string
  pitboxes: number
  source: PitSource
  /** ISO timestamp. Absent means never verified — the checker warns on that. */
  verifiedAt?: string
}

export interface PitTable {
  /** Best available record, or undefined when the track is unknown. */
  get(track: string, layout?: string): PitRecord | undefined
}

/** `track/layout`, or just `track` when there is no layout. */
export function pitKey(track: string, layout?: string): string {
  const t = (track ?? "").trim()
  const l = (layout ?? "").trim()
  return l ? `${t}/${l}` : t
}

export class InMemoryPitTable implements PitTable {
  readonly #byKey = new Map<string, PitRecord>()

  constructor(records: Iterable<PitRecord> = []) {
    for (const r of records) this.add(r)
  }

  /** Adds a record, keeping the higher-precedence source on conflict. */
  add(record: PitRecord): void {
    const key = pitKey(record.track, record.layout)
    const existing = this.#byKey.get(key)
    if (existing && SOURCE_RANK[existing.source] > SOURCE_RANK[record.source]) return
    this.#byKey.set(key, record)
  }

  get(track: string, layout?: string): PitRecord | undefined {
    const exact = this.#byKey.get(pitKey(track, layout))
    if (exact) return exact
    // A track with layouts may still have a whole-track entry, which is a
    // reasonable fallback but never as good as a layout-specific one.
    if ((layout ?? "").trim()) return this.#byKey.get(pitKey(track))
    return undefined
  }

  get size(): number {
    return this.#byKey.size
  }

  toJSON(): PitRecord[] {
    return [...this.#byKey.values()].sort((a, b) =>
      pitKey(a.track, a.layout).localeCompare(pitKey(b.track, b.layout)),
    )
  }
}

/** An empty table. Every pit-count check degrades to a WARN, never a crash. */
export const EMPTY_PIT_TABLE: PitTable = new InMemoryPitTable()

export async function loadPitTable(path: string): Promise<InMemoryPitTable> {
  const raw = await readFile(path, "utf8")
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) {
    throw new Error(`Pit table at ${path} must be a JSON array of records`)
  }
  return new InMemoryPitTable(parsed.map((r, i) => coerceRecord(r, `${path}[${i}]`)))
}

function coerceRecord(v: unknown, where: string): PitRecord {
  if (typeof v !== "object" || v === null) {
    throw new Error(`${where}: expected an object`)
  }
  const r = v as Record<string, unknown>
  const track = typeof r["track"] === "string" ? r["track"].trim() : ""
  if (!track) throw new Error(`${where}: missing \`track\``)
  const pitboxes = r["pitboxes"]
  if (typeof pitboxes !== "number" || !Number.isInteger(pitboxes) || pitboxes < 0) {
    throw new Error(`${where}: \`pitboxes\` must be a non-negative integer`)
  }
  const source = r["source"]
  if (typeof source !== "string" || !(PIT_SOURCES as readonly string[]).includes(source)) {
    throw new Error(`${where}: \`source\` must be one of ${PIT_SOURCES.join(", ")}`)
  }
  const record: PitRecord = {
    track,
    layout: typeof r["layout"] === "string" ? r["layout"].trim() : "",
    pitboxes,
    source: source as PitSource,
  }
  if (typeof r["verifiedAt"] === "string") record.verifiedAt = r["verifiedAt"]
  return record
}
