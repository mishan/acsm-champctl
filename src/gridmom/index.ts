/**
 * gridmom — championship sanity checker (plan §6).
 *
 * A pure function from a championship export (plus the track pit table and the
 * league baseline) to a list of findings. No network, no side effects. That is
 * what lets the same code run inline in the web UI before a push, on demand
 * from the CLI, and nightly from the bot.
 */

import type { Championship } from "../acsm/types.js"
import type { ContentIndex } from "../content/index.js"
import { EMPTY_PIT_TABLE, type PitTable } from "../pits/table.js"
import type { LeagueProfile } from "../profile/types.js"
import { collect, type Check, type CheckContext } from "./context.js"
import {
  blocksPush,
  countBySeverity,
  sortFindings,
  type CheckReport,
  type Finding,
} from "./finding.js"

import { championshipChecks } from "./checks/championship.js"
import { contentChecks } from "./checks/content.js"
import { entryChecks } from "./checks/entry.js"
import { formatChecks } from "./checks/format.js"
import { scheduleChecks } from "./checks/schedule.js"

/** Every check, in report order. */
export const ALL_CHECKS: readonly Check[] = [
  ...entryChecks,
  ...scheduleChecks,
  ...formatChecks,
  ...contentChecks,
  ...championshipChecks,
]

export interface CheckOptions {
  pits?: PitTable
  content?: ContentIndex
  /** Injected so time-dependent checks are deterministic under test. */
  now?: Date
  /** Finding codes to drop, e.g. a league that genuinely runs a track twice. */
  suppress?: readonly string[]
  /** Subset of checks to run. Defaults to ALL_CHECKS. */
  checks?: readonly Check[]
}

export function check(
  championship: Championship,
  profile: LeagueProfile,
  options: CheckOptions = {},
): CheckReport {
  const ctx: CheckContext = {
    championship,
    profile,
    pits: options.pits ?? EMPTY_PIT_TABLE,
    now: options.now ?? new Date(),
    content: options.content,
  }

  const suppressed = new Set(options.suppress ?? [])
  const findings = sortFindings(
    collect(ctx, options.checks ?? ALL_CHECKS).filter((f) => !isSuppressed(f, suppressed)),
  )

  const report: CheckReport = {
    findings,
    counts: countBySeverity(findings),
    ok: !blocksPush(findings),
  }
  if (championship.ID) report.championshipId = championship.ID
  if (championship.Name) report.championshipName = championship.Name
  return report
}

/** Suppression matches a code exactly or by dotted prefix (`entry` hides all). */
function isSuppressed(f: Finding, suppressed: ReadonlySet<string>): boolean {
  if (suppressed.size === 0) return false
  if (suppressed.has(f.code)) return true
  const parts = f.code.split(".")
  for (let i = 1; i < parts.length; i++) {
    if (suppressed.has(parts.slice(0, i).join("."))) return true
  }
  return false
}

export type { Check, CheckContext } from "./context.js"
export {
  Severity,
  blocksPush,
  humanList,
  sortFindings,
  type CheckReport,
  type Finding,
  type FindingLocation,
} from "./finding.js"
