import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { ChampionshipListResponse } from "../api"

const { championshipsMock } = vi.hoisted(() => ({
  championshipsMock: vi.fn<() => Promise<ChampionshipListResponse>>(),
}))

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>()
  return { ...actual, api: { ...actual.api, championships: championshipsMock } }
})

const { ChampionshipList } = await import("./ChampionshipList")

afterEach(cleanup)

describe("finding a championship", () => {
  it("keeps the ones whose name has every word typed, in any order", async () => {
    championshipsMock.mockResolvedValue({
      championships: [
        { id: "nov", name: "BATL November 2026: Honda Civic SiR-II" },
        { id: "oct", name: "BATL October 2026: Ghosts and Giants" },
        { id: "civic", name: "BATL Civic Showdown : VTEC Kicked in Yo!" },
      ],
    })
    render(<ChampionshipList onOpen={() => {}} onAuthLost={() => {}} />)
    await screen.findByText(/Ghosts and Giants/)
    fireEvent.change(screen.getByLabelText("Find a championship"), {
      target: { value: "civic 2026" },
    })
    expect(screen.getByText(/Honda Civic/)).toBeTruthy()
    expect(screen.queryByText(/Ghosts and Giants/)).toBeNull()
    expect(screen.queryByText(/VTEC/)).toBeNull()
  })
})
