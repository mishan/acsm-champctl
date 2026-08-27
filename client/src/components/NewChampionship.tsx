import { useEffect, useRef, useState } from "react"

import { useAuthAware } from "../App"
import {
  api,
  type ChampionshipListItem,
  type InstalledItem,
  type NewChampionshipResponse,
  type NewChampionshipPlan,
  type TrackRequest,
} from "../api"
import { Findings } from "./Findings"
import { Message } from "./Message"
import { Picker } from "./Picker"

/**
 * Create a championship (plan §5.1), by cloning a past one.
 *
 * Cloning is the prominent path because it is the one a league actually takes:
 * the cars, the class, the format and the entry-list slots are the same as the
 * last one, and what changes is the name, the date and the tracks. Starting
 * from a blank spec would mean re-entering a season's worth of settings every
 * time to arrive back where it started.
 *
 * The same three promises as the finalize screen, for the same reasons:
 *
 * **The review is the server's.** Rounds, dates, grid cap and the derived list
 * all come from `cloneChampionship` on the server. The screen renders them; it does
 * not work out what a championship would look like.
 *
 * **A preview writes nothing.** Editing the track list re-previews freely.
 * The only request that creates a championship is the one behind the button.
 *
 * **What lands is what was reviewed.** Create takes the plan id and nothing
 * else. That matters more here than in finalize: a championship created twice
 * leaves someone two of them to tell apart and delete by hand.
 */

interface NewChampionshipProps {
  onCreated: (championshipId: string) => void
  onAuthLost: () => void
}

/** The form's own state. Tracks are held as text so a half-typed row is legal. */
interface Draft {
  sourceId: string
  name: string
  startDate: string
  /**
   * The class car list, as folder names.
   *
   * Empty means "whatever the source ran", which is what cloning always did.
   * The screen fills this in from the source instead of leaving it empty, so
   * the cars are on screen rather than inherited silently — that invisibility
   * is why the form could ask which tracks a season runs at and never mention
   * what anyone would be driving.
   */
  cars: string[]
  /**
   * The blurb ACSM shows on the championship page.
   *
   * Filled in from the source for the same reason the cars are: a clone
   * inherits it, and inheriting it invisibly is how a September championship
   * ends up describing August's tracks. Empty is a value — somebody who
   * clears the box gets an empty description, not last month's.
   */
  description: string
  tracks: TrackRow[]
}

interface TrackRow {
  track: string
  layout: string
  /**
   * What to call this round, or empty for the track's own name.
   *
   * Empty is the normal case and the right default: ACSM shows the track when
   * an event has no name, and champctl inventing one would go stale the moment
   * the track under it changed.
   */
  name: string
}

/** Long enough to finish typing a track name, short enough to feel live. */
const PREVIEW_DEBOUNCE_MS = 350

