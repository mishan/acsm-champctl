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
  const [query, setQuery] = useState("")
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

  // Every word somewhere in the name, so "civic 2026" finds "BATL November
  // 2026: Honda Civic SiR-II" without the words being typed in its order.
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = items.filter((c) => words.every((w) => c.name.toLowerCase().includes(w)))

  return (
    <>
      <label htmlFor="find" className="visually-hidden">
        Find a championship
      </label>
      <input
        id="find"
        type="search"
        placeholder="Find a championship"
        autoComplete="off"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {shown.length === 0 && <p className="muted">No championship's name has all of that.</p>}
      <ul className="list">
        {shown.map((c) => (
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
    </>
  )
}
