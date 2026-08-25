/**
 * Three screens and the back button.
 *
 * Not a router library, because there is nothing here a router would earn its
 * bundle on: three shapes, no nested layouts, no loaders. What it does buy is
 * the phone's back gesture working the way the person expects — the finalize
 * screen is meant to be opened from a Discord link and left again, and a back
 * swipe that exits the app instead of returning to the round list is the kind
 * of thing that makes someone stop using it.
 *
 * Deep links work because the server falls through to `index.html` for
 * anything that isn't an API path.
 */

import { useEffect, useState } from "react"

export type Route =
  | { name: "home" }
  | { name: "championship"; id: string }
  | { name: "round"; id: string; round: number }

export function parseRoute(pathname: string): Route {
  const parts = pathname.split("/").filter(Boolean)
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
    case "championship":
      return `/c/${encodeURIComponent(route.id)}`
    case "round":
      return `/c/${encodeURIComponent(route.id)}/round/${route.round}`
  }
}

export function useRoute(): [Route, (next: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname))

  useEffect(() => {
    const onPop = (): void => setRoute(parseRoute(window.location.pathname))
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])

  const navigate = (next: Route): void => {
    const path = routePath(next)
    // Guard the push rather than the state update: re-navigating to where you
    // already are would otherwise stack history entries that all look the same,
    // and back would appear to do nothing several times running.
    if (path !== window.location.pathname) window.history.pushState(null, "", path)
    setRoute(next)
  }

  return [route, navigate]
}
