import { useCallback, useEffect, useState } from "react"

import { api, isAuthFailure, type Config, type SessionState } from "./api"
import { ChampionshipList } from "./components/ChampionshipList"
import { EventEditor } from "./components/EventEditor"
import { Login } from "./components/Login"
import { NewChampionship } from "./components/NewChampionship"
import { Message } from "./components/Message"
import { RoundList } from "./components/RoundList"
import { useRoute } from "./route"

/**
 * Everything above the three screens: who is logged in, which league this is,
 * and getting back to the login form when a session dies mid-flow.
 *
 * That last one is the only interesting part. A champctl session lasts an hour
 * and an ACSM one can be revoked sooner, so "you were logged in when this
 * screen opened and you are not now" is an ordinary event rather than an edge
 * case. Every screen reports it upward through `onAuthLost` instead of
 * rendering its own version of a login prompt, so there is one place that knows
 * what to do about it and one login form in the app.
 */
export function App(): React.JSX.Element {
  const [config, setConfig] = useState<Config | null>(null)
  const [session, setSession] = useState<SessionState | null>(null)
  const [fatal, setFatal] = useState<string | null>(null)
  const [route, navigate] = useRoute()

  useEffect(() => {
    void (async () => {
      try {
        const [cfg, s] = await Promise.all([api.config(), api.session()])
        setConfig(cfg)
        setSession(s)
      } catch (e) {
        setFatal(e instanceof Error ? e.message : String(e))
      }
    })()
  }, [])

  const onAuthLost = useCallback(() => setSession({ authenticated: false }), [])

  const logout = useCallback(async () => {
    // The local state changes whatever the request does. A logout that failed
    // on the network must not leave someone looking at a screen that says they
    // are still signed in.
    try {
      await api.logout()
    } finally {
      setSession({ authenticated: false })
      navigate({ name: "home" })
    }
  }, [navigate])

  if (fatal) return <Message kind="error" title="champctl couldn't start" body={fatal} />
  if (!config || !session) return <Splash />

  if (!session.authenticated) {
    return <Login config={config} onLoggedIn={(s) => setSession(s)} />
  }

  return (
    <div className="app">
      <header className="bar">
        <button
          type="button"
          className="bar-title"
          onClick={() => navigate({ name: "home" })}
          disabled={route.name === "home"}
        >
          champctl
        </button>
        <span className="bar-league">{config.league.name}</span>
        <button type="button" className="link" onClick={() => void logout()}>
          {session.username} · sign out
        </button>
      </header>

      <main>
        {route.name === "home" && (
          <>
            <div className="actions">
              <button
                type="button"
                className="secondary"
                onClick={() => navigate({ name: "new-championship" })}
              >
                New championship
              </button>
            </div>
            <ChampionshipList
              onOpen={(id) => navigate({ name: "championship", id })}
              onAuthLost={onAuthLost}
            />
          </>
        )}
        {route.name === "new-championship" && (
          <NewChampionship
            onCreated={(id) => navigate({ name: "championship", id })}
            onAuthLost={onAuthLost}
          />
        )}
        {route.name === "championship" && (
          <RoundList
            championshipId={route.id}
            onOpenRound={(round) => navigate({ name: "round", id: route.id, round })}
            onAuthLost={onAuthLost}
          />
        )}
        {route.name === "round" && (
          <EventEditor
            championshipId={route.id}
            round={route.round}
            config={config}
            onBack={() => navigate({ name: "championship", id: route.id })}
            onAuthLost={onAuthLost}
          />
        )}
      </main>
    </div>
  )
}

function Splash(): React.JSX.Element {
  return (
    <div className="splash">
      <span className="spinner" aria-hidden="true" />
      <p>Loading champctl…</p>
    </div>
  )
}

/** Shared by every screen that loads something it might not be allowed to. */
export function useAuthAware(onAuthLost: () => void): (e: unknown) => string {
  return useCallback(
    (e: unknown) => {
      if (isAuthFailure(e)) onAuthLost()
      return e instanceof Error ? e.message : String(e)
    },
    [onAuthLost],
  )
}
