import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { SpectatorPlanResponse } from "../api"

const { planMock, addMock, clearMock } = vi.hoisted(() => ({
  planMock: vi.fn<(id: string) => Promise<SpectatorPlanResponse>>(),
  addMock: vi.fn<(planId: string) => Promise<{ added: string[] }>>(),
  clearMock: vi.fn<(id: string, haltedAt: string) => Promise<{ cleared: boolean }>>(),
}))

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>()
  return {
    ...actual,
    api: {
      ...actual.api,
      planSpectators: planMock,
      addSpectators: addMock,
      clearLiveriesHalt: clearMock,
    },
  }
})

const { SpectatorCars } = await import("./SpectatorCars")

const HALT = {
  reason: "A save moved a driver.",
  backup: "/backups/x.json",
  haltedAt: "2026-11-05T20:00:00.000Z",
}

function show(props: { halt?: typeof HALT | null; missing?: boolean; unknown?: string } = {}) {
  const onChanged = vi.fn()
  const view = render(
    <SpectatorCars
      championshipId="champ-1"
      halt={props.halt ?? null}
      missing={props.missing ?? false}
      haltUnknown={props.unknown}
      onChanged={onChanged}
      describe={(e) => String(e)}
    />,
  )
  return { onChanged, view }
}

beforeEach(() => {
  planMock.mockReset()
  addMock.mockReset()
  clearMock.mockReset()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("the league's spectator cars", () => {
  it("previews the missing cars, and adds exactly that preview", async () => {
    planMock.mockResolvedValue({
      planId: "p1",
      cars: [{ name: "Recorder", model: "ford_transit", guid: "90000000000000002" }],
      effects: [
        "Stream: its race number 420 will be cleared, as any save of the championship form does.",
      ],
    })
    addMock.mockResolvedValue({ added: ["Recorder"] })
    const { onChanged } = show({ missing: true })

    fireEvent.click(screen.getByText("Add the missing spectator cars"))
    expect(await screen.findByText(/Recorder, in ford_transit/)).toBeTruthy()
    expect(screen.getByText(/race number 420 will be cleared/)).toBeTruthy()
    expect(addMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText("Add"))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(addMock).toHaveBeenCalledWith("p1")
  })

  it("drops a spent preview after a refusal, keeps the reason, and reads the championship again", async () => {
    // The server uses a preview once, whatever happens; a refusal may also
    // have halted the championship, which only a fresh read shows.
    planMock.mockResolvedValue({
      planId: "p1",
      cars: [{ name: "Recorder", model: "ford_transit", guid: "90000000000000002" }],
      effects: [],
    })
    addMock.mockRejectedValue(new Error("The save came back wrong."))
    const { onChanged } = show({ missing: true })
    fireEvent.click(screen.getByText("Add the missing spectator cars"))
    fireEvent.click(await screen.findByText("Add"))
    expect(await screen.findByText(/The save came back wrong/)).toBeTruthy()
    expect(screen.queryByText(/Recorder, in ford_transit/)).toBeNull()
    expect(onChanged).toHaveBeenCalled()
  })

  it.each([true, false])(
    "says it can't tell whether the championship is halted, whether or not a car is missing (%s)",
    (missing) => {
      show({ missing, unknown: "" })
      expect(screen.getByText(/couldn't tell whether it has stopped writing/)).toBeTruthy()
      expect(screen.queryByText("Add the missing spectator cars")).toBeNull()
    },
  )

  it("takes Add away from an open preview once the halt is unknown", async () => {
    planMock.mockResolvedValue({
      planId: "p1",
      cars: [{ name: "Recorder", model: "ford_transit", guid: "90000000000000002" }],
      effects: [],
    })
    const { view } = show({ missing: true })
    fireEvent.click(screen.getByText("Add the missing spectator cars"))
    expect(await screen.findByText(/Recorder, in ford_transit/)).toBeTruthy()
    view.rerender(
      <SpectatorCars
        championshipId="champ-1"
        halt={null}
        missing
        haltUnknown="The queue's database is locked."
        onChanged={() => {}}
        describe={(e) => String(e)}
      />,
    )
    expect(screen.queryByText("Add")).toBeNull()
  })

  it("offers nothing when every car is there", () => {
    const { view } = show()
    expect(view.container.innerHTML).toBe("")
  })

  it("shows a halt instead of the add, and resumes only once someone says it's checked", async () => {
    clearMock.mockResolvedValue({ cleared: true })
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true)
    const { onChanged } = show({ halt: HALT, missing: true })
    expect(screen.getByText(/A save moved a driver/)).toBeTruthy()
    expect(screen.queryByText("Add the missing spectator cars")).toBeNull()

    fireEvent.click(screen.getByText("Resume"))
    expect(clearMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText("Resume"))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(clearMock).toHaveBeenCalledWith("champ-1", HALT.haltedAt)
    expect(confirm).toHaveBeenCalledTimes(2)
  })
})
