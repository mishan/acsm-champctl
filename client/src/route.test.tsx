/**
 * Leaving a screen with work on it: every way off asks first, and staying
 * keeps both the screen and the address.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useLeaveGuard, useRoute } from "./route"

function Screen({ unsaved }: { unsaved: boolean }): React.JSX.Element {
  const [route, navigate] = useRoute()
  useLeaveGuard(unsaved, "Leave?")
  return (
    <>
      <p>on {route.name}</p>
      <button type="button" onClick={() => navigate({ name: "new-championship" })}>
        go
      </button>
    </>
  )
}

const confirm = vi.fn<(message?: string) => boolean>()

beforeEach(() => {
  window.history.replaceState(null, "", "/")
  confirm.mockReset()
  vi.stubGlobal("confirm", confirm)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("leaving with unsaved work", () => {
  it.each([
    ["leaves when told to", true, "on new-championship", "/new-championship"],
    ["stays when told not to", false, "on home", "/"],
  ])("%s", (_, leave, shown, path) => {
    confirm.mockReturnValue(leave)
    render(<Screen unsaved />)
    fireEvent.click(screen.getByText("go"))
    expect(confirm).toHaveBeenCalledWith("Leave?")
    expect(screen.getByText(shown)).toBeTruthy()
    expect(window.location.pathname).toBe(path)
  })

  it("puts the address back when the back gesture is refused", () => {
    confirm.mockReturnValue(false)
    render(<Screen unsaved />)
    window.history.pushState(null, "", "/new-championship")
    fireEvent(window, new PopStateEvent("popstate"))
    expect(screen.getByText("on home")).toBeTruthy()
    expect(window.location.pathname).toBe("/")
  })

  it("doesn't ask when there is nothing to lose", () => {
    render(<Screen unsaved={false} />)
    fireEvent.click(screen.getByText("go"))
    expect(confirm).not.toHaveBeenCalled()
    expect(screen.getByText("on new-championship")).toBeTruthy()
  })
})
