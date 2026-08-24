/**
 * Report formatters.
 *
 * The Discord format carries no severity jargon at all (plan §6) — findings
 * read as one plain sentence each, because a report people mute is worth
 * nothing. The text format is for a terminal and may be more explicit.
 */

import { Severity, type CheckReport, type Finding } from "./finding.js"

export type ReportFormat = "text" | "json" | "discord"

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
  const findings = filterBySeverity(report.findings, opts.minSeverity ?? Severity.WARN)
  const title = report.championshipName ?? report.championshipId ?? "the championship"

  if (findings.length === 0) return `**gridmom:** ${title} looks fine to me.`

  const sentences = findings.map((f) => f.message)

  // One or two findings read as one person talking, which is the whole point
  // of the voice. Beyond that prose stops scanning and a list is kinder.
  if (sentences.length === 1) return `**gridmom:** ${sentences[0]!}`
  if (sentences.length === 2) return `**gridmom:** ${sentences[0]!} Also ${sentences[1]!}`

  const [first, ...rest] = sentences
  return [`**gridmom:** ${first!} Also:`, ...rest.map((s) => `- ${s}`)].join("\n")
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
