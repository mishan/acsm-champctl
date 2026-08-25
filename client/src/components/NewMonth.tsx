import { useEffect, useRef, useState } from "react"

import { useAuthAware } from "../App"
import {
  api,
  type ChampionshipListItem,
  type MonthImportResponse,
  type MonthPlanView,
  type TrackRequest,
} from "../api"
import { Findings } from "./Findings"
import { Message } from "./Message"

/**
 * Create a month (plan §5.1), by cloning the last one.
 *
 * Cloning is the prominent path because it is the one a league actually takes:
 * the cars, the class, the format and the entry-list slots are the same as
 * last month, and what changes is the name, the date and the tracks. Starting
 * from a blank spec would mean re-entering a season's worth of settings every
 * month to arrive back where it started.
 *
 * The same three promises as the finalize screen, for the same reasons:
 *
 * **The review is the server's.** Rounds, dates, grid cap and the derived list
 * all come from `cloneMonth` on the server. The screen renders them; it does
 * not work out what a month would look like.
 *
 * **A preview writes nothing.** Editing the track list re-previews freely.
 * The only request that creates a championship is the one behind the button.
 *
 * **What lands is what was reviewed.** Create takes the plan id and nothing
 * else. That matters more here than in finalize: a month that gets created
 * twice leaves someone two Septembers to tell apart and delete by hand.
 */

interface NewMonthProps {
  onCreated: (championshipId: string) => void
  onAuthLost: () => void
}

/** The form's own state. Tracks are held as text so a half-typed row is legal. */
interface Draft {
  sourceId: string
  name: string
  startDate: string
  tracks: TrackRow[]
}

interface TrackRow {
  track: string
  layout: string
}

/** Long enough to finish typing a track name, short enough to feel live. */
const PREVIEW_DEBOUNCE_MS = 350

