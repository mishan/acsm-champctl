import { useEffect, useState } from "react"

import { useAuthAware } from "../App"
import { api, type CheckReport, type ChampionshipView, type RoundView } from "../api"
import { describeFormat } from "../format"
import { Findings, findingSummary } from "./Findings"
import { Message } from "./Message"

interface RoundListProps {
  championshipId: string
  onOpenRound: (round: number) => void
  onAuthLost: () => void
}

export function RoundList({
  championshipId,
  onOpenRound,
  onAuthLost,
}: RoundListProps): React.JSX.Element {
  const [data, setData] = useState<{ championship: ChampionshipView; gridmom: CheckReport } | null>(
    null,
  )
  const [error, setError] = useState<string | null>(null)
  const [showFindings, setShowFindings] = useState(false)
  const describe = useAuthAware(onAuthLost)

  useEffect(() => {
    // Cleared on the way in, not only on the way out. `error` short-circuits
    // the render below, so a championship that failed to load — or a session
    // that expired while it was open — left the screen stuck on that message:
    // navigating to a different championship fetched it, set `data`, and
    // returned early on the stale error anyway. The failure of one
    // championship is not a fact about the next one.
    setError(null)

    // Which load is current, so an answer that arrives after the user has
    // moved on cannot overwrite the one they are looking at, and nothing is
    // set after unmount.
    let live = true
    void (async () => {
      try {
        const next = await api.championship(championshipId)
        if (live) setData(next)
      } catch (e) {
        if (live) setError(describe(e))
      }
    })()
    return () => {
      live = false
    }
  }, [championshipId, describe])

  if (error) return <Message kind="error" title="Couldn't load that championship" body={error} />
  if (!data) return <p className="muted">Loading…</p>

  const { championship, gridmom } = data
  const blocking = gridmom.counts.ERROR > 0

  return (
    <>
      <h1>{championship.name}</h1>

      {/*
        The health of the championship as it stands, before anyone edits
        anything. This is the job nobody does today — checking for the mistakes
        that ruin a race night while there is still time to fix them — and it
        costs one pure function over an export the server already had.
      */}
      <button
        type="button"
        className={`summary ${blocking ? "summary-error" : ""}`}
        onClick={() => setShowFindings((v) => !v)}
        aria-expanded={showFindings}
      >
        <span>gridmom: {findingSummary(gridmom)}</span>
        <span aria-hidden="true">{showFindings ? "▾" : "▸"}</span>
      </button>
      {showFindings && <Findings report={gridmom} />}

      <ul className="list">
        {championship.rounds.map((r) => (
          <li key={r.eventId || r.round}>
            <Round round={r} onOpen={() => onOpenRound(r.round)} />
          </li>
        ))}
      </ul>
    </>
  )
}

function Round({ round, onOpen }: { round: RoundView; onOpen: () => void }): React.JSX.Element {
  return (
    <button type="button" className={`row ${round.started ? "row-done" : ""}`} onClick={onOpen}>
      <span className="row-main">
        <span className="row-title">
          <span className="round-number">{round.round}</span>
          {round.track || "no track set"}
        </span>
        <span className="row-sub">
          {describeFormat(round.format)}
          {/* Quali, not `Scheduled`. Anyone reading `Scheduled` as the quali
              time is an hour out — it is practice start. */}
          {round.quali ? ` · quali ${round.quali.display}` : " · unscheduled"}
        </span>
      </span>
      {round.started ? <span className="tag">run</span> : <span className="row-chevron">›</span>}
    </button>
  )
}
