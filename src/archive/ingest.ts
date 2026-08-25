/**
 * The ingest run (plan §8.1): walk the championship list, fetch every export,
 * store the raw body.
 *
 * Read-only by construction. This takes an `AcsmReader`, which has no
 * credentials and no write methods, so no amount of getting this wrong can
 * modify a championship. That is the reason the archive is the one job safe to
 * point at a league's production manager on a schedule.
 *
 * The run is *partially failing by design*. One championship that 404s or
 * returns garbage must not cost you the other thirty — the whole point is that
 * every night it runs, the archive gets no worse. Failures are collected and
 * reported; they don't abort.
 */

import type { AcsmReader } from "../acsm/client.js"
import type { ArchiveStore, StoreResult } from "./store.js"

export interface IngestOptions {
  /**
   * Injectable for tests only. There is deliberately no `--now` flag, unlike
   * gridmom's: a snapshot's `fetchedAt` records when the bytes were actually
   * fetched, and an option to lie about that would corrupt the one thing the
   * archive exists to be trusted on. gridmom has `--now` because its schedule
   * checks reason about the future; nothing here does.
   */
  now?: () => Date
  /** Called as each championship resolves, for progress output. */
  onProgress?: (outcome: IngestOutcome) => void
  /** Skip championships already checked since this time. */
  skipCheckedSince?: Date
}

export type IngestOutcome =
  | { kind: "stored"; championshipId: string; name?: string; result: StoreResult }
  | { kind: "unchanged"; championshipId: string; name?: string; result: StoreResult }
  | { kind: "skipped"; championshipId: string; name?: string; reason: string }
  | { kind: "failed"; championshipId: string; name?: string; error: string }

export interface IngestReport {
  startedAt: string
  finishedAt: string
  outcomes: IngestOutcome[]
  stored: number
  unchanged: number
  skipped: number
  failed: number
}

export class IngestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "IngestError"
  }
}

export async function ingest(
  reader: AcsmReader,
  store: ArchiveStore,
  options: IngestOptions = {},
): Promise<IngestReport> {
  const now = options.now ?? (() => new Date())
  const startedAt = now().toISOString()

  // The list is the one call with no useful partial answer: without it there
  // is nothing to iterate, so this failure is fatal where the others aren't.
  let summaries: Awaited<ReturnType<AcsmReader["listChampionships"]>>
  try {
    summaries = await reader.listChampionships()
  } catch (e) {
    throw new IngestError(
      `Couldn't list championships, so there is nothing to archive: ${asMessage(e)}`,
    )
  }

  const outcomes: IngestOutcome[] = []
  const seen = new Set<string>()

  for (const summary of summaries) {
    const championshipId = summary.ID
    const name = summary.Name

    // A summary with no ID can't be fetched or filed. Report it rather than
    // dropping it silently — it means the list shape changed.
    if (!championshipId) {
      outcomes.push({
        kind: "failed",
        championshipId: "(no ID)",
        ...(name === undefined ? {} : { name }),
        error: "Championship list entry had no ID field",
      })
      continue
    }

    // ACSM has been known to list a championship twice across pages. Fetching
    // it twice would write two snapshots a second apart, the second of which
    // dedupes to nothing — harmless, but it makes the report lie about how
    // many championships there are.
    if (seen.has(championshipId)) continue
    seen.add(championshipId)

    const outcome = await ingestOne(reader, store, championshipId, name, now, options)
    outcomes.push(outcome)
    options.onProgress?.(outcome)
  }

  const count = (kind: IngestOutcome["kind"]): number =>
    outcomes.filter((o) => o.kind === kind).length

  return {
    startedAt,
    finishedAt: now().toISOString(),
    outcomes,
    stored: count("stored"),
    unchanged: count("unchanged"),
    skipped: count("skipped"),
    failed: count("failed"),
  }
}

async function ingestOne(
  reader: AcsmReader,
  store: ArchiveStore,
  championshipId: string,
  name: string | undefined,
  now: () => Date,
  options: IngestOptions,
): Promise<IngestOutcome> {
  const named = name === undefined ? {} : { name }

  if (options.skipCheckedSince) {
    const existing = await store.read(championshipId).catch(() => undefined)
    const last = existing?.lastCheckedAt
    if (last && new Date(last) >= options.skipCheckedSince) {
      return {
        kind: "skipped",
        championshipId,
        ...named,
        reason: `already checked at ${last}`,
      }
    }
  }

  try {
    const body = await reader.exportChampionshipRaw(championshipId)
    const result = await store.put(championshipId, body, now(), name)
    return result.stored
      ? { kind: "stored", championshipId, ...named, result }
      : { kind: "unchanged", championshipId, ...named, result }
  } catch (e) {
    return { kind: "failed", championshipId, ...named, error: asMessage(e) }
  }
}

function asMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
