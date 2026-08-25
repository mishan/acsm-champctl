import { useCallback, useEffect, useRef, useState } from "react"

import { type Draft, requestFrom } from "../draft.js"

import { useAuthAware } from "../App"
import {
  ApiFailure,
  api,
  type ApplyResponse,
  type Config,
  type FormatPreset,
  type PlanView,
  type RoundView,
} from "../api"
import { describeFormat, describeLength } from "../format"
import { Findings } from "./Findings"
import { Message } from "./Message"

/**
 * The weekly flow (plan §5.2): set the format the racers voted for, see exactly
 * what changes, push it.
 *
 * The target is under a minute, on a phone, from a Discord poll result, which
 * is what shapes almost every decision below — presets before fields, the
 * preview always on screen rather than behind a button, one push at the bottom.
 *
 * Three things this screen is careful about, all of them about not lying:
 *
 * **The preview is the server's, not a guess.** `plan.changes` and
 * `plan.formChanges` are computed from the event's actual edit form. The screen
 * renders them; it does not work out what a change would do.
 *
 * **A preview writes nothing.** Editing a field re-previews freely because
 * previewing is a read. The only request that writes is the one behind the push
 * button, and it sends a plan id rather than the fields — so what lands is what
 * was on screen.
 *
 * **A push can half-land.** Moving quali is a second request to a different
 * endpoint, because the event submit form doesn't carry `Scheduled`. The screen
 * says so before the push and reports which halves went through after it.
 */

interface FinalizeProps {
  championshipId: string
  round: number
  config: Config
  onBack: () => void
  onAuthLost: () => void
}

/**
 * The form's own state, with numbers held as strings.
 *
 * A number input has to be allowed to be empty while someone is retyping it.
 * Holding these as numbers meant an empty field became `0` — and a zero-lap
 * race is a race with no end condition, which is exactly the value that must
 * never be previewed confidently, let alone sent.
 */

function draftFrom(round: RoundView): Draft {
  const f = round.format
  return {
    lengthKind: f.length.kind,
    laps: f.length.kind === "laps" ? String(f.length.laps) : "",
    minutes: f.length.kind === "minutes" ? String(f.length.minutes) : "",
    reversed: String(f.reversedGridPositions),
    mandatoryPit: f.mandatoryPit,
    extraLap: f.extraLap,
    qualiDate: round.quali?.date ?? "",
    qualiTime: round.quali?.time ?? "",
  }
}

function applyPreset(draft: Draft, preset: FormatPreset): Draft {
  return {
    ...draft,
    lengthKind: preset.length.kind,
    laps: preset.length.kind === "laps" ? String(preset.length.laps) : draft.laps,
    minutes: preset.length.kind === "minutes" ? String(preset.length.minutes) : draft.minutes,
    reversed: String(preset.reversedGridPositions),
    mandatoryPit: preset.mandatoryPit,
    extraLap: preset.extraLap,
  }
}

/** Long enough to finish typing "18", short enough to feel live. */
const PREVIEW_DEBOUNCE_MS = 350

