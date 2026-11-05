import { useState } from "react"

import { api, type LiveriesHaltView, type SpectatorPlanResponse } from "../api"
import { Message } from "./Message"

interface SpectatorCarsProps {
  championshipId: string
  /** Set when a save went wrong and champctl has stopped writing this championship. */
  halt: LiveriesHaltView | null
  /** True when gridmom says one of the league's spectator cars is missing. */
  missing: boolean
  /** Called once the championship has changed, to read it again. */
  onChanged: () => void
  describe: (e: unknown) => string
}

/**
 * The league's spectator cars, added from here, and the halt that stops it.
 *
 * Adding is preview then confirm, like every other write here: the preview
 * says which cars, from the league's profile, and what the save also does to
 * the ones already there. The halt is here because the staff who'd check a
 * championship after a bad save have no CLI to lift it with.
 */
export function SpectatorCars({
  championshipId,
  halt,
  missing,
  onChanged,
  describe,
}: SpectatorCarsProps): React.JSX.Element | null {
  const [preview, setPreview] = useState<SpectatorPlanResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (f: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await f()
    } catch (e) {
      setError(describe(e))
    } finally {
      setBusy(false)
    }
  }

  const failure = error && <Message kind="error" title="That didn't work" body={error} />

  if (halt) {
    return (
      <Message
        kind="error"
        title="champctl has stopped writing this championship"
        body={
          `Since ${new Date(halt.haltedAt).toLocaleString()}, after a save that went wrong: ` +
          `${halt.reason}`
        }
      >
        <p>
          Nothing champctl does will write it, liveries included, until someone has checked it in
          Server Manager, or restored it, and resumes it here.
        </p>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => {
            if (!window.confirm("Has the championship been checked, or restored?")) return
            void run(async () => {
              await api.clearLiveriesHalt(championshipId)
              onChanged()
            })
          }}
        >
          Resume
        </button>
        {failure}
      </Message>
    )
  }

  if (preview) {
    return (
      <Message kind="info" title="Add the league's spectator cars">
        <ul>
          {preview.cars.map((c) => (
            <li key={c.guid}>
              {c.name}, in {c.model} ({c.guid})
            </li>
          ))}
        </ul>
        {preview.effects.length > 0 && (
          <ul>
            {preview.effects.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
        <div className="actions">
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api.addSpectators(preview.planId)
                setPreview(null)
                onChanged()
              })
            }
          >
            {busy ? "Adding…" : "Add"}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              setPreview(null)
              setError(null)
            }}
          >
            Cancel
          </button>
        </div>
        {failure}
      </Message>
    )
  }

  if (!missing) return null
  return (
    <>
      <button
        type="button"
        className="secondary"
        disabled={busy}
        onClick={() => void run(async () => setPreview(await api.planSpectators(championshipId)))}
      >
        Add the missing spectator cars
      </button>
      {failure}
    </>
  )
}
