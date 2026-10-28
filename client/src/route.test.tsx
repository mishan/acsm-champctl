/**
 * Leaving a screen with work on it: every way off asks first, and staying
 * keeps both the screen and the address.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { confirmLeave, useLeaveGuard, useRoute } from "./route"

function Screen({ unsaved }: { unsaved: boolean }): React.JSX.Element {
  const [route, navigate] = useRoute()
  useLeaveGuard(unsaved, "Leave?")
  return (
    <>
      <p>on {route.name}</p>
      <button type="button" onClick={() => navigate({ name: "new-championship" })}>
        go
      </button>
      <button type="button" onClick={() => navigate({ name: "championship", id: "one" })}>
        open one
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

  it("goes back to where it was when a jump through history is refused, keeping the rest", async () => {
    confirm.mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false)
    render(<Screen unsaved />)
    fireEvent.click(screen.getByText("go"))
    fireEvent.click(screen.getByText("open one"))
    const entries = window.history.length
    window.history.go(-2)
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(window.location.pathname).toBe("/c/one"))
    expect(screen.getByText("on championship")).toBeTruthy()
    expect(window.history.length).toBe(entries)
  })

  it("asks before something else takes the screen away, and only once", () => {
    confirm.mockReturnValue(true)
    render(<Screen unsaved />)
    expect(confirmLeave()).toBe(true)
    fireEvent.click(screen.getByText("go"))
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it("doesn't ask when there is nothing to lose", () => {
    render(<Screen unsaved={false} />)
    fireEvent.click(screen.getByText("go"))
    expect(confirm).not.toHaveBeenCalled()
    expect(screen.getByText("on new-championship")).toBeTruthy()
  })
})
