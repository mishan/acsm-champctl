import { useEffect, useRef, useState } from "react"

import { useAuthAware } from "../App"
import {
  api,
  type CheckReport,
  type ChampionshipView,
  type ReorderPlanView,
  type RoundView,
} from "../api"
import { describeFormat, venueLabel } from "../format"
import { moveItem, movedPositions, useReorder } from "../reorder"
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
  /** The running order being tried, as 1-based source rounds. Null when not reordering. */
  const [order, setOrder] = useState<number[] | null>(null)
  const describe = useAuthAware(onAuthLost)

  useEffect(() => {
    // Cleared on the way in, not only on the way out. `error` short-circuits
    // the render below, so a championship that failed to load — or a session
    // that expired while it was open — left the screen stuck on that message:
    // navigating to a different championship fetched it, set `data`, and
    // returned early on the stale error anyway. The failure of one
    // championship is not a fact about the next one.
    setError(null)
    // And the reorder, which is about the championship that was on screen. A
    // running order carried across to a different championship would be a
    // rearrangement of rounds that are not the ones it describes.
    setOrder(null)

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

  if (order) {
    return (
      <Reorder
        championshipId={championshipId}
        rounds={championship.rounds}
        order={order}
        onOrder={setOrder}
        onDone={() => {
          // Re-read rather than patch what is on screen. The championship has
          // changed underneath this component and the export is the only thing
          // that knows what it now says — gridmom included.
          setData(null)
          setOrder(null)
          void (async () => {
            try {
              setData(await api.championship(championshipId))
            } catch (e) {
              setError(describe(e))
            }
          })()
        }}
        onCancel={() => setOrder(null)}
        onAuthLost={onAuthLost}
      />
    )
  }

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

      {championship.rounds.length > 1 && (
        <div className="actions">
          <button
            type="button"
            className="secondary"
            onClick={() => setOrder(championship.rounds.map((r) => r.round))}
          >
            Reorder rounds
          </button>
        </div>
      )}
    </>
  )
}

function Round({ round, onOpen }: { round: RoundView; onOpen: () => void }): React.JSX.Element {
  return (
    <button type="button" className={`row ${round.started ? "row-done" : ""}`} onClick={onOpen}>
      <span className="row-main">
        <span className="row-title">
          <span className="round-number">{round.round}</span>
          {venueLabel(round.venue) || "no track set"}
        </span>
        <span className="row-sub">
          {describeFormat(round.format)}
          {/*
            Quali, not `Scheduled`. Anyone reading `Scheduled` as the quali time
            is an hour out — it is practice start.

            "Unscheduled" only for a round that has *not* run. ACSM clears
            `Scheduled` once an event starts, so every finished round reported
            itself as unscheduled — true, useless, and read as "nobody has set
            a date for this yet" when in fact the race happened.
          */}
          {round.quali ? ` · quali ${round.quali.display}` : round.started ? "" : " · unscheduled"}
        </span>
      </span>
      {/*
        "Raced", not "run". As a chip beside a race, "RUN" reads as an
        instruction to start one — the opposite of what it means, and next to a
        row that is still tappable.
      */}
      {round.started ? <span className="tag">raced</span> : <span className="row-chevron">›</span>}
    </button>
  )
}

/** Long enough to finish a drag, short enough that the review feels live. */
const PREVIEW_DEBOUNCE_MS = 350

/**
 * Moving rounds around the calendar (plan §5.1, applied to one that exists).
 *
 * **What moves is the track and the format; what stays is the date and the
 * name.** That is the one thing worth understanding about this screen and the
 * one thing people expect the other way round, so the review lists every round
 * with the night it keeps rather than only the ones that change.
 *
 * The same three promises as the other two write screens. The review is the
 * server's — `planReorder` decides which rounds move. A preview writes nothing.
 * And apply takes a plan id, which matters more here than anywhere else: the
 * plan is holding an entry-list fingerprint for each round about to be written,
 * and every one of those writes is a full-list replace.
 *
 * A round that has already been raced cannot move and nothing can move into
 * its slot; the server refuses that by name, so this does not reimplement the
 * rule, it just doesn't offer a handle on a row that has run.
 */
