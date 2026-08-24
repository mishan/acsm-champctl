/**
 * The single argument every check receives.
 *
 * The checker is a pure function of these inputs — no network, no clock reads
 * beyond `now`, no side effects (plan §6). That is what lets it run inline in
 * the web UI before a push, on demand from the CLI, and nightly from the bot.
 */

import type { Championship } from "../acsm/types.js"
import type { ContentIndex } from "../content/index.js"
import type { PitTable } from "../pits/table.js"
import type { LeagueProfile } from "../profile/types.js"
import type { Finding, FindingLocation, Severity } from "./finding.js"

export interface CheckContext {
  championship: Championship
  pits: PitTable
  profile: LeagueProfile
  /** Injected so "scheduled in the past" is deterministic under test. */
  now: Date
  /**
   * Installed content, when something can see the server. Absent off-host,
   * in which case the content checks skip rather than guess.
   */
  content?: ContentIndex | undefined
}

/** Convenience emitter handed to each check, so checks stay declarative. */
export interface Emit {
  (
    severity: Severity,
    code: string,
    message: string,
    location?: FindingLocation,
    data?: Record<string, unknown>,
  ): void
}

export interface Check {
  /** Namespaced id prefix for the findings this check emits, e.g. `entry`. */
  id: string
  /** Plan section this implements, for traceability. */
  section: string
  run(ctx: CheckContext, emit: Emit): void
}

export function collect(ctx: CheckContext, checks: readonly Check[]): Finding[] {
  const findings: Finding[] = []
  const emit: Emit = (severity, code, message, location, data) => {
    const f: Finding = { code, severity, message }
    if (location) f.location = location
    if (data) f.data = data
    findings.push(f)
  }
  for (const check of checks) {
    try {
      check.run(ctx, emit)
    } catch (e) {
      // A malformed export must never take the whole report down; report the
      // broken check as a finding and carry on with the rest.
      emit(
        "ERROR",
        "internal.check-failed",
        `I couldn't finish the ${check.id} checks: ${e instanceof Error ? e.message : String(e)}.`,
        { path: check.id },
      )
    }
  }
  return findings
}