export function Finalize({
  championshipId,
  round,
  config,
  onBack,
  onAuthLost,
}: FinalizeProps): React.JSX.Element {
  const [current, setCurrent] = useState<RoundView | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [plan, setPlan] = useState<PlanView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [pushing, setPushing] = useState(false)
  const [done, setDone] = useState<ApplyResponse | null>(null)
  const describe = useAuthAware(onAuthLost)

  /** What was last asked for, so seeding the form doesn't ask for it again. */
  const lastSent = useRef<string | null>(null)

  /**
   * Which load is current.
   *
   * A counter rather than a per-effect `cancelled` flag, because the reload
   * button starts a load too. Both paths bump it, so whichever started last
   * wins and an earlier answer that arrives late is dropped instead of
   * overwriting a newer one.
   */
  const generation = useRef(0)

  // Open the round. An empty body is a preview of no change, which is the
  // cheapest way to get the round's current state, a gridmom report on it, and
  // a plan to start from, in one request.
  const load = useCallback(() => {
    const mine = ++generation.current
    setCurrent(null)
    setDraft(null)
    setPlan(null)
    setDone(null)
    setError(null)
    setAcknowledged(false)
    lastSent.current = null

    void (async () => {
      try {
        const res = await api.plan(championshipId, round, {})
        if (mine !== generation.current) return
        const seeded = draftFrom(res.round)
        lastSent.current = JSON.stringify(requestFrom(seeded))
        setCurrent(res.round)
        setDraft(seeded)
        setPlan(res.plan)
      } catch (e) {
        if (mine === generation.current) setError(describe(e))
      }
    })()
  }, [championshipId, round, describe])

  useEffect(load, [load])

  // Re-preview as the form changes. Debounced, and the previous request is
  // aborted — an answer to a question the person has already moved on from must
  // not be allowed to overwrite the answer to the one they are looking at.
  useEffect(() => {
    if (!draft) return
    const body = requestFrom(draft)
    if (!body) return

    const serialised = JSON.stringify(body)
    if (serialised === lastSent.current) return

    const controller = new AbortController()
    const timer = setTimeout(() => {
      lastSent.current = serialised
      setPreviewing(true)
      api
        .plan(championshipId, round, body, controller.signal)
        .then((res) => {
          setPlan(res.plan)
          setError(null)
          // A change to what is about to be pushed retires any acknowledgement
          // of the old one. Ticking a box about last preview's warnings and
          // then pushing a different change is not a thing anyone agreed to.
          setAcknowledged(false)
        })
        .catch((e: unknown) => {
          if (e instanceof DOMException && e.name === "AbortError") return
          // The request that failed is no longer what was last sent, or a
          // retype of the same value would be ignored as a duplicate.
          lastSent.current = null
          setError(describe(e))
        })
        .finally(() => setPreviewing(false))
    }, PREVIEW_DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [draft, championshipId, round, describe])

  const push = async (): Promise<void> => {
    if (!plan) return
    setPushing(true)
    setError(null)
    try {
      setDone(await api.apply(plan.planId, acknowledged))
    } catch (e) {
      if (e instanceof ApiFailure && e.code === "entry-list-changed") {
        // The one failure with a specific remedy: the entry list moved under
        // the preview, nothing was written, and the only safe next step is to
        // look again. The plan is already gone server-side, so the retry
        // button reloads rather than re-pushing.
        setPlan(null)
      }
      setError(describe(e))
    } finally {
      setPushing(false)
    }
  }

  if (error && !draft) {
    return (
      <>
        <BackLink onBack={onBack} />
        <Message kind="error" title="Couldn't open that round" body={error} />
      </>
    )
  }

  if (!draft || !current) {
    return (
      <>
        <BackLink onBack={onBack} />
        <p className="muted">Loading round {round}…</p>
      </>
    )
  }

  if (done) {
    return (
      <>
        <BackLink onBack={onBack} />
        <Message
          kind="ok"
          title={
            done.eventSaved || done.scheduleSaved ? "Pushed to ACSM" : "Nothing needed changing"
          }
        >
          <ul className="changes">
            {done.changes.map((c) => (
              <li key={c.label}>
                {c.label}: {c.before} → {c.after}
              </li>
            ))}
          </ul>
          <p className="muted">
            {done.eventSaved ? "Event saved" : "Event unchanged"}
            {done.scheduleSaved ? ", schedule saved" : ""}.
          </p>
        </Message>
        <button type="button" className="primary" onClick={onBack}>
          Back to rounds
        </button>
      </>
    )
  }

  /**
   * Every edit to the form, and the only place a draft changes after loading.
   *
   * Retires the current plan immediately, which is what keeps the push button
   * honest. `previewing` alone did not: it is false during the 350ms debounce,
   * false again after a preview fails, and never set at all for a draft the
   * client rejects before sending. In each of those the old plan was still
   * present and still pushable, while the fields and any error on screen
   * described a different change — so the button would have applied a format
   * the person could no longer see.
   *
   * Dropping the acknowledgement with it, for the same reason the preview
   * response does: a box ticked about the previous change's warnings is not
   * agreement to this one.
   */
  const set = (patch: Partial<Draft>): void => {
    setDraft({ ...draft, ...patch })
    setPlan(null)
    setAcknowledged(false)
  }
  const blocked = plan?.blocked === true
  const needsAck = plan?.needsAcknowledgement === true
  const nothingToDo = plan?.noop === true
  const canPush =
    plan !== null &&
    !blocked &&
    !nothingToDo &&
    !pushing &&
    !previewing &&
    (!needsAck || acknowledged)

  return (
    <>
      <BackLink onBack={onBack} />

      <h1>
        <span className="round-number">{round}</span>
        {current.track || "no track set"}
      </h1>
      <p className="muted">
        Currently {describeFormat(current.format)}
        {current.quali ? ` · quali ${current.quali.display}` : " · unscheduled"}
        {current.started && " · this round has already run"}
      </p>

      {current.started && (
        <Message
          kind="error"
          title="This round has already been run"
          body="Changing its format now edits history rather than a race night, and the results are already recorded against it. Check you meant this round."
        />
      )}

      {config.formats.length > 0 && (
        <section>
          <h2>Preset</h2>
          <div className="presets">
            {config.formats.map((p) => (
              <button
                key={p.name}
                type="button"
                className="preset"
                onClick={() => set(applyPreset(draft, p))}
              >
                <strong>{p.name}</strong>
                <span>{describeFormat(p)}</span>
              </button>
            ))}
          </div>
          <p className="fineprint">
            Starting points, from {config.league.name}'s profile. Everything stays editable.
          </p>
        </section>
      )}

      <section>
        <h2>Race</h2>

        <fieldset className="segmented">
          <legend>Measured in</legend>
          <label className={draft.lengthKind === "laps" ? "on" : ""}>
            <input
              type="radio"
              name="lengthKind"
              checked={draft.lengthKind === "laps"}
              onChange={() => set({ lengthKind: "laps" })}
            />
            Laps
          </label>
          <label className={draft.lengthKind === "minutes" ? "on" : ""}>
            <input
              type="radio"
              name="lengthKind"
              checked={draft.lengthKind === "minutes"}
              onChange={() => set({ lengthKind: "minutes" })}
            />
            Minutes
          </label>
        </fieldset>

        <label htmlFor="length">{draft.lengthKind === "laps" ? "Laps" : "Minutes"}</label>
        <input
          id="length"
          type="number"
          inputMode="numeric"
          min={1}
          value={draft.lengthKind === "laps" ? draft.laps : draft.minutes}
          onChange={(e) =>
            set(
              draft.lengthKind === "laps" ? { laps: e.target.value } : { minutes: e.target.value },
            )
          }
        />

        <label htmlFor="reversed">Reversed grid positions</label>
        <input
          id="reversed"
          type="number"
          inputMode="numeric"
          min={0}
          value={draft.reversed}
          onChange={(e) => set({ reversed: e.target.value })}
        />
        <p className="fineprint">0 is a single race. Anything above it adds a second one.</p>

        <label className="check">
          <input
            type="checkbox"
            checked={draft.mandatoryPit}
            onChange={(e) => set({ mandatoryPit: e.target.checked })}
          />
          Mandatory pit stop
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.extraLap}
            onChange={(e) => set({ extraLap: e.target.checked })}
          />
          Extra lap
        </label>
      </section>

      <section>
        <h2>Quali</h2>
        <div className="pair">
          <div>
            <label htmlFor="qualiDate">Date</label>
            <input
              id="qualiDate"
              type="date"
              value={draft.qualiDate}
              onChange={(e) => set({ qualiDate: e.target.value })}
            />
          </div>
          <div>
            <label htmlFor="qualiTime">Start</label>
            <input
              id="qualiTime"
              type="time"
              value={draft.qualiTime}
              onChange={(e) => set({ qualiTime: e.target.value })}
            />
          </div>
        </div>
        {/*
          Said out loud because getting it wrong is an hour, every time. ACSM's
          `Scheduled` is practice start, not quali start; champctl takes the
          quali time and subtracts the practice length.
        */}
        <p className="fineprint">
          {current.practiceMinutes} minutes of practice run before this, in {config.timezone}. What
          ACSM stores is practice start, so champctl sets that to {current.practiceMinutes} minutes
          before the time above.
        </p>
      </section>

      <section aria-live="polite">
        <h2>
          What changes{" "}
          {/* The section is aria-live, so the wording below announces itself;
              the spinner is decoration and says so. */}
          {previewing && <span className="spinner spinner-inline" aria-hidden="true" />}
        </h2>

        {error && (
          <Message kind="error" title="champctl refused this" body={error}>
            {/*
              Only when there is no plan left to push. The entry-list refusal
              lands here: the plan is already gone server-side, so the way
              forward is a fresh look rather than a retry of the same push.
            */}
            {plan === null && (
              <button type="button" className="secondary" onClick={load}>
                Reload the round
              </button>
            )}
          </Message>
        )}

        {plan && <Preview plan={plan} />}
      </section>

      {plan && (
        <section>
          <h2>gridmom</h2>
          <Findings
            report={plan.gridmom}
            emptyLabel="gridmom has nothing to say about this round as it would be."
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
        <button type="button" className="primary" disabled={!canPush} onClick={() => void push()}>
          {pushing
            ? "Pushing…"
            : blocked
              ? "Blocked by an error"
              : nothingToDo
                ? "Nothing to change"
                : "Push to ACSM"}
        </button>
        {blocked && (
          <p className="fineprint">
            An error means this would produce a broken or unfair race. Nothing overrides it — fix
            the cause and preview again.
          </p>
        )}
      </div>
    </>
  )
}

/**
 * The diff, in two registers.
 *
 * The sentences are what a person checks. The field list underneath is what
 * will actually be posted, and it is here so the preview cannot quietly do
 * more than it claims: if a save would send something the sentences didn't
 * mention, it shows up as a row.
 */
function Preview({ plan }: { plan: PlanView }): React.JSX.Element {
  if (plan.noop) {
    return <p className="muted">Nothing to change; the round already matches.</p>
  }

  return (
    <>
      <ul className="changes">
        {plan.changes.map((c) => (
          <li key={c.label}>
            <span className="change-label">{c.label}</span>
            <span className="change-before">{c.before}</span>
            <span aria-hidden="true">→</span>
            <span className="change-after">{c.after}</span>
          </li>
        ))}
        {plan.schedule && (
          <li>
            <span className="change-label">Quali</span>
            <span className="change-before">{plan.schedule.from ?? "unscheduled"}</span>
            <span aria-hidden="true">→</span>
            <span className="change-after">{plan.schedule.to}</span>
          </li>
        )}
      </ul>

      <details className="fields">
        <summary>
          {/*
            Counts fields, not requests. Adding 1 for "there is a schedule
            request" made the summary claim fewer fields than the list directly
            below it renders — the schedule sends four (date, time, timezone,
            recurrence), so a header saying one sat immediately above four.
          */}
          Fields that will be posted (
          {plan.formChanges.length + (plan.schedule?.fields.length ?? 0)})
        </summary>
        <ul>
          {plan.formChanges.map((f) => (
            <li key={f.name}>
              <code>{f.name}</code>
              <span>
                {f.before ?? "(absent)"} → {f.after}
              </span>
            </li>
          ))}
        </ul>
        {plan.schedule && (
          <>
            {/*
              The event submit form doesn't carry `Scheduled`, so moving quali
              is a second POST to a different endpoint. Saying so before the
              push is what makes a half-finished write comprehensible if it
              happens: the event save goes first, and if it fails the schedule
              is untouched.
            */}
            <p className="fineprint">
              …plus a second request to the schedule endpoint, sent after the event save:
            </p>
            <ul>
              {plan.schedule.fields.map((f) => (
                <li key={f.name}>
                  <code>{f.name}</code>
                  <span>{f.value || "(blank)"}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </details>
    </>
  )
}

function BackLink({ onBack }: { onBack: () => void }): React.JSX.Element {
  return (
    <button type="button" className="link back" onClick={onBack}>
      ‹ Rounds
    </button>
  )
}

/** Re-exported for the round list's row label. */
export { describeLength }