export function NewMonth({ onCreated, onAuthLost }: NewMonthProps): React.JSX.Element {
  const [sources, setSources] = useState<ChampionshipListItem[] | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [plan, setPlan] = useState<MonthPlanView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [creating, setCreating] = useState(false)
  const [done, setDone] = useState<MonthImportResponse | null>(null)
  const describe = useAuthAware(onAuthLost)

  /** What was last asked for, so seeding the form doesn't ask for it again. */
  const lastSent = useRef<string | null>(null)
  const generation = useRef(0)

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const list = (await api.championships()).championships
        if (!live) return
        setSources(list)
      } catch (e) {
        if (live) setError(describe(e))
      }
    })()
    return () => {
      live = false
    }
  }, [describe])

  // Re-preview as the form changes, debounced, with the previous request
  // aborted — an answer to a question the person has moved on from must not
  // overwrite the answer to the one they are looking at.
  useEffect(() => {
    if (!draft?.sourceId) return
    const body = requestFrom(draft)
    if (!body) return

    const serialised = JSON.stringify(body)
    if (serialised === lastSent.current) return

    const mine = ++generation.current
    const controller = new AbortController()
    const timer = setTimeout(() => {
      lastSent.current = serialised
      setPreviewing(true)
      api
        .monthPlan(body, controller.signal)
        .then((res) => {
          if (mine !== generation.current) return
          setPlan(res.plan)
          setError(null)
        })
        .catch((e: unknown) => {
          if (controller.signal.aborted || mine !== generation.current) return
          setPlan(null)
          setError(describe(e))
        })
        .finally(() => {
          if (mine === generation.current) setPreviewing(false)
        })
    }, PREVIEW_DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [draft, describe])

  useEffect(() => {
    return () => {
      generation.current++
    }
  }, [])

  /**
   * Any edit retires the current preview.
   *
   * Same rule as the finalize screen: `previewing` alone is false during the
   * debounce and false again after a failed preview, so the button would offer
   * to create a month the fields on screen no longer describe. `lastSent` is
   * cleared too, so putting a value back to what it was still re-previews
   * rather than short-circuiting on a plan that has been dropped.
   */
  const set = (patch: Partial<Draft>): void => {
    if (!draft) return
    setDraft({ ...draft, ...patch })
    setPlan(null)
    setAcknowledged(false)
    setDone(null)
    lastSent.current = null
  }

  const chooseSource = (id: string): void => {
    setPlan(null)
    setAcknowledged(false)
    setDone(null)
    lastSent.current = null
    setDraft({
      sourceId: id,
      // Blank rather than last month's name. A month called "August 2026"
      // sitting in a September field is the kind of default that gets pushed.
      name: "",
      startDate: "",
      tracks: [],
    })
  }

  const create = async (): Promise<void> => {
    if (!plan) return
    setCreating(true)
    setError(null)
    try {
      const made = await api.createMonth(plan.planId, acknowledged)
      setDone(made)
      setPlan(null)
    } catch (e) {
      setError(describe(e))
    } finally {
      setCreating(false)
    }
  }

  if (error && !sources) {
    return <Message kind="error" title="Couldn't list championships" body={error} />
  }
  if (!sources) return <p className="muted">Loading championships…</p>

  if (done) {
    return (
      <>
        <h1>Month created</h1>
        <Message
          kind="info"
          title={done.name}
          body={`${done.rounds} ${done.rounds === 1 ? "round" : "rounds"}, in Server Manager now.`}
        >
          <button type="button" className="primary" onClick={() => onCreated(done.championshipId)}>
            Open it
          </button>
        </Message>
      </>
    )
  }

  const blocked = plan?.blocked === true
  const needsAck = plan?.needsAcknowledgement === true
  const canCreate =
    plan !== null && !blocked && !creating && !previewing && (!needsAck || acknowledged)

  return (
    <>
      <h1>New month</h1>
      <p className="muted">
        Built from a past month: same cars, same class, same format. Name it, say when it starts,
        and list the tracks.
      </p>

      <section>
        <h2>Clone from</h2>
        <label htmlFor="source">Last month</label>
        <select
          id="source"
          value={draft?.sourceId ?? ""}
          onChange={(e) => chooseSource(e.target.value)}
        >
          <option value="">Pick a championship…</option>
          {sources.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        {sources.length === 0 && (
          <p className="fineprint">
            This manager has no championships yet, so there is nothing to clone. Build the first one
            with `champctl-month build`.
          </p>
        )}
      </section>

      {draft && (
        <>
          <section>
            <h2>This month</h2>
            <label htmlFor="name">Name</label>
            <input
              id="name"
              type="text"
              value={draft.name}
              placeholder="September 2026"
              onChange={(e) => set({ name: e.target.value })}
            />

            <label htmlFor="start">First race night</label>
            <input
              id="start"
              type="date"
              value={draft.startDate}
              onChange={(e) => set({ startDate: e.target.value })}
            />
            <p className="fineprint">
              Later rounds follow the league's weekday rule. Leave it blank for the next one.
            </p>
          </section>

          <TrackList rows={draft.tracks} onChange={(tracks) => set({ tracks })} />
        </>
      )}

      <section aria-live="polite">
        <h2>
          What gets created{" "}
          {previewing && <span className="spinner spinner-inline" aria-hidden="true" />}
        </h2>

        {error && <Message kind="error" title="champctl refused this" body={error} />}
        {plan && <Review plan={plan} />}
        {!plan && !error && !previewing && (
          <p className="muted">
            {draft?.sourceId
              ? "Name the month and add at least one track."
              : "Pick a championship to clone."}
          </p>
        )}
      </section>

      {plan && (
        <section>
          <h2>gridmom</h2>
          <Findings
            report={plan.gridmom}
            emptyLabel="gridmom has nothing to say about this month."
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
        <button
          type="button"
          className="primary"
          disabled={!canCreate}
          onClick={() => void create()}
        >
          {creating ? "Creating…" : blocked ? "Blocked by an error" : "Create in ACSM"}
        </button>
        {blocked && (
          <p className="fineprint">
            An error means a broken or unfair season. Nothing overrides it — fix the cause and
            preview again.
          </p>
        )}
      </div>
    </>
  )
}

/**
 * The track list, in order, one race night each.
 *
 * Up and down rather than drag: it works with a keyboard, it works on a phone
 * without a long-press, and the order is the only thing being expressed. Drag
 * can be added later without changing what a row is.
 */
function TrackList({
  rows,
  onChange,
}: {
  rows: TrackRow[]
  onChange: (rows: TrackRow[]) => void
}): React.JSX.Element {
  const move = (from: number, to: number): void => {
    if (to < 0 || to >= rows.length) return
    const next = [...rows]
    const [row] = next.splice(from, 1)
    if (row) next.splice(to, 0, row)
    onChange(next)
  }

  const update = (i: number, patch: Partial<TrackRow>): void => {
    onChange(rows.map((r, at) => (at === i ? { ...r, ...patch } : r)))
  }

  return (
    <section>
      <h2>Tracks</h2>
      <p className="fineprint">One race night each, in this order.</p>

      <ol className="tracks">
        {rows.map((row, i) => (
          // The index is the identity here on purpose: rows have no id, and
          // two rounds at the same track is a legal month.
          // biome-ignore lint/suspicious/noArrayIndexKey: a row is its position
          <li key={i}>
            <span className="round-number">{i + 1}</span>
            <input
              type="text"
              aria-label={`Round ${i + 1} track`}
              value={row.track}
              placeholder="spa"
              onChange={(e) => update(i, { track: e.target.value })}
            />
            <input
              type="text"
              aria-label={`Round ${i + 1} layout`}
              value={row.layout}
              placeholder="layout (optional)"
              onChange={(e) => update(i, { layout: e.target.value })}
            />
            <button
              type="button"
              className="icon"
              aria-label={`Move round ${i + 1} up`}
              disabled={i === 0}
              onClick={() => move(i, i - 1)}
            >
              ↑
            </button>
            <button
              type="button"
              className="icon"
              aria-label={`Move round ${i + 1} down`}
              disabled={i === rows.length - 1}
              onClick={() => move(i, i + 1)}
            >
              ↓
            </button>
            <button
              type="button"
              className="icon"
              aria-label={`Remove round ${i + 1}`}
              onClick={() => onChange(rows.filter((_, at) => at !== i))}
            >
              ×
            </button>
          </li>
        ))}
      </ol>

      <button
        type="button"
        className="secondary"
        onClick={() => onChange([...rows, { track: "", layout: "" }])}
      >
        Add a round
      </button>
    </section>
  )
}

/**
 * The month as it would be.
 *
 * The grid cap names the track that bound it, because "capped at 24" without
 * saying by what leaves someone guessing which track to go and change. The
 * derived list is here because "what did it decide for me?" is the question a
 * review screen exists to answer, and every entry in it was a real bug once.
 */
function Review({ plan }: { plan: MonthPlanView }): React.JSX.Element {
  return (
    <>
      <ol className="list">
        {plan.rounds.map((r) => (
          <li key={r.round}>
            <span className="row-main">
              <span className="round-number">{r.round}</span>
              <span className="row-title">{r.label}</span>
              <span className="row-sub">
                {r.quali.display}
                {r.moved && r.note ? ` · moved: ${r.note}` : r.moved ? " · moved" : ""}
              </span>
            </span>
          </li>
        ))}
      </ol>

      <p className="grid-cap">{plan.grid.summary}</p>
      {plan.grid.unknownTracks.length > 0 && (
        <p className="fineprint">
          No pit count on file for {plan.grid.unknownTracks.join(", ")}, so the cap is a guess
          without them.
        </p>
      )}

      {plan.derived.length > 0 && (
        <details className="derived">
          <summary>{plan.derived.length} set rather than inherited</summary>
          <ul>
            {plan.derived.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </details>
      )}
    </>
  )
}

/**
 * The draft as a request, or null when it isn't ready to preview.
 *
 * Null rather than a partial request, for the same reason the finalize
 * screen's `requestFrom` refuses a half-filled quali time: a month with no name
 * cannot be cloned — the server has nothing to fall back on and says so — and
 * a blank track row is someone mid-type, not a request for a round at a track
 * called "".
 */
export function requestFrom(
  draft: Draft,
): { sourceId: string; name: string; startDate?: string; tracks?: TrackRequest[] } | null {
  if (!draft.sourceId) return null
  const name = draft.name.trim()
  if (!name) return null

  const tracks = draft.tracks
    .map((r) => ({ track: r.track.trim(), layout: r.layout.trim() }))
    .filter((r) => r.track !== "")
  if (draft.tracks.length > 0 && tracks.length !== draft.tracks.length) return null
  if (draft.tracks.length === 0) return null

  return {
    sourceId: draft.sourceId,
    name,
    ...(draft.startDate ? { startDate: draft.startDate } : {}),
    tracks: tracks.map((r) => ({ track: r.track, ...(r.layout ? { layout: r.layout } : {}) })),
  }
}
