import { useEffect, useState } from "react"

import { useAuthAware } from "../App"
import { api, type ChampionshipListItem } from "../api"
import { Message } from "./Message"

interface ChampionshipListProps {
  onOpen: (id: string) => void
  onAuthLost: () => void
}

export function ChampionshipList({ onOpen, onAuthLost }: ChampionshipListProps): React.JSX.Element {
  const [items, setItems] = useState<ChampionshipListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const describe = useAuthAware(onAuthLost)

  useEffect(() => {
    void (async () => {
      try {
        setItems((await api.championships()).championships)
      } catch (e) {
        setError(describe(e))
      }
    })()
  }, [describe])

  if (error) return <Message kind="error" title="Couldn't list championships" body={error} />
  if (!items) return <p className="muted">Loading championships…</p>
  if (items.length === 0) {
    return <Message kind="info" title="No championships" body="This manager has none yet." />
  }

  return (
    <ul className="list">
      {items.map((c) => (
        <li key={c.id}>
          <button type="button" className="row" onClick={() => onOpen(c.id)}>
            <span className="row-main">{c.name}</span>
            <span className="row-chevron" aria-hidden="true">
              ›
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
