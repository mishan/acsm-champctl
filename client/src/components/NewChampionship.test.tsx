/**
 * The new-championship screen, in a DOM.
 *
 * The same three promises as the finalize screen, and they fail the same
 * silent way: a button that offers to create a championship the fields no longer
 * describe, a preview that quietly stops updating, an acknowledgement carried
 * over from a championship that has changed underneath it. Each renders correctly and
 * is wrong.
 *
 * One promise is sharper here. Finalize applying twice re-applies a format
 * that is already applied; creating one twice leaves someone two
 * championships to tell apart and delete by hand.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ApiFailure } from "../api"
import type {
  ChampionshipListResponse,
  CheckReport,
  Finding,
  NewChampionshipResponse,
  NewChampionshipPlanResponse,
  NewChampionshipPlan,
} from "../api"

const { championshipsMock, planMock, createMock } = vi.hoisted(() => ({
  championshipsMock: vi.fn<(...a: unknown[]) => Promise<ChampionshipListResponse>>(),
  planMock: vi.fn<(...a: unknown[]) => Promise<NewChampionshipPlanResponse>>(),
  createMock: vi.fn<(...a: unknown[]) => Promise<NewChampionshipResponse>>(),
}))

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>()
  return {
    ...actual,
    api: {
      ...actual.api,
      championships: championshipsMock,
      planNewChampionship: planMock,
      createChampionship: createMock,
    },
  }
})

const { NewChampionship } = await import("./NewChampionship")

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

function planView(over: Partial<NewChampionshipPlan> = {}): NewChampionshipPlan {
  return {
    planId: "plan-1",
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
  return render(<NewChampionship onCreated={() => {}} onAuthLost={() => {}} />)
}

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400)
  })
}

/** Pick a source, name it and add one track — the smallest previewable championship. */
async function filled(track = "spa") {
  const r = renderScreen()
  await screen.findByLabelText(/Clone from/)
  fireEvent.change(screen.getByLabelText(/Clone from/), { target: { value: SOURCE } })
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
  planMock.mockReset()
  createMock.mockReset()
  championshipsMock.mockResolvedValue({
    championships: [{ id: SOURCE, name: "August 2026" }],
  })
  planMock.mockResolvedValue({ plan: planView() })
  createMock.mockResolvedValue({
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
    await screen.findByLabelText(/Clone from/)
    fireEvent.change(screen.getByLabelText(/Clone from/), { target: { value: SOURCE } })
    await settle()
    // Not because the server would refuse: `cloneChampionship` inherits the
    // source's name when none is given, so a blank name would quietly create a
    // second championship with the first one's name. The screen requires one
    // rather than relying on a refusal that never comes.
    expect(planMock).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText(/^Name$/), { target: { value: "September 2026" } })
    await settle()
    expect(planMock).not.toHaveBeenCalled()
  })

  it("hides the fields again when the selection is cleared", async () => {
    // "Pick a championship…" is a real option someone can go back to, and
    // leaving the fields on screen with nothing selected reads as though a
    // championship can be built from nothing.
    await filled()
    expect(screen.queryByLabelText(/^Name$/)).toBeTruthy()

    fireEvent.change(screen.getByLabelText(/Clone from/), { target: { value: "" } })
    expect(screen.queryByLabelText(/^Name$/)).toBeNull()
    expect(screen.queryByRole("button", { name: /Add a round/ })).toBeNull()
    expect(screen.getByText(/Pick a championship to clone/)).toBeTruthy()
  })

  it("previews once there is a name and a track", async () => {
    await filled()
    expect(planMock).toHaveBeenCalledTimes(1)
    expect(planMock.mock.calls[0]?.[0]).toMatchObject({
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
    expect(planMock).toHaveBeenCalledTimes(1)
  })
})

describe("the track list", () => {
  it("sends the tracks in the order shown", async () => {
    await filled("spa")
    fireEvent.click(screen.getByRole("button", { name: /Add a round/ }))
    fireEvent.change(screen.getByLabelText(/Round 2 track/), { target: { value: "monza" } })
    await settle()
    expect(planMock.mock.lastCall?.[0]).toMatchObject({
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
    expect(planMock.mock.lastCall?.[0]).toMatchObject({
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
    expect(planMock.mock.lastCall?.[0]).toMatchObject({
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
    expect(planMock.mock.lastCall?.[0]).toMatchObject({ tracks: [{ track: "monza" }] })
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
    planMock.mockResolvedValue({
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
    await waitFor(() => expect(createMock).toHaveBeenCalled())
    expect(createMock).toHaveBeenCalledWith("plan-1", false)
  })

  it("goes dead the moment the form changes", async () => {
    await filled()
    expect(createButton().disabled).toBe(false)
    fireEvent.change(screen.getByLabelText(/^Name$/), { target: { value: "October 2026" } })
    expect(createButton().disabled).toBe(true)
  })

  it("refuses to create at all when gridmom found an error", async () => {
    planMock.mockResolvedValue({
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
    planMock.mockResolvedValue({
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
    await waitFor(() => expect(createMock).toHaveBeenCalledWith("plan-1", true))
  })

  it("drops the acknowledgement when the championship it was about changes", async () => {
    planMock.mockResolvedValue({
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
    expect(await screen.findByText(/Championship created/)).toBeTruthy()
    expect(screen.getByRole("button", { name: /Open it/ })).toBeTruthy()
  })

  it("cannot be pressed twice into two championships", async () => {
    // The button is gone once the championship exists — there is no plan left to
    // send, and the screen has moved on to reporting what was made.
    await filled()
    fireEvent.click(createButton())
    await screen.findByText(/Championship created/)
    expect(screen.queryByRole("button", { name: /Create in ACSM/ })).toBeNull()
    expect(createMock).toHaveBeenCalledTimes(1)
  })
})

describe("when the server refuses", () => {
  it("shows what champctl said", async () => {
    planMock.mockReset()
    planMock.mockRejectedValue(
      new ApiFailure(422, "emit", "A championship needs at least one car model."),
    )
    await filled()
    expect(await screen.findByText(/at least one car model/)).toBeTruthy()
    expect(createButton().disabled).toBe(true)
  })

  it("previews again after a failed preview, without needing an edit first", async () => {
    // A transient failure is the case where someone retries the same thing.
    // Leaving `lastSent` set makes the identical draft look like a duplicate,
    // so the screen sits on the error until an unrelated field is touched.
    planMock.mockRejectedValueOnce(new ApiFailure(502, "acsm", "Server Manager answered 503."))
    await filled()
    expect(await screen.findByText(/Server Manager answered 503/)).toBeTruthy()
    expect(planMock).toHaveBeenCalledTimes(1)

    // The same draft, re-sent by the reload the screen is about to do — here,
    // by touching the field and putting it straight back.
    fireEvent.change(screen.getByLabelText(/Round 1 track/), { target: { value: "spa " } })
    fireEvent.change(screen.getByLabelText(/Round 1 track/), { target: { value: "spa" } })
    await settle()

    expect(planMock).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(createButton().disabled).toBe(false))
  })

  it("keeps the form when the create is refused, so it can be retried", async () => {
    await filled()
    createMock.mockRejectedValueOnce(
      new ApiFailure(
        422,
        "unacknowledged-warnings",
        "gridmom has warnings about this championship.",
      ),
    )
    fireEvent.click(createButton())
    expect(await screen.findByText(/gridmom has warnings/)).toBeTruthy()
    expect(screen.queryByText(/Championship created/)).toBeNull()
  })
})
