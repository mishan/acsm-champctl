/**
 * The nightly gridmom report (plan §6.6).
 *
 * Walk every championship on the league's manager, check each one, and hand
 * back what is worth saying. No Discord types anywhere in here: this module
 * turns a server into a list of reports, `message.ts` turns reports into
 * messages, and `transport.ts` posts them. Each of the three is testable on its
 * own, and only the last one needs a token.
 *
 * **Read-only by construction.** This imports `AcsmReader`, which has no
 * credentials and no write methods — the same property that makes the archive
 * safe to point at a production manager on a schedule. `test/bot.test.ts`
 * asserts that nothing under `src/bot/` reaches the write path, because "the
 * bot never holds write credentials" (plan §7) is a promise that has to be
 * enforced by something other than everyone remembering it.
 */

import type { AcsmReader } from "../acsm/client.js"
import { asMessage } from "../acsm/client.js"
import type { Championship } from "../acsm/types.js"
import { eventHasStarted, events } from "../acsm/view.js"
import { check } from "../gridmom/index.js"
import { Severity, type CheckReport } from "../gridmom/finding.js"
import { DEFAULT_MIN_SEVERITY, filterBySeverity } from "../gridmom/report.js"
import type { PitTable } from "../pits/table.js"
import type { LeagueProfile } from "../profile/types.js"

export interface NightlyOptions {
  profile: LeagueProfile
  pits?: PitTable
  /** Injected so the schedule checks are deterministic under test. */
  now?: Date
  suppress?: readonly string[]
  /** Include championships whose every round has been raced. Off by default. */
  includeFinished?: boolean
  /** Called per championship as the walk goes, for CLI progress output. */
  onProgress?: (entry: NightlyEntry) => void
}

export type NightlyEntry =
  | { kind: "checked"; championshipId: string; name?: string; report: CheckReport }
  | { kind: "finished"; championshipId: string; name?: string }
  | { kind: "failed"; championshipId: string; name?: string; error: string }

export interface NightlyReport {
  entries: NightlyEntry[]
  checked: number
  finished: number
  failed: number
}

/**
 * True once every round has been raced.
 *
 * Skipped by default, and this is the check that decides whether the report is
 * worth reading. A finding about a championship that is over cannot be acted
 * on — the duplicate pit boxes at Suzuka already dropped whoever they dropped —
 * so posting it says nothing except "here I am again", every night, for as long
 * as the league keeps its history. That is precisely how a report gets muted,
 * and a muted report is worth less than no report, because everyone believes
 * it is still watching.
 *
 * A championship with no events at all is *not* finished. `[].every()` is true,
 * which would have quietly excused the one case most likely to be a mistake
 * someone just made: a championship created ten minutes ago with nothing in it.
 */
export function isFinished(c: Championship): boolean {
  const rounds = events(c)
  return rounds.length > 0 && rounds.every((ev) => eventHasStarted(ev))
}

/** Findings at or above `min`, across every championship that was checked. */
export function findingsAtOrAbove(
  report: NightlyReport,
  min: Severity = DEFAULT_MIN_SEVERITY,
): Record<Severity, number> {
  const counts: Record<Severity, number> = { ERROR: 0, WARN: 0, INFO: 0 }
  for (const entry of report.entries) {
    if (entry.kind !== "checked") continue
    for (const f of filterBySeverity(entry.report.findings, min)) counts[f.severity]++
  }
  return counts
}

/**
 * Checks every championship on the server.
 *
 * One championship failing never aborts the rest, which is the archive's rule
 * and holds here for the same reason: a nightly job that gives up on the first
 * timeout reports nothing about the twelve championships it had not reached
 * yet, and the one it choked on is usually the one that has been deleted.
 */
export async function nightly(reader: AcsmReader, options: NightlyOptions): Promise<NightlyReport> {
  const summaries = await reader.listChampionships()
  const entries: NightlyEntry[] = []

  const record = (entry: NightlyEntry): void => {
    entries.push(entry)
    options.onProgress?.(entry)
  }

  for (const summary of summaries) {
    const id = summary.ID
    if (!id) {
      // Not silently skipped. An entry with no id is a championship this run
      // could not look at, and counting it as nothing would let a listing that
      // changed shape read as a clean night. See `summaries()` in the reader,
      // where exactly that happened once.
      record({
        kind: "failed",
        championshipId: "?",
        error: "Championship list entry had no ID field",
        ...(summary.Name === undefined ? {} : { name: summary.Name }),
      })
      continue
    }

    const listedName = summary.Name

    let championship: Championship
    try {
      championship = await reader.exportChampionship(id)
    } catch (e) {
      record({
        kind: "failed",
        championshipId: id,
        error: asMessage(e),
        ...(listedName === undefined ? {} : { name: listedName }),
      })
      continue
    }

    // The export's name beats the listing's: the listing is sometimes a scrape
    // of a page that gives ids and nothing else.
    const name = championship.Name ?? listedName
    const named = name === undefined ? {} : { name }

    if (!options.includeFinished && isFinished(championship)) {
      record({ kind: "finished", championshipId: id, ...named })
      continue
    }

    record({
      kind: "checked",
      championshipId: id,
      ...named,
      report: check(championship, options.profile, {
        ...(options.pits ? { pits: options.pits } : {}),
        ...(options.suppress ? { suppress: options.suppress } : {}),
        ...(options.now ? { now: options.now } : {}),
      }),
    })
  }

  return {
    entries,
    checked: entries.filter((e) => e.kind === "checked").length,
    finished: entries.filter((e) => e.kind === "finished").length,
    failed: entries.filter((e) => e.kind === "failed").length,
  }
}
