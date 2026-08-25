/**
 * The new-month screen, in a DOM.
 *
 * The same three promises as the finalize screen, and they fail the same
 * silent way: a button that offers to create a month the fields no longer
 * describe, a preview that quietly stops updating, an acknowledgement carried
 * over from a month that has changed underneath it. Each renders correctly and
 * is wrong.
 *
 * One promise is sharper here. Finalize applying twice re-applies a format
 * that is already applied; this creating twice leaves someone two Septembers
 * to tell apart and delete by hand.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ApiFailure } from "../api"
import type {
  ChampionshipListResponse,
  CheckReport,
  Finding,
  MonthImportResponse,
  MonthPlanResponse,
  MonthPlanView,
} from "../api"

const { championshipsMock, monthPlanMock, createMonthMock } = vi.hoisted(() => ({
  championshipsMock: vi.fn<(...a: unknown[]) => Promise<ChampionshipListResponse>>(),
  monthPlanMock: vi.fn<(...a: unknown[]) => Promise<MonthPlanResponse>>(),
  createMonthMock: vi.fn<(...a: unknown[]) => Promise<MonthImportResponse>>(),
}))

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>()
  return {
    ...actual,
    api: {
      ...actual.api,
      championships: championshipsMock,
      monthPlan: monthPlanMock,
      createMonth: createMonthMock,
    },
  }
})

const { NewMonth } = await import("./NewMonth")

const SOURCE = "champ-august"

function report(findings: Finding[] = []): CheckReport {
  return {
    findings,
    counts: {
      ERROR: findings.filter((f) => f.severity === "ERROR").length,
      WARN: findings.filter((f) => f.severity === "WARN").length,
      INFO: findings.filter((f) => f.severity === "INFO").length,
    },
    ok: !findings.some((f) => f.severity === "ERROR"),
  }
}

function planView(over: Partial<MonthPlanView> = {}): MonthPlanView {
  return {
    planId: "month-1",
    sourceId: SOURCE,
    name: "September 2026",
    rounds: [
      {
        round: 1,
        track: "spa",
        label: "spa",
        quali: { date: "2026-09-02", time: "20:00", display: "2026-09-02 20:00 PDT" },
        moved: false,
      },
    ],
    grid: {
      maxClients: 24,
      bindingTrack: "brands_hatch/indy",
      unknownTracks: [],
      summary: "Capped at 24 by brands_hatch/indy.",
    },
    derived: ["Created and Updated stamped from now, not inherited"],
    gridmom: report(),
    blocked: false,
    needsAcknowledgement: false,
    ...over,
  }
}

function renderScreen() {
  return render(<NewMonth onCreated={() => {}} onAuthLost={() => {}} />)
}

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400)
  })
}

/** Pick a source, name it and add one track — the smallest previewable month. */
async function filled(track = "spa") {
  const r = renderScreen()
  await screen.findByLabelText(/Last month/)
  fireEvent.change(screen.getByLabelText(/Last month/), { target: { value: SOURCE } })
  fireEvent.change(screen.getByLabelText(/^Name$/), { target: { value: "September 2026" } })
  fireEvent.click(screen.getByRole("button", { name: /Add a round/ }))
  fireEvent.change(screen.getByLabelText(/Round 1 track/), { target: { value: track } })
  await settle()
  return r
}

function createButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /Create in ACSM|Blocked|Creating/ })
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  championshipsMock.mockReset()
  monthPlanMock.mockReset()
  createMonthMock.mockReset()
  championshipsMock.mockResolvedValue({
    championships: [{ id: SOURCE, name: "August 2026" }],
  })
  monthPlanMock.mockResolvedValue({ plan: planView() })
  createMonthMock.mockResolvedValue({
    championshipId: "champ-september",
    name: "September 2026",
    rounds: 1,
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("choosing what to clone", () => {
  it("offers the manager's championships", async () => {
    renderScreen()
    expect(await screen.findByRole("option", { name: "August 2026" })).toBeTruthy()
  })

  it("previews nothing until there is a name and a track", async () => {
    renderScreen()
    await screen.findByLabelText(/Last month/)
    fireEvent.change(screen.getByLabelText(/Last month/), { target: { value: SOURCE } })
    await settle()
    // A month with no name cannot be cloned — the server has nothing to fall
    // back on — and a preview request that is going to 422 is worse than none.
    expect(monthPlanMock).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText(/^Name$/), { target: { value: "September 2026" } })
    await settle()
    expect(monthPlanMock).not.toHaveBeenCalled()
  })

  it("previews once there is a name and a track", async () => {
    await filled()
    expect(monthPlanMock).toHaveBeenCalledTimes(1)
    expect(monthPlanMock.mock.calls[0]?.[0]).toMatchObject({
      sourceId: SOURCE,
      name: "September 2026",
      tracks: [{ track: "spa" }],
    })
  })

  it("does not send a half-typed track row", async () => {
    // A blank row is someone mid-type, not a request for a round at a track
    // called "".
    await filled()
    fireEvent.click(screen.getByRole("button", { name: /Add a round/ }))
    await settle()
    expect(monthPlanMock).toHaveBeenCalledTimes(1)
  })
})

describe("the track list", () => {
  it("sends the tracks in the order shown", async () => {
    await filled("spa")
    fireEvent.click(screen.getByRole("button", { name: /Add a round/ }))
    fireEvent.change(screen.getByLabelText(/Round 2 track/), { target: { value: "monza" } })
    await settle()
    expect(monthPlanMock.mock.lastCall?.[0]).toMatchObject({
      tracks: [{ track: "spa" }, { track: "monza" }],
    })
  })

  it("reorders a round and re-previews", async () => {
    await filled("spa")
    fireEvent.click(screen.getByRole("button", { name: /Add a round/ }))
    fireEvent.change(screen.getByLabelText(/Round 2 track/), { target: { value: "monza" } })
    await settle()

    fireEvent.click(screen.getByRole("button", { name: /Move round 2 up/ }))
    await settle()
    expect(monthPlanMock.mock.lastCall?.[0]).toMatchObject({
      tracks: [{ track: "monza" }, { track: "spa" }],
    })
  })

  it("will not move the first round up or the last one down", async () => {
    await filled("spa")
    expect(
      (screen.getByRole("button", { name: /Move round 1 up/ }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(
      (screen.getByRole("button", { name: /Move round 1 down/ }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it("carries the layout when there is one", async () => {
    await filled("brands_hatch")
    fireEvent.change(screen.getByLabelText(/Round 1 layout/), { target: { value: "indy" } })
    await settle()
    expect(monthPlanMock.mock.lastCall?.[0]).toMatchObject({
      tracks: [{ track: "brands_hatch", layout: "indy" }],
    })
  })

  it("removes a round", async () => {
    await filled("spa")
    fireEvent.click(screen.getByRole("button", { name: /Add a round/ }))
    fireEvent.change(screen.getByLabelText(/Round 2 track/), { target: { value: "monza" } })
    await settle()

    fireEvent.click(screen.getByRole("button", { name: /Remove round 1/ }))
    await settle()
    expect(monthPlanMock.mock.lastCall?.[0]).toMatchObject({ tracks: [{ track: "monza" }] })
  })
})

describe("the review", () => {
  it("names the track that bound the grid", async () => {
    // "Capped at 24" without saying by what leaves someone guessing which
    // track to go and change.
    await filled()
    expect(await screen.findByText(/Capped at 24 by brands_hatch\/indy/)).toBeTruthy()
  })

  it("says which tracks have no pit count on file", async () => {
    monthPlanMock.mockResolvedValue({
      plan: planView({
        grid: {
          maxClients: 30,
          unknownTracks: ["fictional_track"],
          summary: "Capped at 30.",
        },
      }),
    })
    await filled()
    expect(await screen.findByText(/fictional_track/)).toBeTruthy()
  })

  it("shows what the emitter set rather than inherited", async () => {
    await filled()
    expect(await screen.findByText(/set rather than inherited/)).toBeTruthy()
  })
})

describe("the create button", () => {
  it("sends the plan id it was shown, and nothing else", async () => {
    await filled()
    fireEvent.click(createButton())
    await waitFor(() => expect(createMonthMock).toHaveBeenCalled())
    expect(createMonthMock).toHaveBeenCalledWith("month-1", false)
  })

  it("goes dead the moment the form changes", async () => {
    await filled()
    expect(createButton().disabled).toBe(false)
    fireEvent.change(screen.getByLabelText(/^Name$/), { target: { value: "October 2026" } })
    expect(createButton().disabled).toBe(true)
  })

  it("refuses to create at all when gridmom found an error", async () => {
    monthPlanMock.mockResolvedValue({
      plan: planView({
        blocked: true,
        gridmom: report([
          {
            code: "entry.duplicate-pit-box",
            severity: "ERROR",
            message: "Two entrants share pit box 3.",
          },
        ]),
      }),
    })
    await filled()
    expect(createButton().disabled).toBe(true)
    expect(createButton().textContent).toMatch(/Blocked by an error/)
  })

  it("wants the warnings acknowledged, and says so in what it sends", async () => {
    monthPlanMock.mockResolvedValue({
      plan: planView({
        needsAcknowledgement: true,
        gridmom: report([
          {
            code: "entry.grid-larger-than-pits",
            severity: "WARN",
            message: "Grid is larger than the pit count.",
          },
        ]),
      }),
    })
    await filled()
    expect(createButton().disabled).toBe(true)

    fireEvent.click(screen.getByLabelText(/read the warnings/i))
    expect(createButton().disabled).toBe(false)
    fireEvent.click(createButton())
    await waitFor(() => expect(createMonthMock).toHaveBeenCalledWith("month-1", true))
  })

  it("drops the acknowledgement when the month it was about changes", async () => {
    monthPlanMock.mockResolvedValue({
      plan: planView({
        needsAcknowledgement: true,
        gridmom: report([
          {
            code: "entry.grid-larger-than-pits",
            severity: "WARN",
            message: "Grid is larger than the pit count.",
          },
        ]),
      }),
    })
    await filled()
    fireEvent.click(screen.getByLabelText(/read the warnings/i))
    expect(createButton().disabled).toBe(false)

    fireEvent.click(screen.getByRole("button", { name: /Add a round/ }))
    fireEvent.change(screen.getByLabelText(/Round 2 track/), { target: { value: "monza" } })
    await settle()

    expect((screen.getByLabelText(/read the warnings/i) as HTMLInputElement).checked).toBe(false)
  })

  it("reports what ACSM made, and offers to open it", async () => {
    await filled()
    fireEvent.click(createButton())
    expect(await screen.findByText(/Month created/)).toBeTruthy()
    expect(screen.getByRole("button", { name: /Open it/ })).toBeTruthy()
  })

  it("cannot be pressed twice into two months", async () => {
    // The button is gone once the month exists — there is no plan left to
    // send, and the screen has moved on to reporting what was made.
    await filled()
    fireEvent.click(createButton())
    await screen.findByText(/Month created/)
    expect(screen.queryByRole("button", { name: /Create in ACSM/ })).toBeNull()
    expect(createMonthMock).toHaveBeenCalledTimes(1)
  })
})

describe("when the server refuses", () => {
  it("shows what champctl said", async () => {
    monthPlanMock.mockReset()
    monthPlanMock.mockRejectedValue(
      new ApiFailure(422, "emit", "A month needs at least one car model."),
    )
    await filled()
    expect(await screen.findByText(/at least one car model/)).toBeTruthy()
    expect(createButton().disabled).toBe(true)
  })

  it("keeps the form when the create is refused, so it can be retried", async () => {
    await filled()
    createMonthMock.mockRejectedValueOnce(
      new ApiFailure(422, "unacknowledged-warnings", "gridmom has warnings about this month."),
    )
    fireEvent.click(createButton())
    expect(await screen.findByText(/gridmom has warnings/)).toBeTruthy()
    expect(screen.queryByText(/Month created/)).toBeNull()
  })
})
