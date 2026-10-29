/**
 * Four screens and the back button.
 *
 * Not a router library, because there is nothing here a router would earn its
 * bundle on: four shapes, no nested layouts, no loaders. What it does buy is
 * the phone's back gesture working the way the person expects — the event
 * screen is meant to be opened from a Discord link and left again, and a back
 * swipe that exits the app instead of returning to the round list is the kind
 * of thing that makes someone stop using it.
 *
 * Deep links work because the server falls through to `index.html` for
 * anything that isn't an API path.
 */

import { useEffect, useRef, useState } from "react"

export type Route =
  | { name: "home" }
  | { name: "new-championship" }
  | { name: "championship"; id: string }
  | { name: "signups"; id: string }
  | { name: "round"; id: string; round: number }

export function parseRoute(pathname: string): Route {
  const parts = pathname.split("/").filter(Boolean)
  if (parts[0] === "new-championship") return { name: "new-championship" }
  if (parts[0] !== "c" || !parts[1]) return { name: "home" }

  // A malformed percent escape — `/c/%` — makes decodeURIComponent throw, and
  // this runs during the first render, so the whole app came up blank rather
  // than falling back. A link that cannot be decoded is a mistyped link, which
  // is a case this function already knows how to handle.
  let id: string
  try {
    id = decodeURIComponent(parts[1])
  } catch {
    return { name: "home" }
  }
  if (parts[2] === "signups") return { name: "signups", id }
  if (parts[2] === "round" && parts[3]) {
    const round = Number(parts[3])
    // A path with a nonsense round number is a mistyped link, and the
    // championship it names is still a useful place to land.
    if (Number.isInteger(round) && round >= 1) return { name: "round", id, round }
    return { name: "championship", id }
  }
  return { name: "championship", id }
}

export function routePath(route: Route): string {
  switch (route.name) {
    case "home":
      return "/"
    case "new-championship":
      return "/new-championship"
    case "championship":
      return `/c/${encodeURIComponent(route.id)}`
    case "signups":
      return `/c/${encodeURIComponent(route.id)}/signups`
    case "round":
      return `/c/${encodeURIComponent(route.id)}/round/${route.round}`
  }
}

/** Asks whether to leave a screen holding work that leaving would lose. */
let mayLeave: (() => boolean) | undefined

/**
 * Whether to go ahead with leaving the screen: asks when it holds unsaved
 * work. For anything that takes the screen away other than `navigate`, which
 * asks already — signing out, say, which drops the screen with the session.
 * A yes stands until the screen goes, so the navigation that follows doesn't
 * ask again.
 */
export function confirmLeave(): boolean {
  if (!mayLeave) return true
  if (!mayLeave()) return false
  mayLeave = undefined
  return true
}

/**
 * While `unsaved`, every way off the screen asks first: a link, the title, the
 * back gesture, and closing or reloading the tab. Typed changes to a round
 * went nowhere on a stray tap of "‹ Rounds", with nothing said.
 */
export function useLeaveGuard(unsaved: boolean, question: string): void {
  useEffect(() => {
    if (!unsaved) return
    const ask = (): boolean => window.confirm(question)
    mayLeave = ask
    const onUnload = (e: BeforeUnloadEvent): void => {
      e.preventDefault()
      // Older Safari and WebViews prompt only when this is set.
      e.returnValue = ""
    }
    window.addEventListener("beforeunload", onUnload)
    return () => {
      if (mayLeave === ask) mayLeave = undefined
      window.removeEventListener("beforeunload", onUnload)
    }
  }, [unsaved, question])
}

export function useRoute(): [Route, (next: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname))
  // Where in the history the screen on show is. Each entry carries its index,
  // so refusing a back or forward jump of any size can go back to it exactly,
  // rather than pushing a copy that would throw away the forward entries.
  const shownAt = useRef(0)

  useEffect(() => {
    const at = (window.history.state as { index?: number } | null)?.index
    if (typeof at === "number") shownAt.current = at
    else window.history.replaceState({ index: 0 }, "")

    const onPop = (e: PopStateEvent): void => {
      const to = (e.state as { index?: number } | null)?.index ?? 0
      // The return trip from a refused jump, landing where it started.
      if (to === shownAt.current) return
      // The address has already changed by now, so staying means going back to it.
      if (mayLeave && !mayLeave()) {
        window.history.go(shownAt.current - to)
        return
      }
      shownAt.current = to
      setRoute(parseRoute(window.location.pathname))
    }
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])

  const navigate = (next: Route): void => {
    if (mayLeave && !mayLeave()) return
    const path = routePath(next)
    // Guard the push rather than the state update: re-navigating to where you
    // already are would otherwise stack history entries that all look the same,
    // and back would appear to do nothing several times running.
    if (path !== window.location.pathname) {
      shownAt.current += 1
      window.history.pushState({ index: shownAt.current }, "", path)
    }
    setRoute(next)
  }

  return [route, navigate]
}
