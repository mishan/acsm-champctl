/**
 * Reordering a list by dragging, with the arithmetic kept out of the DOM.
 *
 * Three pure functions and a hook over them. The split is not tidiness: jsdom
 * performs no layout, so every `getBoundingClientRect` in a component test
 * comes back as zeroes and a drag driven through the DOM cannot tell "moved to
 * round 2" from "moved to round 5". The geometry is therefore tested directly,
 * against measurements a test writes down, and the DOM test covers the wiring
 * — that a pointer gesture commits once, on release, and not at all when it is
 * cancelled. Anything else would be a test that passes without the feature.
 *
 * Pointer events rather than HTML5 drag-and-drop, because this screen is built
 * for a phone and `dragstart` does not fire for touch. Window listeners rather
 * than `setPointerCapture`, because capture is the part jsdom has not
 * implemented and the listeners are what make a drag survive the pointer
 * leaving the row anyway.
 *
 * No keyboard path here on purpose. The up and down buttons beside each row are
 * the keyboard path, they are labelled, and they were here first — a drag
 * handle that also had to be operable by keyboard would be a second, worse
 * implementation of them.
 */

import { useCallback, useEffect, useRef, useState } from "react"

/**
 * `items` with the row at `from` moved to `to`.
 *
 * A copy either way, and unchanged when either index is outside the list, so a
 * caller can pass a computed target without checking it first.
 */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items]
  if (from < 0 || from >= next.length) return next
  if (to < 0 || to >= next.length || to === from) return next
  const [row] = next.splice(from, 1)
  if (row !== undefined) next.splice(to, 0, row)
  return next
}

/**
 * Where a row dragged `dy` pixels from `from` would land.
 *
 * `centres` are the rows' vertical centres as they were when the drag started,
 * which is what makes this stable: the rows on screen are sliding out of the
 * way as the pointer moves, and measuring them again mid-gesture would feed
 * the preview back into its own input and oscillate.
 *
 * The held row has to pass the whole of its neighbour's centre to displace it,
 * rather than merely overlap it, so a small tremor never reorders anything.
 */
export function dropTarget(centres: readonly number[], from: number, dy: number): number {
  const n = centres.length
  if (n === 0 || from < 0 || from >= n) return from
  const held = (centres[from] ?? 0) + dy
  let to = from
  while (to > 0 && held < (centres[to - 1] ?? 0)) to--
  while (to < n - 1 && held > (centres[to + 1] ?? 0)) to++
  return to
}

/**
 * How far row `index` slides while the row at `from` is held over `to`.
 *
 * The distance between two adjacent centres rather than a row height, because
 * that figure already includes the gap between rows and stays right when the
 * rows are not all the same height — a round whose name has wrapped onto a
 * second line is taller than the ones around it.
 */
export function slideBy(
  centres: readonly number[],
  from: number,
  to: number,
  index: number,
): number {
  if (to === from) return 0
  if (to < from) {
    // Held row moving up: everything from `to` up to the row above it shifts
    // down one slot.
    if (index < to || index >= from) return 0
    return (centres[index + 1] ?? 0) - (centres[index] ?? 0)
  }
  // Held row moving down: everything below it, as far as `to`, shifts up one.
  if (index <= from || index > to) return 0
  return (centres[index - 1] ?? 0) - (centres[index] ?? 0)
}

/** What the hook hands back to a list that wants to be draggable. */
export interface Reorder {
  /** True while a row is held, for the class that suppresses text selection. */
  dragging: boolean
  /** The row being dragged, or null. */
  from: number | null
  /** Where it would land if released now, or null when nothing is held. */
  to: number | null
  /** Ref callback for row `index`, so the hook can measure it. */
  rowRef: (index: number) => (el: HTMLElement | null) => void
  /** Props for row `index`'s drag handle. */
  handleProps: (index: number) => { onPointerDown: (e: React.PointerEvent) => void }
  /** The transform row `index` is currently displaced by, or undefined. */
  styleFor: (index: number) => React.CSSProperties | undefined
}

/** Everything a drag in flight needs, none of which should re-render on change. */
interface Held {
  from: number
  to: number
  dy: number
  startY: number
  pointerId: number
  centres: number[]
}

