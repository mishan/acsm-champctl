/**
 * A night's findings as messages Discord will accept.
 *
 * One message per championship, headed with its name, because the nightly
 * report covers a whole server and a finding's own location is a round — so
 * nothing in the sentence says which championship's Suzuka has the duplicate
 * pit boxes.
 *
 * Failures get their own message rather than being folded in with the findings.
 * "champctl could not read this championship" is a different kind of statement
 * from "this championship has a problem", and a night where half the server
 * timed out should not read as a quiet night.
 */

import {
  blocksPush,
  countBySeverity,
  Severity,
  type CheckReport,
  type Finding,
} from "../gridmom/finding.js"
import { DEFAULT_MIN_SEVERITY, filterBySeverity, formatDiscord } from "../gridmom/report.js"
import type { NightlyEntry, NightlyReport } from "./nightly.js"
import type { Standings } from "./standings.js"
import { MESSAGE_LIMIT } from "./transport.js"

export interface MessageOptions {
  minSeverity?: Severity
  /** Overridden only by the tests, which would otherwise need 2000 characters. */
  limit?: number
}

/** What a championship is called in a report, falling back to its id. */
export function subjectOf(entry: NightlyEntry): string {
  return entry.name ?? entry.championshipId
}

/**
 * Everything worth posting about a night, in the order it should be said.
 *
 * A championship with nothing to say produces no message. That is the whole
 * difference between a nightly report and a nightly notification: gridmom
 * speaks up when something is wrong, so a silent channel means a clean server
 * rather than a broken cron. Whether the job *ran* is the exit code's job, and
 * `champctl-bot report` prints its summary either way.
 */
export function nightlyMessages(report: NightlyReport, opts: MessageOptions = {}): string[] {
  const out: string[] = []
  for (const entry of report.entries) {
    if (entry.kind === "checked") {
      out.push(...reportMessages(subjectOf(entry), entry.report, opts))
    } else if (entry.kind === "failed") {
      out.push(`**gridmom — ${subjectOf(entry)}**\nI couldn't read this one: ${entry.error}`)
    }
  }
  return out
}

/**
 * One championship's findings, split into messages that fit.
 *
 * Splitting happens on finding boundaries and by *measuring the rendered
 * message* rather than by estimating from the findings — the heading, the
 * bullets and the "Also" joins are all characters, and the formatter is
 * entitled to change how many without this having to hear about it.
 *
 * The continuation heading is not decoration either. Discord shows consecutive
 * messages from the same author without repeating the name, so an unheaded
 * second message looks like a new report about a championship it never names.
 */
export function reportMessages(
  subject: string,
  report: CheckReport,
  opts: MessageOptions = {},
): string[] {
  const limit = opts.limit ?? MESSAGE_LIMIT
  const findings = filterBySeverity(report.findings, opts.minSeverity ?? DEFAULT_MIN_SEVERITY)
  if (findings.length === 0) return []

  const messages: string[] = []
  let chunk: Finding[] = []
  let rendered = ""

  const flush = (): void => {
    if (rendered) messages.push(rendered)
    chunk = []
    rendered = ""
  }

  for (const finding of findings) {
    const heading = messages.length === 0 ? subject : `${subject} (continued)`

    const grown = render(heading, [...chunk, finding], opts)
    if (grown.length <= limit) {
      chunk = [...chunk, finding]
      rendered = grown
      continue
    }

    flush()
    const alone = render(
      messages.length === 0 ? subject : `${subject} (continued)`,
      [finding],
      opts,
    )
    if (alone.length <= limit) {
      chunk = [finding]
      rendered = alone
      continue
    }

    // One finding too long to post on its own. Truncated rather than dropped or
    // thrown: gridmom's messages name the thing first and explain after, so the
    // front of the sentence is the part worth having, and a report that refuses
    // to post because one finding is verbose is a report that goes missing on
    // the night with the most wrong with it.
    messages.push(`${alone.slice(0, limit - 1)}…`)
  }

  flush()
  return messages
}

/**
 * A standings table as a Discord message.
 *
 * A code block, because Discord renders proportional text everywhere else and a
 * table of points that doesn't line up is harder to read than a list. The
 * source is named in the footer: when champctl worked the numbers out itself
 * rather than asking ACSM, whoever reads this should know that before they
 * argue with someone about a point.
 */
export function standingsMessage(
  subject: string,
  standings: Standings,
  opts: MessageOptions = {},
): string[] {
  const limit = opts.limit ?? MESSAGE_LIMIT
  const scored = standings.classes.filter((c) => c.rows.length > 0)
  if (scored.length === 0) return []

  const footer =
    standings.source === "endpoint"
      ? ""
      : "\n-# Worked out from the championship export, not read from Server Manager."

  const messages: string[] = []
  for (const cls of scored) {
    const heading = cls.name ? `**${subject} — ${cls.name}**` : `**${subject}**`
    const width = String(Math.max(...cls.rows.map((r) => r.points))).length
    // Both columns are measured off the rows. The name column was a hardcoded
    // 20, which holds for a Steam persona (capped at 32) about as often as not
    // and not at all for an entry list, where ACSM validates the name's length
    // no further than "it is a string" — and one name past the pad pushed that
    // row's points out of line with every other row in the table.
    const names = Math.max(...cls.rows.map((r) => r.driver.length))

    // Chunked by rows so a 30-driver class still posts. The heading repeats for
    // the same reason it does in a split gridmom report: Discord hides the
    // author on consecutive messages.
    //
    // `sent` counts *this class's* messages, not every message so far. Counting
    // all of them headed the second class's first table "(continued)", which
    // reads as more of the class above it — the exact confusion the repeated
    // heading exists to prevent.
    let sent = 0
    let rows: string[] = []

    const renderTable = (lines: readonly string[]): string => {
      const head = sent === 0 ? heading : `${heading} (continued)`
      return `${head}\n\`\`\`\n${lines.join("\n")}\n\`\`\`${footer}`
    }

    const flush = (): void => {
      if (rows.length === 0) return
      messages.push(renderTable(rows))
      sent++
      rows = []
    }

    for (const row of cls.rows) {
      const line = `${String(row.position).padStart(2)}. ${row.driver.padEnd(names)} ${String(row.points).padStart(width)}`
      // Measured, not estimated, for the same reason `reportMessages` measures:
      // the fences, the newlines and the twelve characters " (continued)" adds
      // are all length. The estimate here allowed twenty for all of it where a
      // continuation needs twenty-one, so a table landing exactly on the
      // boundary posted 2001 characters — which Discord refuses outright rather
      // than trimming, losing the whole table.
      if (rows.length > 0 && renderTable([...rows, line]).length > limit) flush()
      rows = [...rows, line]
    }
    flush()
  }
  return messages
}

function render(subject: string, findings: readonly Finding[], opts: MessageOptions): string {
  return formatDiscord(
    { findings: [...findings], counts: countBySeverity(findings), ok: !blocksPush(findings) },
    { subject, minSeverity: opts.minSeverity ?? DEFAULT_MIN_SEVERITY },
  )
}
