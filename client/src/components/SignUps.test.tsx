import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ApiFailure, type SignUpsResponse, type SignUpView } from "../api"

const { signUpsMock, actionMock } = vi.hoisted(() => ({
  signUpsMock: vi.fn<(id: string) => Promise<SignUpsResponse>>(),
  actionMock:
    vi.fn<
      (
        id: string,
        guid: string,
        body: { action: string; confirm?: boolean },
      ) => Promise<SignUpsResponse>
    >(),
}))

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>()
  return { ...actual, api: { ...actual.api, signUps: signUpsMock, signUpAction: actionMock } }
})

const { SignUps } = await import("./SignUps")

function signUp(guid: string, over: Partial<SignUpView> = {}): SignUpView {
  return {
    guid,
    name: guid.toUpperCase(),
    team: "",
    car: "civic",
    skin: "red",
    created: "2026-10-28T00:00:00Z",
    status: "Pending Approval",
    questions: [],
    seated: false,
    ...over,
  }
}

const queue = (signUps: SignUpView[]): SignUpsResponse => ({
  championship: { id: "nov", name: "November 2026" },
  open: true,
  signUps,
})

const confirm = vi.fn<(message?: string) => boolean>()

beforeEach(() => {
  signUpsMock.mockReset()
  actionMock.mockReset()
  confirm.mockReset()
  vi.stubGlobal("confirm", confirm)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const renderScreen = () =>
  render(<SignUps championshipId="nov" onBack={() => {}} onAuthLost={() => {}} />)

describe("the sign-ups screen", () => {
  it("won't offer to accept one with no seat, and says why", async () => {
    signUpsMock.mockResolvedValue(
      queue([signUp("a", { cantAccept: "There's no free seat for civic." })]),
    )
    renderScreen()
    expect(await screen.findByText("There's no free seat for civic.")).toBeTruthy()
    expect((screen.getByRole("button", { name: "Accept" }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it("accepts all one at a time, and stops at the first that fails", async () => {
    signUpsMock.mockResolvedValue(queue([signUp("a"), signUp("b"), signUp("c")]))
    actionMock
      .mockResolvedValueOnce(queue([signUp("b"), signUp("c"), signUp("a", { status: "Accepted" })]))
      .mockRejectedValueOnce(
        new ApiFailure(422, "no-seat", "Can't accept B. There's no free seat."),
      )
    renderScreen()
    fireEvent.click(await screen.findByRole("button", { name: "Accept all 3" }))
    expect(await screen.findByText(/Can't accept B/)).toBeTruthy()
    expect(actionMock.mock.calls.map((c) => c[1])).toEqual(["a", "b"])
  })

  it("rejects a seated driver only once the admin says so", async () => {
    signUpsMock.mockResolvedValue(queue([signUp("s", { seated: true })]))
    actionMock
      .mockRejectedValueOnce(
        new ApiFailure(
          409,
          "would-unseat",
          "S has a seat on the grid, and rejecting takes it away.",
        ),
      )
      .mockResolvedValueOnce(queue([signUp("s", { status: "Rejected" })]))
    confirm.mockReturnValue(true)
    renderScreen()
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }))
    await waitFor(() => expect(actionMock).toHaveBeenCalledTimes(2))
    expect(confirm.mock.calls[0]?.[0]).toMatch(/rejecting takes it away\. Reject anyway\?/)
    expect(actionMock.mock.calls[1]?.[2]).toEqual({ action: "reject", confirm: true })
  })
})
