import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const { refreshMock } = vi.hoisted(() => ({
  refreshMock: vi.fn<() => Promise<{ said: string }>>(),
}))

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>()
  return { ...actual, api: { ...actual.api, refreshContent: refreshMock } }
})

const { RefreshContent } = await import("./RefreshContent")

afterEach(cleanup)

describe("reading what's installed again", () => {
  it("says what changed, and can't be pressed twice while it reads", async () => {
    let answer: ((v: { said: string }) => void) | undefined
    refreshMock.mockReturnValue(new Promise((r) => (answer = r)))
    render(<RefreshContent onAuthLost={() => {}} />)
    const button = screen.getByRole("button", { name: "Re-read installed cars and tracks" })
    fireEvent.click(button)
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true)
    answer?.({ said: "Server Manager's cars changed: added C8.R." })
    expect(await screen.findByText("Server Manager's cars changed: added C8.R.")).toBeTruthy()
    expect(refreshMock).toHaveBeenCalledTimes(1)
  })

  it("says why when it couldn't", async () => {
    refreshMock.mockRejectedValue(new Error("I couldn't read Server Manager (fetch failed)."))
    render(<RefreshContent onAuthLost={() => {}} />)
    fireEvent.click(screen.getByRole("button"))
    expect(await screen.findByText(/couldn't read Server Manager/)).toBeTruthy()
  })
})
