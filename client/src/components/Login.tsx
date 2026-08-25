import { useState } from "react"

import { api, type Config, type SessionState } from "../api"
import { Message } from "./Message"

interface LoginProps {
  config: Config
  onLoggedIn: (session: SessionState) => void
}

/**
 * The ACSM login, forwarded.
 *
 * Worth being plain about on screen, which is why the manager's URL is printed
 * under the form: these are the person's real ACSM credentials going to a
 * different host, and someone should be able to check they are handing them to
 * the manager they meant. champctl keeps the resulting cookie server-side for
 * an hour and stores nothing on disk; the browser only ever holds an opaque
 * handle.
 *
 * Permissions are whatever ACSM says they are. There is no role model here —
 * if the person can't edit championships in ACSM, the push fails in ACSM.
 */
export function Login({ config, onLoggedIn }: LoginProps): React.JSX.Element {
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = await api.login(username, password)
      onLoggedIn({ authenticated: true, ...result })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <form className="card" onSubmit={(e) => void submit(e)}>
        <h1>champctl</h1>
        <p className="muted">{config.league.name}</p>

        {error && <Message kind="error" title="Couldn't sign in" body={error} />}

        <label htmlFor="username">ACSM username</label>
        <input
          id="username"
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />

        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />

        <button type="submit" className="primary" disabled={busy || !username}>
          {busy ? "Signing in…" : "Sign in"}
        </button>

        <p className="fineprint">
          These go to <code>{config.baseUrl}</code>. champctl holds the session for an hour and
          writes nothing to disk.
        </p>
      </form>
    </div>
  )
}
