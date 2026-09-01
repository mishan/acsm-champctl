/**
 * Report formatters.
 *
 * The Discord format carries no severity jargon at all (plan §6) — findings
 * read as one plain sentence each, because a report people mute is worth
 * nothing. The text format is for a terminal and may be more explicit.
 */

import { Severity, type CheckReport, type Finding } from "./finding.js"

export type ReportFormat = "text" | "json" | "discord"

/**
 * What a Discord report shows when nobody says otherwise.
 *
 * One constant rather than a `?? Severity.WARN` at each site, because the
 * threshold decides two different things that have to agree: which findings get
 * posted, and — through the bot's exit code — whether cron thinks the night was
 * clean. Three independent copies of the same default agreed by coincidence,
 * and nothing would have caught one of them changing. Drifting apart is silent
 * in both directions: a bot that posts warnings and exits 0, or one that exits
 * 1 having said nothing.
 */
export const DEFAULT_MIN_SEVERITY: Severity = Severity.WARN

const ANSI = {
  reset: "[0m",
  dim: "[2m",
  red: "[31m",
  yellow: "[33m",
  blue: "[34m",
  bold: "[1m",
} as const

const COLOUR: Record<Severity, string> = {
  ERROR: ANSI.red,
  WARN: ANSI.yellow,
  INFO: ANSI.blue,
}

export interface FormatOptions {
  colour?: boolean
  /** Drop INFO findings. The nightly Discord report does this. */
  minSeverity?: Severity
  /**
   * What this report is about, when the prose can't say.
   *
   * The CLI checks one championship the person just named, so "Suzuka has
   * duplicate pit boxes" lands in a context that already says whose Suzuka. The
   * nightly report covers a whole server and posts a message per championship,
   * where it doesn't — and a finding's own location is a *round*, so nothing in
   * the sentence can supply it.
   *
   * Rendered as a heading line above gridmom's prose rather than folded into
   * the first sentence, because the voice is one person talking and
   * "**gridmom** for BATL September 2026: Suzuka has…" is nobody talking.
   */
  subject?: string
}

const RANK: Record<Severity, number> = { ERROR: 0, WARN: 1, INFO: 2 }

export function filterBySeverity(
  findings: readonly Finding[],
  min: Severity | undefined,
): Finding[] {
  if (!min) return [...findings]
  return findings.filter((f) => RANK[f.severity] <= RANK[min])
}

export function formatText(report: CheckReport, opts: FormatOptions = {}): string {
  const colour = opts.colour ?? false
  const paint = (s: string, c: string) => (colour ? `${c}${s}${ANSI.reset}` : s)
  const findings = filterBySeverity(report.findings, opts.minSeverity)

  const title = report.championshipName ?? report.championshipId ?? "championship"
  const lines: string[] = [paint(`gridmom — ${title}`, ANSI.bold), ""]

  if (findings.length === 0) {
    lines.push("Nothing to report. Everything looks right.")
    return lines.join("\n")
  }

  for (const f of findings) {
    const tag = paint(f.severity.padEnd(5), COLOUR[f.severity])
    lines.push(`${tag} ${f.message}`)
    const where = locationText(f)
    if (where) lines.push(`      ${paint(where, ANSI.dim)}`)
  }

  lines.push("")
  lines.push(summaryLine(report))
  return lines.join("\n")
}

function locationText(f: Finding): string {
  const bits: string[] = []
  if (f.location?.path) bits.push(f.location.path)
  bits.push(f.code)
  return bits.join("  ")
}

export function summaryLine(report: CheckReport): string {
  const { ERROR, WARN, INFO } = report.counts
  const parts = [
    `${ERROR} ${ERROR === 1 ? "error" : "errors"}`,
    `${WARN} ${WARN === 1 ? "warning" : "warnings"}`,
    `${INFO} ${INFO === 1 ? "note" : "notes"}`,
  ]
  return `${parts.join(", ")}. ${report.ok ? "Safe to push." : "Fix the errors before pushing."}`
}

/**
 * gridmom's Discord voice: nagging, specific, never mean.
 *
 * > gridmom: Suzuka has duplicate pit boxes at 3, 16 and 27. Also nobody set
 * > the lap count.
 */
export function formatDiscord(report: CheckReport, opts: FormatOptions = {}): string {
  const findings = filterBySeverity(report.findings, opts.minSeverity ?? DEFAULT_MIN_SEVERITY)
  const title = report.championshipName ?? report.championshipId ?? "the championship"

  if (opts.subject !== undefined) {
    const heading = `**gridmom — ${opts.subject}**`
    // Not "…looks fine to me" here: the heading has already named the subject,
    // and repeating it reads as a machine filling in a template.
    return findings.length === 0
      ? `${heading}\nNothing to report.`
      : `${heading}\n${prose(findings.map((f) => f.message))}`
  }

  if (findings.length === 0) return `**gridmom:** ${title} looks fine to me.`
  return `**gridmom:** ${prose(findings.map((f) => f.message))}`
}

/**
 * Findings as gridmom would say them out loud.
 *
 * One or two read as one person talking, which is the whole point of the
 * voice. Beyond that prose stops scanning and a list is kinder.
 */
function prose(sentences: readonly string[]): string {
  if (sentences.length === 1) return sentences[0]!
  if (sentences.length === 2) return `${sentences[0]!} Also ${sentences[1]!}`

  const [first, ...rest] = sentences
  return [`${first!} Also:`, ...rest.map((s) => `- ${s}`)].join("\n")
}

export function formatJson(report: CheckReport): string {
  return JSON.stringify(report, null, 2)
}

export function formatReport(
  report: CheckReport,
  format: ReportFormat,
  opts: FormatOptions = {},
): string {
  switch (format) {
    case "json":
      return formatJson(report)
    case "discord":
      return formatDiscord(report, opts)
    case "text":
      return formatText(report, opts)
  }
}