export function NewChampionship({
  onCreated,
  onAuthLost,
}: NewChampionshipProps): React.JSX.Element {
  const [sources, setSources] = useState<ChampionshipListItem[] | null>(null)
  /**
   * What the manager has installed, for the fields that ask for a folder name.
   *
   * `null` until the answer arrives, which is a different thing from empty:
   * the first time champctl talks to a manager it walks its `/cars` pages, and
   * a field that says "couldn't read what's installed" while that is still in
   * flight is saying something false.
   */
  const [installed, setInstalled] = useState<{
    cars: InstalledItem[]
    tracks: InstalledItem[]
    /** Null when champctl has no layout index — see `TrackList`. */
    layouts: Record<string, string[]> | null
  } | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  /**
   * The source's cars are still on their way.
   *
   * An empty car list means two different things and they need different
   * words: nothing has arrived yet, or somebody removed the last one. Without
   * this the screen said "this championship would have nothing to drive" for
   * the moment between picking a source and its cars landing, which is a
   * sentence about a mistake nobody had made.
   */
  const [sourceCarsPending, setSourceCarsPending] = useState(false)
  const [plan, setPlan] = useState<NewChampionshipPlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [creating, setCreating] = useState(false)
  const [done, setDone] = useState<NewChampionshipResponse | null>(null)
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

  // What's installed, in parallel and separately from the championship list.
  // Separately because the two fail differently and only one of them is fatal:
  // with no championships there is nothing to clone and the screen has no
  // purpose, while with no content index the pickers say they have nothing to
  // offer and the rest of the screen still works.
  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const content = await api.content()
        if (live) {
          setInstalled({ cars: content.cars, tracks: content.tracks, layouts: content.layouts })
        }
      } catch {
        // Deliberately quiet, and empty rather than left loading: `Picker`
        // says "champctl couldn't read what's installed" in the field itself,
        // which is where somebody wondering why the list is empty is already
        // looking.
        if (live) setInstalled({ cars: [], tracks: [], layouts: null })
      }
    })()
    return () => {
      live = false
    }
  }, [])

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
        .planNewChampionship(body, controller.signal)
        .then((res) => {
          if (mine !== generation.current) return
          setPlan(res.plan)
          setError(null)
        })
        .catch((e: unknown) => {
          if (controller.signal.aborted || mine !== generation.current) return
          // The request that failed is no longer what was last sent, or
          // retrying the identical draft would be ignored as a duplicate — and
          // a transient failure is exactly the case where someone presses the
          // same thing again. Same reasoning as the event screen.
          lastSent.current = null
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
   * to create a championship the fields on screen no longer describe. `lastSent` is
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
    setError(null)
    lastSent.current = null

    // Back to "Pick a championship…". Without clearing the draft the rest of
    // the form stayed on screen with nothing selected, which reads as though a
    // championship can be built from nothing — and is inconsistent with the
    // state this screen opens in, where the fields appear only once there is
    // something to clone.
    if (!id) {
      setDraft(null)
      return
    }

    setDraft({
      sourceId: id,
      // Blank rather than the source's name. "August 2026" sitting in a
      // September field is the kind of default that gets pushed.
      name: "",
      startDate: "",
      cars: [],
      description: "",
      tracks: [],
    })

    // The source's cars, so the field shows what would be inherited rather
    // than leaving it to be discovered after the championship exists. Unlike
    // the name, this default is one a league nearly always wants: the cars are
    // the part of a clone that stays the same.
    setSourceCarsPending(true)
    void (async () => {
      try {
        const { championship } = await api.championship(id)
        // Only if they are still on the same source. Picking one, changing
        // your mind, and having the first one's cars land a moment later is
        // the exact shape of bug the preview effect's `generation` exists for.
        setDraft((d) =>
          d && d.sourceId === id
            ? { ...d, cars: championship.cars, description: championship.description }
            : d,
        )
      } catch (e) {
        setError(describe(e))
      } finally {
        setSourceCarsPending(false)
      }
    })()
  }

  const create = async (): Promise<void> => {
    if (!plan) return
    setCreating(true)
    setError(null)
    try {
      const made = await api.createChampionship(plan.planId, acknowledged)
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
        <h1>Championship created</h1>
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
      <h1>New championship</h1>
      <p className="muted">
        Built from a past championship: same cars, same class, same format. Name it, say when it
        starts, and list the tracks.
      </p>

      <section>
        <h2>Clone from</h2>
        <label htmlFor="source">Clone from</label>
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
            with `champctl-championship build`.
          </p>
        )}
      </section>

      {draft && (
        <>
          <section>
            <h2>This championship</h2>
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

            <label htmlFor="description">Description</label>
            <textarea
              id="description"
              rows={4}
              value={draft.description}
              placeholder="Shown on the championship page in Server Manager."
              onChange={(e) => set({ description: e.target.value })}
            />
            <p className="fineprint">
              Cloned from the championship above. Clear it for no description at all.
            </p>
          </section>

          <CarList
            chosen={draft.cars}
            installed={installed?.cars ?? []}
            loading={installed === null}
            pending={sourceCarsPending}
            onChange={(cars) => set({ cars })}
          />

          <TrackList
            rows={draft.tracks}
            installed={installed?.tracks ?? []}
            layouts={installed?.layouts ?? null}
            loading={installed === null}
            onChange={(tracks) => set({ tracks })}
          />
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
              ? "Name it and add at least one track."
              : "Pick a championship to clone."}
          </p>
        )}
      </section>

      {plan && (
        <section>
          <h2>gridmom</h2>
          <Findings
            report={plan.gridmom}
            emptyLabel="gridmom has nothing to say about this championship."
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
 * The class car list.
 *
 * The field this screen was missing. A clone inherits the source's cars, which
 * is nearly always right and was entirely invisible — so the form asked which
 * tracks a season runs at and never mentioned what anyone would drive, which
 * is the one thing about a championship you cannot infer from the rest of it.
 *
 * A list rather than a single value because a class legitimately holds several
 * models: BATL's October 2025 Legends championship ran ten across seven models
 * actually driven (plan §4.4). Unordered, unlike tracks — `AvailableCars` is a
 * set, and offering to reorder it would imply a meaning it does not have.
 */
function CarList({
  chosen,
  installed,
  loading,
  pending,
  onChange,
}: {
  chosen: readonly string[]
  installed: readonly InstalledItem[]
  loading: boolean
  /** The source's cars have not arrived yet, which is not the same as none. */
  pending: boolean
  onChange: (cars: string[]) => void
}): React.JSX.Element {
  const nameOf = (id: string): string => installed.find((c) => c.id === id)?.name ?? id

  return (
    <section>
      <h2>Cars</h2>
      <p className="fineprint">
        Everything the class can drive. Cloned from the championship above; change it here.
      </p>

      {chosen.length > 0 && (
        <ul className="chips">
          {chosen.map((id) => (
            <li key={id}>
              <span>{nameOf(id)}</span>
              <span className="picker-id">{id}</span>
              <button
                type="button"
                className="icon"
                aria-label={`Remove ${nameOf(id)}`}
                onClick={() => onChange(chosen.filter((c) => c !== id))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <Picker
        label="Add a car"
        // Always empty: this picker adds to the list above rather than holding
        // a value of its own, so leaving the last pick in the box would read
        // as a car that is somehow chosen twice.
        value=""
        // Already-picked cars removed rather than shown and ignored. A list
        // that offers a car and then does nothing when you pick it reads as
        // broken.
        items={installed.filter((c) => !chosen.includes(c.id))}
        placeholder="Search installed cars"
        loading={loading}
        emptyHint="champctl couldn't read the cars installed on this manager."
        onChange={(id) => {
          if (id && !chosen.includes(id)) onChange([...chosen, id])
        }}
      />

      {chosen.length === 0 && (
        <p className="fineprint">
          {pending
            ? "Reading the cars from the championship above…"
            : "No cars chosen, so this championship would have nothing to drive. Add at least one."}
        </p>
      )}
    </section>
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
  installed,
  layouts,
  loading,
  onChange,
}: {
  rows: TrackRow[]
  installed: readonly InstalledItem[]
  /**
   * Track folder name to its layouts, or null when champctl has no index.
   *
   * A track absent from the map has one layout and needs no field. A null map
   * is champctl not knowing, which is not the same claim and must not render
   * as one.
   */
  layouts: Record<string, string[]> | null
  loading: boolean
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

  /**
   * Changing the track drops the layout with it.
   *
   * A layout belongs to one track — `indy` means nothing at Monza — so keeping
   * the old one would leave a round pointing at a track/layout pair the server
   * does not have, set by somebody who only changed the track.
   */
  const chooseTrack = (i: number, track: string): void => {
    update(i, { track, layout: "" })
  }

  return (
    <section>
      <h2>Tracks</h2>
      <p className="fineprint">One race night each, in this order.</p>

      <ol className="tracks">
        {rows.map((row, i) => (
          // The index is the identity here on purpose: rows have no id, and
          // two rounds at the same track is legal.
          // biome-ignore lint/suspicious/noArrayIndexKey: a row is its position
          <li key={i}>
            <span className="round-number">{i + 1}</span>
            <Picker
              label={`Round ${i + 1} track`}
              value={row.track}
              items={installed}
              placeholder="Search installed tracks"
              loading={loading}
              emptyHint="champctl couldn't read the tracks installed on this manager."
              onChange={(track) => chooseTrack(i, track)}
            />
            {/*
              Three states, because there are three things to say. ACSM lists
              layouts nowhere but the event edit form — see `web/layouts.ts` —
              so champctl either has that list or it does not.

              With the list: a picker when the track has a choice, and nothing
              at all when it does not, since a track the form never mentions
              has exactly one layout and `RaceSetup.TrackLayout` spells that as
              empty. A disabled box on those rounds would be a field that never
              does anything.

              Without it (`layouts === null`): a text box, once a track is
              chosen. Not a picker with nothing in it and not a hidden field —
              this is the case where champctl could not read the index, and a
              round at Brands Hatch still needs `indy` set. Free text is worse
              than a list and it is the only thing here that is not a dead end.
              Held back until there is a track because a layout belongs to one,
              and because an empty index also looks like this while the first
              read is still in flight.
            */}
            {layouts === null && row.track ? (
              <input
                type="text"
                aria-label={`Round ${i + 1} layout`}
                value={row.layout}
                placeholder="Layout, if any"
                onChange={(e) => update(i, { layout: e.target.value })}
              />
            ) : (layouts?.[row.track]?.length ?? 0) > 0 ? (
              <Picker
                label={`Round ${i + 1} layout`}
                value={row.layout}
                items={(layouts?.[row.track] ?? []).map((l) => ({ id: l, name: l }))}
                placeholder="Layout"
                onChange={(layout) => update(i, { layout })}
              />
            ) : (
              <span className="fineprint layout-none">{row.track ? "one layout" : ""}</span>
            )}
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
            {/*
              Its own line, via `grid-column: 1 / -1`, rather than a seventh
              column. Six controls already share this row on a screen built for
              a phone, and a name is a sentence rather than a token.
            */}
            <input
              className="round-name"
              type="text"
              aria-label={`Round ${i + 1} name`}
              value={row.name}
              placeholder="Round name (optional — blank shows the track)"
              onChange={(e) => update(i, { name: e.target.value })}
            />
          </li>
        ))}
      </ol>

      <button
        type="button"
        className="secondary"
        onClick={() => onChange([...rows, { track: "", layout: "", name: "" }])}
      >
        Add a round
      </button>
    </section>
  )
}

/**
 * The championship as it would be.
 *
 * The grid cap names the track that bound it, because "capped at 24" without
 * saying by what leaves someone guessing which track to go and change. The
 * derived list is here because "what did it decide for me?" is the question a
 * review screen exists to answer, and every entry in it was a real bug once.
 */
function Review({ plan }: { plan: NewChampionshipPlan }): React.JSX.Element {
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
 * screen's `requestFrom` refuses a half-filled quali time.
 *
 * The name is required *here* rather than left to the server.
 * `cloneChampionship` only refuses when the source itself has no name;
 * otherwise it inherits one, so sending a blank name would quietly create a
 * second championship called exactly what the first one is called — the
 * mistake this screen exists to make hard, not a refusal it can rely on.
 *
 * A blank track row is someone mid-type, not a request for a round at a track
 * called "".
 *
 * An empty car list is the same kind of thing. It means the source's cars
 * haven't arrived yet, or somebody has just removed the last one — and sending
 * no `cars` key would silently fall back to inheriting, so the screen would
 * show an empty Cars field and create a championship full of cars anyway.
 */
export function requestFrom(draft: Draft): {
  sourceId: string
  name: string
  startDate?: string
  cars?: string[]
  description?: string
  tracks?: TrackRequest[]
} | null {
  if (!draft.sourceId) return null
  const name = draft.name.trim()
  if (!name) return null

  const cars = draft.cars.map((c) => c.trim()).filter((c) => c !== "")
  if (cars.length === 0) return null

  const tracks = draft.tracks
    .map((r) => ({ track: r.track.trim(), layout: r.layout.trim(), name: r.name.trim() }))
    .filter((r) => r.track !== "")
  if (draft.tracks.length > 0 && tracks.length !== draft.tracks.length) return null
  if (draft.tracks.length === 0) return null

  return {
    sourceId: draft.sourceId,
    name,
    ...(draft.startDate ? { startDate: draft.startDate } : {}),
    cars,
    // Always sent, empty included: the server reads an absent key as "inherit
    // the source's", which is exactly what a cleared box is not asking for.
    description: draft.description,
    tracks: tracks.map((r) => ({
      track: r.track,
      ...(r.layout ? { layout: r.layout } : {}),
      ...(r.name ? { name: r.name } : {}),
    })),
  }
}
