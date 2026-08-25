/**
 * Findings model (plan §6).
 *
 * gridmom is nagging, specific, never mean. `message` is one plain sentence
 * naming the thing and where it is, with no severity jargon — it is written to
 * be readable verbatim in Discord. Severity lives in the model, not the prose.
 */

export const Severity = {
  ERROR: "ERROR",
  WARN: "WARN",
  INFO: "INFO",
} as const
export type Severity = (typeof Severity)[keyof typeof Severity]

/** Descending order of seriousness. Used for sorting and exit codes. */
export const SEVERITY_ORDER: readonly Severity[] = [Severity.ERROR, Severity.WARN, Severity.INFO]

const SEVERITY_RANK: Record<Severity, number> = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
}

/** Where in the championship a finding applies. */
export interface FindingLocation {
  /** 1-based round number, when the finding belongs to an event. */
  round?: number
  /** Human label, e.g. `suzuka` or `ks_silverstone/international`. */
  event?: string
  /** Class name, when the finding belongs to a championship class. */
  className?: string
  /** Dotted-ish path into the export, e.g. `Events[0].EntryList.CAR_3`. */
  path?: string
}

/**
 * The locale every message renders in.
 *
 * The prose around a date is English, so the date has to be too. Luxon
 * otherwise formats through the host's `Intl`, which turns one sentence into
 * "round 1 is on Mittwoch" under `LANG=de_DE` — and makes a test asserting
 * "Thursday" pass in CI and fail on someone's laptop.
 *
 * Applied per `DateTime` rather than through `Settings.defaultLocale`, which
 * is process-global: gridmom is a library that runs inside someone else's
 * program, and reaching into Luxon's globals is not its business.
 */
export const MESSAGE_LOCALE = "en"

export interface Finding {
  /** Stable machine id, e.g. `entry.duplicate-pit-box`. Safe to suppress on. */
  code: string
  /**
   * The check that produced it, e.g. `champ.acsr`.
   *
   * Not always the same as `code`, which is the point: one check can emit
   * several codes, and `champ.acsr` emits `champ.acsr-export` and
   * `champ.acsr-gates`. Those are *siblings* of the check id rather than
   * dotted children, so `--suppress champ.acsr` matched neither and a league
   * had to know an emitted code that appears nowhere in the check list.
   */
  checkId?: string
  severity: Severity
  /** One plain sentence. Discord-ready. No severity words, no jargon. */
  message: string
  location?: FindingLocation
  /** Structured payload for the UI; never required to render the message. */
  data?: Record<string, unknown>
}

export interface CheckReport {
  championshipId?: string
  championshipName?: string
  findings: Finding[]
  counts: Record<Severity, number>
  /** True when nothing blocks a push. */
  ok: boolean
}

export function countBySeverity(findings: readonly Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { ERROR: 0, WARN: 0, INFO: 0 }
  for (const f of findings) counts[f.severity]++
  return counts
}

/** ERROR blocks a push; WARN needs an acknowledgement; INFO never blocks. */
export function blocksPush(findings: readonly Finding[]): boolean {
  return findings.some((f) => f.severity === Severity.ERROR)
}

/** Sorts by severity, then round, then code — stable for diffing reports. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (a.location?.round ?? 0) - (b.location?.round ?? 0) ||
      a.code.localeCompare(b.code) ||
      a.message.localeCompare(b.message),
  )
}

/** `3, 16 and 27` — gridmom writes lists the way a person would say them. */
export function humanList(items: readonly (string | number)[]): string {
  const xs = items.map(String)
  if (xs.length === 0) return ""
  if (xs.length === 1) return xs[0]!
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]!}`
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many
}
