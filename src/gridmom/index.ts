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

/**
 * Whether a finding was asked to be hidden.
 *
 * Matches the emitted code, any dotted prefix of it, and the id of the check
 * that produced it. That last one is not decoration: `champ.acsr` emits
 * `champ.acsr-export` and `champ.acsr-gates`, and `champ.empty` emits
 * `champ.no-events` and `champ.no-entrants`. Those are *siblings* of the check
 * id, not dotted children, so prefix matching never reached them and
 * `--suppress champ.acsr` silently did nothing — leaving a league to discover
 * an emitted code that appears in no list champctl prints.
 */
function isSuppressed(f: Finding, suppressed: ReadonlySet<string>): boolean {
  if (suppressed.size === 0) return false
  return matchesId(f.code, suppressed) || matchesId(f.checkId, suppressed)
}

function matchesId(id: string | undefined, suppressed: ReadonlySet<string>): boolean {
  if (id === undefined) return false
  if (suppressed.has(id)) return true
  const parts = id.split(".")
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