/**
 * Drag-to-reorder for a list of `count` rows.
 *
 * `onMove` fires once, on release, and only when the row actually changed
 * position. Nothing is committed while the pointer is down: the sliding rows
 * are a preview, so a drag abandoned with Escape or interrupted by the browser
 * leaves the list exactly as it was.
 */
export function useReorder(count: number, onMove: (from: number, to: number) => void): Reorder {
  const held = useRef<Held | null>(null)
  const rows = useRef<(HTMLElement | null)[]>([])
  /** Only what the rows are drawn from. The rest lives in `held`. */
  const [view, setView] = useState<Omit<Held, "startY" | "pointerId"> | null>(null)

  // A row removed while the list is on screen leaves its element behind in
  // here otherwise, and a detached node measures as zero — which reads as a
  // row sitting at the very top of the page.
  rows.current.length = count

  // Read through a ref rather than closed over, because the listeners below are
  // attached once per drag and `onMove` is a fresh closure on every render of
  // the list that owns the rows.
  const latest = useRef(onMove)
  useEffect(() => {
    latest.current = onMove
  })

  const dragging = view !== null
  useEffect(() => {
    if (!dragging) return

    const move = (e: PointerEvent): void => {
      const h = held.current
      if (!h || e.pointerId !== h.pointerId) return
      h.dy = e.clientY - h.startY
      h.to = dropTarget(h.centres, h.from, h.dy)
      setView({ from: h.from, to: h.to, dy: h.dy, centres: h.centres })
    }

    const drop = (e: PointerEvent): void => {
      const h = held.current
      if (!h || e.pointerId !== h.pointerId) return
      held.current = null
      setView(null)
      if (h.to !== h.from) latest.current(h.from, h.to)
    }

    const abandon = (): void => {
      held.current = null
      setView(null)
    }

    /**
     * Only the pointer doing the dragging, same as `move` and `drop`.
     *
     * A second finger landing on the screen and lifting again fires
     * `pointercancel` with its own id, and without this that cancels a drag it
     * has nothing to do with — the row snaps back mid-gesture while the finger
     * holding it is still down. The guard belongs on all three or none.
     */
    const cancel = (e: PointerEvent): void => {
      if (e.pointerId !== held.current?.pointerId) return
      abandon()
    }

    // No pointer to check against: Escape abandons whatever is held, which is
    // the whole point of it.
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") abandon()
    }

    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", drop)
    window.addEventListener("pointercancel", cancel)
    window.addEventListener("keydown", key)
    return () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", drop)
      window.removeEventListener("pointercancel", cancel)
      window.removeEventListener("keydown", key)
    }
  }, [dragging])

  const handleProps = useCallback(
    (index: number) => ({
      onPointerDown: (e: React.PointerEvent): void => {
        // Primary button only. A right-click drag is a context menu on its way.
        if (e.button !== 0) return
        const centres = rows.current.map((el) => {
          const r = el?.getBoundingClientRect()
          return r ? r.top + r.height / 2 : 0
        })
        held.current = {
          from: index,
          to: index,
          dy: 0,
          startY: e.clientY,
          pointerId: e.pointerId,
          centres,
        }
        setView({ from: index, to: index, dy: 0, centres })
        // Otherwise the browser starts selecting the text of the rows the
        // pointer travels over, and the selection is what the drag looks like.
        e.preventDefault()
      },
    }),
    [],
  )

  const rowRef = useCallback(
    (index: number) =>
      (el: HTMLElement | null): void => {
        rows.current[index] = el
      },
    [],
  )

  const styleFor = useCallback(
    (index: number): React.CSSProperties | undefined => {
      if (!view) return undefined
      if (index === view.from) {
        // Above the rows it is passing over, or it slides underneath them.
        return { transform: `translateY(${view.dy}px)`, zIndex: 2 }
      }
      const slide = slideBy(view.centres, view.from, view.to, index)
      return slide === 0 ? undefined : { transform: `translateY(${slide}px)` }
    },
    [view],
  )

  return {
    dragging,
    from: view?.from ?? null,
    to: view?.to ?? null,
    rowRef,
    handleProps,
    styleFor,
  }
}
