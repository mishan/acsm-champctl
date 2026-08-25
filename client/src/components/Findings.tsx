import type { CheckReport, Finding } from "../api"

/**
 * gridmom's findings, in gridmom's voice.
 *
 * The message is printed verbatim and is the whole of what a person reads. It
 * is written as one plain sentence naming the thing and where it is, with no
 * severity jargon in the prose — so the badge beside it carries the severity
 * and the sentence carries the problem, rather than both saying it and neither
 * saying it well.
 *
 * Sorted by the server, not here. `sortFindings` puts errors first and orders
 * by round within a severity, and re-sorting in the browser would be a second
 * opinion about report order that could disagree with the CLI's.
 */
export function Findings({
  report,
  emptyLabel,
}: {
  report: CheckReport
  emptyLabel?: string
}): React.JSX.Element {
  if (report.findings.length === 0) {
    return <p className="muted">{emptyLabel ?? "gridmom found nothing to complain about."}</p>
  }

  return (
    <ul className="findings">
      {report.findings.map((f) => (
        // Keyed on what makes a finding that finding rather than on its index:
        // the same code fires for several rounds, and two of them swapping
        // places in a re-sorted report would otherwise reuse each other's row.
        <li
          key={`${f.code}|${f.location?.round ?? ""}|${f.location?.path ?? ""}|${f.message}`}
          className={`finding finding-${f.severity.toLowerCase()}`}
        >
          <span className="badge">{f.severity}</span>
          <span className="finding-text">
            {f.message}
            <FindingWhere finding={f} />
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Where, when the sentence didn't already say.
 *
 * `location.path` is the dotted path into the export — `Events[0].EntryList` —
 * which is useless on a phone and exactly what you want when you have the JSON
 * open beside you. Small and grey rather than absent.
 */
function FindingWhere({ finding }: { finding: Finding }): React.JSX.Element | null {
  const path = finding.location?.path
  if (!path) return null
  return <code className="finding-path">{path}</code>
}

/** "4 errors, 6 warnings, 2 notes" — the same summary the CLI prints. */
export function findingSummary(report: CheckReport): string {
  const { ERROR, WARN, INFO } = report.counts
  if (ERROR + WARN + INFO === 0) return "gridmom is happy"
  const parts: string[] = []
  if (ERROR) parts.push(`${ERROR} ${ERROR === 1 ? "error" : "errors"}`)
  if (WARN) parts.push(`${WARN} ${WARN === 1 ? "warning" : "warnings"}`)
  if (INFO) parts.push(`${INFO} ${INFO === 1 ? "note" : "notes"}`)
  return parts.join(", ")
}