function Reorder({
  championshipId,
  rounds,
  order,
  onOrder,
  onDone,
  onCancel,
  onAuthLost,
}: {
  championshipId: string
  rounds: RoundView[]
  order: number[]
  onOrder: (order: number[]) => void
  onDone: () => void
  onCancel: () => void
  onAuthLost: () => void
}): React.JSX.Element {
  const [plan, setPlan] = useState<ReorderPlanView | null>(null)
  /**
   * What failed, as well as why.
   *
   * The two sources want different lifetimes. A *preview* failure is about an
   * order that no longer exists the moment the rows move back, so it is
   * retired with the preview. An *apply* failure is about a write that already
   * happened — a reorder that landed part way names the rounds it moved — and
   * dragging the rows around afterwards does not make it untrue. One flat
   * string could only have one of those lifetimes, and the wrong one leaves
   * "champctl refused this" on screen under a list nobody is previewing.
   */
  const [error, setError] = useState<{ from: "preview" | "apply"; message: string } | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [applying, setApplying] = useState(false)
  const [announcement, setAnnouncement] = useState("")
  const describe = useAuthAware(onAuthLost)

  const lastSent = useRef<string | null>(null)
  const generation = useRef(0)

  const byRound = new Map(rounds.map((r) => [r.round, r]))
  const unchanged = order.every((source, i) => source === i + 1)

  // Re-preview as the order changes, debounced, with the previous request
  // aborted — the same rule as the other two screens, and the same reason.
  useEffect(() => {
    if (unchanged) {
      // Back where it started, so there is nothing to preview and nothing a
      // preview could still be saying. `previewing` too: the cleanup above
      // aborted whatever was in flight, and a spinner left spinning over a
      // list that is not being previewed is the same lie as the message.
      setPlan(null)
      setPreviewing(false)
      setError((e) => (e?.from === "apply" ? e : null))
      lastSent.current = null
      return
    }

    const serialised = JSON.stringify(order)
    if (serialised === lastSent.current) return

    const mine = ++generation.current
    const controller = new AbortController()
    const timer = setTimeout(() => {
      lastSent.current = serialised
      setPreviewing(true)
      api
        .planReorder(championshipId, order, controller.signal)
        .then((res) => {
          if (mine !== generation.current) return
          setPlan(res.plan)
          setError(null)
        })
        .catch((e: unknown) => {
          if (controller.signal.aborted || mine !== generation.current) return
          // Cleared so the identical order can be retried: a transient failure
          // is exactly the case where someone puts a row back and expects
          // another go.
          lastSent.current = null
          setPlan(null)
          setError({ from: "preview", message: describe(e) })
        })
        .finally(() => {
          if (mine === generation.current) setPreviewing(false)
        })
    }, PREVIEW_DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [championshipId, order, unchanged, describe])

  useEffect(() => {
    return () => {
      generation.current++
    }
  }, [])

  /**
   * A position nothing may move out of or into.
   *
   * Two ways to be fixed and they are different facts. `round.started` is the
   * round currently sitting here having raced, so it cannot be moved. And
   * `slot.started` is the *night* having happened, so nothing can be moved onto
   * it — putting a future round on a date that has passed is not a reorder, it
   * is a rewrite of history.
   */
  const isFixed = (i: number): boolean =>
    byRound.get(order[i] ?? 0)?.started === true || rounds[i]?.started === true

  /**
   * Whether this move is one the server would accept.
   *
   * Every position between `from` and `to` inclusive changes its occupant —
   * `moveItem` lifts one row out and the rest close up behind it — so the
   * whole span has to be movable, not just the ends. Dragging round 3 above a
   * raced round 1 would otherwise pass a check on its endpoints and still
   * shift round 2 onto a night that has already happened.
   */
  const canMove = (from: number, to: number): boolean => {
    const touched = movedPositions(order.length, from, to)
    return touched.length > 0 && !touched.some(isFixed)
  }

  const move = (from: number, to: number): void => {
    // Refused rather than sent and rejected. The server says no to this by
    // name, and a screen that announces "spa is now round 1", retires the
    // preview and then shows a refusal has told the person three things, two
    // of which are wrong.
    if (!canMove(from, to)) return
    const label = byRound.get(order[from] ?? 0)
    setAnnouncement(
      `${label ? venueLabel(label.venue) || `round ${order[from]}` : "the round"} is now round ${to + 1} of ${order.length}.`,
    )
    // Any change retires the current preview, so the button can never offer to
    // apply an order the rows no longer show.
    setPlan(null)
    setAcknowledged(false)
    onOrder(moveItem(order, from, to))
  }

  const reorder = useReorder(order.length, move)

  const apply = async (): Promise<void> => {
    if (!plan) return
    setApplying(true)
    setError(null)
    try {
      await api.applyReorder(plan.planId, acknowledged)
      onDone()
    } catch (e) {
      setError({ from: "apply", message: describe(e) })
    } finally {
      setApplying(false)
    }
  }

  const blocked = plan?.blocked === true
  const needsAck = plan?.needsAcknowledgement === true
  const canApply =
    plan !== null &&
    !plan.noop &&
    !blocked &&
    !applying &&
    !previewing &&
    (!needsAck || acknowledged)

  return (
    <>
      <h1>Reorder rounds</h1>
      <p className="muted">
        Drag a round to move it. The track and the race format travel with it; the date and the
        round name stay with the race night.
      </p>

      <ol className={reorder.dragging ? "tracks reorder dragging" : "tracks reorder"}>
        {order.map((source, i) => {
          const round = byRound.get(source)
          const slot = rounds[i]
          // A raced round cannot move and nothing can move into its slot. No
          // handle, rather than a grip that produces a refusal. The arrows ask
          // `canMove`, because a row can be perfectly movable and still have
          // nowhere to go in one direction.
          const fixed = isFixed(i)
          return (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: a row is its position
              key={i}
              ref={reorder.rowRef(i)}
              className={reorder.from === i ? "held" : undefined}
              style={reorder.styleFor(i)}
            >
              <span
                className={`round-number ${fixed ? "" : "round-grip"}`}
                {...(fixed ? {} : { title: "Drag to reorder" })}
                aria-hidden="true"
                {...(fixed ? {} : reorder.handleProps(i))}
              >
                {i + 1}
              </span>
              <span className="row-title">
                {round ? venueLabel(round.venue) || "no track set" : ""}
                {source !== i + 1 && <span className="tag tag-quiet">was {source}</span>}
              </span>
              {/* The night this slot keeps, whatever ends up racing on it. */}
              <span className="row-sub">{slot?.quali?.display ?? "unscheduled"}</span>
              <button
                type="button"
                className="icon"
                aria-label={`Move round ${i + 1} up`}
                disabled={!canMove(i, i - 1)}
                onClick={() => move(i, i - 1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="icon"
                aria-label={`Move round ${i + 1} down`}
                disabled={!canMove(i, i + 1)}
                onClick={() => move(i, i + 1)}
              >
                ↓
              </button>
              {round?.started && <span className="tag">raced</span>}
            </li>
          )
        })}
      </ol>

      <p className="visually-hidden" aria-live="polite">
        {announcement}
      </p>

      <section aria-live="polite">
        <h2>
          What changes{" "}
          {previewing && <span className="spinner spinner-inline" aria-hidden="true" />}
        </h2>

        {error && <Message kind="error" title="champctl refused this" body={error.message} />}
        {plan && !plan.noop && (
          <ul className="list">
            {plan.moves.map((m) => (
              <li key={m.round}>
                <span className="row-main">
                  <span className="round-number">{m.round}</span>
                  <span className="row-title">
                    {m.changes.map((c) => `${c.label}: ${c.before} → ${c.after}`).join(" · ")}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {!plan && !error && !previewing && (
          <p className="muted">Move a round to see what it would change.</p>
        )}
      </section>

      {plan && (
        <section>
          <h2>gridmom</h2>
          <Findings
            report={plan.gridmom}
            emptyLabel="gridmom has nothing to say about this order."
          />
        </section>
      )}

      <div className="push">
        {needsAck && !blocked && (
          <label className="check check-ack">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            I've read the warnings above
          </label>
        )}
        <button type="button" className="primary" disabled={!canApply} onClick={() => void apply()}>
          {applying ? "Moving…" : blocked ? "Blocked by an error" : "Apply the new order"}
        </button>
        <button type="button" className="secondary" onClick={onCancel} disabled={applying}>
          Cancel
        </button>
        {/*
          Said before anyone presses it, not only when it goes wrong. This is
          several saves with nothing behind them to make it one, and a person
          who knows that beforehand reads a partial failure as the thing they
          were warned about rather than as champctl having lost the season.
        */}
        <p className="fineprint">
          Each moved round is a separate save. If one fails, the ones before it have already been
          moved — champctl will say which.
        </p>
      </div>
    </>
  )
}
