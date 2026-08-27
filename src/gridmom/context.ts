/**
 * The single argument every check receives.
 *
 * The checker is a pure function of these inputs — no network, no clock reads
 * beyond `now`, no side effects (plan §6). That is what lets it run inline in
 * the web UI before a push, on demand from the CLI, and nightly from the bot.
 */

import type { Championship } from "../acsm/types.js"
import type { TrackLayouts } from "../acsm/content.js"
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
  /**
   * Which layouts each track has, when something has been able to read them.
   *
   * A track with no layout to choose has no entry — see `acsm/content.ts`. Its
   * own field rather than part of `content` because it comes from somewhere
   * else and costs something else: ACSM lists layouts on exactly one page, an
   * event edit form, and that page needs a login.
   *
   * `undefined` and `null` both mean "nobody could tell me", and the layout
   * checks skip. That distinction matters on the wire, where `null` says the
   * read was attempted and failed; here there is nothing to do about either.
   */
  layouts?: TrackLayouts | null | undefined
}

/** Convenience emitter handed to each check, so checks stay declarative. */
export type Emit = (
  severity: Severity,
  code: string,
  message: string,
  location?: FindingLocation,
  data?: Record<string, unknown>,
) => void

export interface Check {
  /** Namespaced id prefix for the findings this check emits, e.g. `entry`. */
  id: string
  /** Plan section this implements, for traceability. */
  section: string
  run(ctx: CheckContext, emit: Emit): void
}

export function collect(ctx: CheckContext, checks: readonly Check[]): Finding[] {
  const findings: Finding[] = []
  // Which check is currently running, so every finding it emits can say where
  // it came from. `--suppress` needs that: a check's id is not always one of
  // the codes it emits.
  let running = ""
  const emit: Emit = (severity, code, message, location, data) => {
    const f: Finding = { code, severity, message }
    if (running) f.checkId = running
    if (location) f.location = location
    if (data) f.data = data
    findings.push(f)
  }
  for (const check of checks) {
    running = check.id
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
