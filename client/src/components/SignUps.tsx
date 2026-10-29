import { useEffect, useState } from "react"

import { useAuthAware } from "../App"
import { api, ApiFailure, type SignUpView, type SignUpsResponse } from "../api"
import { Message } from "./Message"

interface SignUpsProps {
  championshipId: string
  onBack: () => void
  onAuthLost: () => void
}

/**
 * A championship's sign-ups, to accept or reject without opening Server
 * Manager. The server refuses what ACSM would get wrong — see
 * `signups/queue.ts` — so this screen only has to say why.
 */
export function SignUps({ championshipId, onBack, onAuthLost }: SignUpsProps): React.JSX.Element {
  const [data, setData] = useState<SignUpsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** The sign-up being sent, or "all" for Accept all; one at a time. */
  const [busy, setBusy] = useState<string | null>(null)
  const describe = useAuthAware(onAuthLost)
  // For the cars' names. Without them the rows show folder names.
  const [cars, setCars] = useState<ReadonlyMap<string, string>>(new Map())

  useEffect(() => {
    let live = true
    api.content().then(
      (c) => live && setCars(new Map(c.cars.map((car) => [car.id, car.name]))),
      () => {},
    )
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    let live = true
    api.signUps(championshipId).then(
      (d) => live && setData(d),
      (e: unknown) => live && setError(describe(e)),
    )
    return () => {
      live = false
    }
  }, [championshipId, describe])

  /** True when it went through, so Accept all knows to carry on. */
  const act = async (u: SignUpView, action: "accept" | "reject"): Promise<boolean> => {
    setError(null)
    try {
      setData(await api.signUpAction(championshipId, u.guid, { action }))
      return true
    } catch (e) {
      // Rejecting a seated driver takes their seat, so the server asks first.
      if (
        e instanceof ApiFailure &&
        e.code === "would-unseat" &&
        window.confirm(`${e.message} Reject anyway?`)
      ) {
        try {
          setData(await api.signUpAction(championshipId, u.guid, { action, confirm: true }))
          return true
        } catch (again) {
          setError(describe(again))
          return false
        }
      }
      setError(describe(e))
      return false
    }
  }

  const one = async (u: SignUpView, action: "accept" | "reject"): Promise<void> => {
    setBusy(u.guid)
    await act(u, action)
    setBusy(null)
  }

  if (!data) {
    return (
      <>
        <BackLink onBack={onBack} />
        {error ? (
          <Message kind="error" title="Couldn't read the sign-ups" body={error} />
        ) : (
          <p className="muted">Reading the sign-ups…</p>
        )}
      </>
    )
  }

  const pending = data.signUps.filter((u) => u.status === "Pending Approval")
  const decided = data.signUps.filter((u) => u.status !== "Pending Approval")
  const acceptable = pending.filter((u) => !u.cantAccept)

  // One after another, re-checked by the server each time: each accept takes a
  // seat, and the next one may no longer have one.
  const acceptAll = async (): Promise<void> => {
    setBusy("all")
    for (const u of acceptable) if (!(await act(u, "accept"))) break
    setBusy(null)
  }

  return (
    <>
      <BackLink onBack={onBack} />
      <h1>Sign-ups</h1>
      <p className="muted">{data.championship.name}</p>
      {!data.open && (
        <Message kind="info" title="Sign-ups are switched off for this championship." />
      )}
      {error && <Message kind="error" title="That didn't go through" body={error} />}

      <h2>Waiting ({pending.length})</h2>
      {pending.length === 0 && <p className="muted">Nobody is waiting.</p>}
      <ul className="list">
        {pending.map((u) => (
          <li key={u.guid}>
            <SignUpRow u={u} cars={cars}>
              {u.cantAccept && <p className="fineprint">{u.cantAccept}</p>}
              <div className="signup-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={busy !== null || Boolean(u.cantAccept)}
                  onClick={() => void one(u, "accept")}
                >
                  {busy === u.guid ? "Working…" : "Accept"}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy !== null}
                  onClick={() => void one(u, "reject")}
                >
                  Reject
                </button>
              </div>
            </SignUpRow>
          </li>
        ))}
      </ul>
      {acceptable.length > 1 && (
        <button
          type="button"
          className="primary"
          disabled={busy !== null}
          onClick={() => void acceptAll()}
        >
          {busy === "all" ? "Accepting…" : `Accept all ${acceptable.length}`}
        </button>
      )}

      {decided.length > 0 && (
        <details className="derived">
          <summary>Decided ({decided.length})</summary>
          <ul className="list">
            {decided.map((u) => (
              <li key={u.guid}>
                <SignUpRow u={u} cars={cars} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  )
}

function SignUpRow({
  u,
  cars,
  children,
}: {
  u: SignUpView
  cars: ReadonlyMap<string, string>
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="row row-static signup">
      <span className="row-main">
        <span className="row-title">
          {u.name || u.guid}
          {u.status !== "Pending Approval" && <span className="tag">{u.status.toLowerCase()}</span>}
          {u.seated && u.status === "Pending Approval" && <span className="tag">has a seat</span>}
        </span>
        <span className="row-sub">
          {[
            cars.get(u.car) ?? u.car,
            u.skin && `skin ${u.skin}`,
            u.team,
            u.created && new Date(u.created).toLocaleDateString(),
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
        {u.questions.length > 0 && (
          <dl className="signup-answers">
            {u.questions.map((q) => (
              <div key={q.question}>
                <dt>{q.question}</dt>
                <dd>{q.answer || "—"}</dd>
              </div>
            ))}
          </dl>
        )}
        {children}
      </span>
    </div>
  )
}

function BackLink({ onBack }: { onBack: () => void }): React.JSX.Element {
  return (
    <button type="button" className="link back" onClick={onBack}>
      ‹ Rounds
    </button>
  )
}
