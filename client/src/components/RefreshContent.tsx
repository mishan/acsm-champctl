import { useState } from "react"

import { useAuthAware } from "../App"
import { api } from "../api"
import { Message } from "./Message"

/**
 * Reads Server Manager's installed cars and tracks again now, for a car
 * installed there directly. Nobody waits on it but whoever pressed it: the
 * list in use stays until the new one is in.
 */
export function RefreshContent({ onAuthLost }: { onAuthLost: () => void }): React.JSX.Element {
  const [reading, setReading] = useState(false)
  const [said, setSaid] = useState<{ kind: "ok" | "error"; text: string } | null>(null)
  const describe = useAuthAware(onAuthLost)

  const refresh = async () => {
    setReading(true)
    setSaid(null)
    try {
      setSaid({ kind: "ok", text: (await api.refreshContent()).said })
    } catch (e) {
      setSaid({ kind: "error", text: describe(e) })
    } finally {
      setReading(false)
    }
  }

  return (
    <>
      <button type="button" className="secondary" disabled={reading} onClick={() => void refresh()}>
        {reading ? "Reading what's installed…" : "Re-read installed cars and tracks"}
      </button>
      {said && (
        <Message
          kind={said.kind}
          title={said.kind === "ok" ? "Read what's installed" : "Couldn't read what's installed"}
          body={said.text}
        />
      )}
    </>
  )
}
