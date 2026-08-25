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

import { asMessage, type AcsmReader } from "../acsm/client.js"
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
    // Read defensively, because `listChampionships` only checks that the
    // response was an array. A `null` element — or a string, or a number —
    // survives that check, and `summary.ID` on it throws *here*, outside
    // `ingestOne`'s try, aborting the whole run. For a job whose contract is
    // "one bad championship never stops the rest", losing every remaining
    // championship to one malformed list entry is the wrong failure.
    const entry: { ID?: unknown; Name?: unknown } =
      summary !== null && typeof summary === "object" ? summary : {}
    const championshipId = typeof entry.ID === "string" ? entry.ID : undefined
    const name = typeof entry.Name === "string" ? entry.Name : undefined

    // A summary with no usable ID can't be fetched or filed. Report it rather
    // than dropping it silently — it means the list shape changed.
    if (!championshipId) {
      // Through onProgress like every other outcome. Pushing it to `outcomes`
      // alone would have the summary say "1 failed" while nothing on screen
      // said which one, since the non-JSON output is built from progress.
      const outcome: IngestOutcome = {
        kind: "failed",
        championshipId: "(no ID)",
        ...(name === undefined ? {} : { name }),
        error: "Championship list entry had no ID field",
      }
      outcomes.push(outcome)
      options.onProgress?.(outcome)
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
    // Not swallowed. This used to be `.catch(() => undefined)`, which reads a
    // locked or corrupt archive as "never seen before" and quietly refetches —
    // so the one signal that the archive is broken became a slightly slower
    // run that exits 0. `read`'s own contract is that it distinguishes absent
    // from unreadable, and catching everything here threw that away.
    let existing: Awaited<ReturnType<ArchiveStore["read"]>>
    try {
      existing = await store.read(championshipId)
    } catch (e) {
      throw new IngestError(
        `Couldn't read the archive for ${championshipId}, so --since can't tell what is ` +
          `already stored: ${asMessage(e)}`,
      )
    }
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

  // Only the *export* is caught. A championship ACSM won't serve is one bad
  // championship, and the run should carry on and report it — that is the
  // point of a nightly job. A championship the archive won't store is a broken
  // archive: disk full, database corrupt, lock timeout. Those were caught here
  // too and downgraded to a per-championship failure, so a full disk exited 2
  // ("some championships failed") rather than the documented 3 ("the run
  // failed"), and a cron job watching exit codes would keep going all week.
  let body: Buffer
  try {
    body = await reader.exportChampionshipRaw(championshipId)
  } catch (e) {
    return { kind: "failed", championshipId, ...named, error: asMessage(e) }
  }

  // IngestError rather than a bare throw, because that is the type the CLI
  // maps to the documented exit 3. Letting the raw error escape got the
  // *scope* right — a broken archive fails the run, not a championship — and
  // the exit code wrong, which is the half a cron job actually reads.
  let result: StoreResult
  try {
    result = await store.put(championshipId, body, now(), name)
  } catch (e) {
    throw new IngestError(
      `Couldn't write ${championshipId} to the archive, so the run stopped rather than ` +
        `reporting a clean night: ${asMessage(e)}`,
    )
  }

  return result.stored
    ? { kind: "stored", championshipId, ...named, result }
    : { kind: "unchanged", championshipId, ...named, result }
}
