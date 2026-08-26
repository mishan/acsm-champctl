import { useEffect, useId, useMemo, useRef, useState } from "react"

import type { InstalledItem } from "../api"

/**
 * Pick one installed thing by typing the name you know it by.
 *
 * The problem this solves is small and was the whole reason the create screen
 * was unusable: a championship stores folder names — `ks_brands_hatch`,
 * `rss_formula_hybrid_2021` — and nobody knows them. A plain text input asks
 * for a string you can only get by going and looking at ACSM, and gets a typo
 * that surfaces as a race night nobody can join.
 *
 * So: search what the manager says is installed, by display name *and* by
 * folder name, and commit the folder name. Both, because "Brands Hatch" is
 * what a person types and `ks_brands` is what someone who already knows the
 * content types — and matching only the pretty name would be a step backwards
 * for the second group.
 *
 * **A value is only ever one of the offered items.** Typing is a filter, not
 * an entry: blurring with half a name in the box leaves the field as it was
 * rather than committing something the server does not have. That is the
 * deliberate trade — a car the index misses cannot be entered at all — and it
 * is why `emptyHint` exists to say so out loud rather than presenting an empty
 * list as if nothing matched.
 *
 * Not a `<datalist>`, which is the obvious thing and does not work here: it
 * matches on the input's *value*, so searching by display name while
 * submitting a folder name is exactly what it cannot express. Not a library
 * either — this is a listbox with four keys.
 */

interface PickerProps {
  label: string
  /** The folder name currently chosen, or "" for none. */
  value: string
  items: readonly InstalledItem[]
  onChange: (id: string) => void
  placeholder?: string
  /** Said when there is nothing to pick from at all, rather than no match. */
  emptyHint?: string
  /** Reflected onto the input, for `getByLabel` and for screen readers. */
  id?: string
}

/** Enough to scroll without turning the page into a list of every car. */
const MAX_SUGGESTIONS = 50

export function Picker({
  label,
  value,
  items,
  onChange,
  placeholder,
  emptyHint,
  id,
}: PickerProps): React.JSX.Element {
  const generated = useId()
  const inputId = id ?? generated
  const listId = `${inputId}-listbox`

  const [query, setQuery] = useState("")
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const box = useRef<HTMLDivElement>(null)

  const chosen = useMemo(() => items.find((i) => i.id === value), [items, value])

  // What the box shows when it isn't being typed in: the name, because that is
  // what the person recognises. A chosen id the index doesn't know still shows
  // *something* — a championship cloned from one that raced a since-removed car
  // should say so rather than render as blank.
  const settled = chosen ? chosen.name : value

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items.slice(0, MAX_SUGGESTIONS)
    return items
      .filter((i) => i.name.toLowerCase().includes(q) || i.id.toLowerCase().includes(q))
      .slice(0, MAX_SUGGESTIONS)
  }, [items, query])

  // Closing on an outside click rather than on blur. Blur fires before the
  // click that caused it lands, so a mousedown on a suggestion closed the list
  // and the click then hit whatever had moved into that spot.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [open])

  const commit = (item: InstalledItem): void => {
    onChange(item.id)
    setQuery("")
    setOpen(false)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      const step = e.key === "ArrowDown" ? 1 : -1
      setActive((a) => (matches.length === 0 ? 0 : (a + step + matches.length) % matches.length))
      return
    }
    if (e.key === "Enter") {
      // Only when the list is open and something is highlighted. Enter in a
      // closed picker belongs to the form, not to us.
      const item = open ? matches[active] : undefined
      if (item) {
        e.preventDefault()
        commit(item)
      }
      return
    }
    if (e.key === "Escape" && open) {
      e.preventDefault()
      setQuery("")
      setOpen(false)
    }
  }

  const nothingInstalled = items.length === 0

  return (
    <div className="picker" ref={box}>
      <label htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        type="text"
        role="combobox"
        autoComplete="off"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        {...(open && matches[active] ? { "aria-activedescendant": `${listId}-${active}` } : {})}
        disabled={nothingInstalled}
        placeholder={nothingInstalled ? "" : placeholder}
        // The query while typing, the chosen name otherwise. One input rather
        // than a chip plus a search box: this is a phone-first screen, and the
        // field is the thing under the thumb.
        value={open ? query : settled}
        onChange={(e) => {
          setQuery(e.target.value)
          setActive(0)
          setOpen(true)
        }}
        onFocus={() => {
          setQuery("")
          setActive(0)
          setOpen(true)
        }}
        onKeyDown={onKeyDown}
      />

      {nothingInstalled && emptyHint && <p className="fineprint">{emptyHint}</p>}

      {open && (
        // `div`s rather than a `ul`: in a combobox that keeps focus on the
        // input and points at the highlighted option with
        // `aria-activedescendant`, the list is not a list of list items, and
        // saying so makes a screen reader announce it twice.
        <div className="picker-list" id={listId} role="listbox" aria-label={label}>
          {matches.map((item, i) => (
            <div
              key={item.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              // Focusable but never a tab stop. Focus stays on the input for
              // the whole interaction; this is what the pattern asks for.
              tabIndex={-1}
              className={i === active ? "active" : undefined}
              // mousedown, not click: the input's focus handler would otherwise
              // re-open and reset the list out from under the click.
              onMouseDown={(e) => {
                e.preventDefault()
                commit(item)
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="picker-name">{item.name}</span>
              {/* The folder name, because it is what gets stored and what
                  someone comparing against ACSM will be looking for. */}
              <span className="picker-id">{item.id}</span>
            </div>
          ))}
          {matches.length === 0 && (
            <div className="picker-empty">Nothing installed matches that.</div>
          )}
        </div>
      )}
    </div>
  )
}
