/**
 * The round list, in a DOM.
 *
 * One rule, and it is the kind that only shows up in a sequence: a failure
 * belongs to the championship that failed, not to the screen. Every assertion
 * here is about what happens on the *second* load, because the first one
 * always looks right.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ApiFailure } from "../api"
import type { ChampionshipResponse, ReorderPlanView, RoundView } from "../api"

const { championshipMock, planReorderMock, applyReorderMock } = vi.hoisted(() => ({
  championshipMock: vi.fn<(...args: unknown[]) => Promise<ChampionshipResponse>>(),
  planReorderMock: vi.fn<(...args: unknown[]) => Promise<{ plan: ReorderPlanView }>>(),
  applyReorderMock: vi.fn<(...args: unknown[]) => Promise<{ rounds: number[] }>>(),
}))

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>()
  return {
    ...actual,
    api: {
      ...actual.api,
      championship: championshipMock,
      planReorder: planReorderMock,
      applyReorder: applyReorderMock,
    },
  }
})

const { RoundList } = await import("./RoundList")

function round(over: Partial<RoundView> = {}): RoundView {
  return {
    round: 1,
    eventId: "event-1",
    venue: { track: "suzuka", layout: "" },
    label: "Round 1 — suzuka",
    started: false,
    format: {
      length: { kind: "laps", laps: 18 },
      reversedGridPositions: 0,
      mandatoryPit: true,
      extraLap: false,
    },
    practiceMinutes: 30,
    quali: null,
    practiceStart: null,
    ...over,
  }
}

function response(name: string, rounds: RoundView[] = [round()]): ChampionshipResponse {
  return {
    championship: {
      id: "champ-1",
      name,
      timezone: "America/Los_Angeles",
      cars: ["rss_formula_hybrid_2021"],
      description: "",
      rounds,
    },
    gridmom: { findings: [], counts: { ERROR: 0, WARN: 0, INFO: 0 }, ok: true },
  }
}

function renderList(championshipId: string) {
  return render(
    <RoundList championshipId={championshipId} onOpenRound={() => {}} onAuthLost={() => {}} />,
  )
}

beforeEach(() => {
  championshipMock.mockReset()
  planReorderMock.mockReset()
  applyReorderMock.mockReset()
})

afterEach(cleanup)

describe("opening a championship", () => {
  it("lists its rounds", async () => {
    championshipMock.mockResolvedValue(response("Summer Series"))
    renderList("champ-1")
    expect(await screen.findByText("Summer Series")).toBeTruthy()
    expect(screen.getByText(/suzuka/)).toBeTruthy()
  })

  it("says so when it could not be loaded", async () => {
    championshipMock.mockRejectedValue(new ApiFailure(502, "acsm", "Server Manager answered 503."))
    renderList("champ-1")
    expect(await screen.findByText(/Server Manager answered 503/)).toBeTruthy()
  })
})

describe("moving to another championship", () => {
  it("does not hold the next one responsible for the last one's failure", async () => {
    // The regression. `error` short-circuits the render, so it has to be
    // cleared when the id changes — otherwise the second championship is
    // fetched, arrives, sets `data`, and the screen goes on showing the first
    // one's error forever. Nothing recovers it: there is no retry, and the
    // component only reloads when the id changes again.
    championshipMock.mockRejectedValueOnce(
      new ApiFailure(502, "acsm", "Server Manager answered 503."),
    )
    const { rerender } = renderList("champ-1")
    expect(await screen.findByText(/Server Manager answered 503/)).toBeTruthy()

    championshipMock.mockResolvedValueOnce(response("Winter Series"))
    rerender(<RoundList championshipId="champ-2" onOpenRound={() => {}} onAuthLost={() => {}} />)

    expect(await screen.findByText("Winter Series")).toBeTruthy()
    expect(screen.queryByText(/Server Manager answered 503/)).toBeNull()
  })

  it("ignores an answer to the championship the user has already left", async () => {
    // Two loads in flight, the slow one first. Without a guard the stale
    // response wins simply by arriving last, and the screen shows a
    // championship the user is no longer on.
    let settleFirst: ((r: ChampionshipResponse) => void) | undefined
    championshipMock.mockImplementationOnce(
      () =>
        new Promise<ChampionshipResponse>((resolve) => {
          settleFirst = resolve
        }),
    )

    const { rerender } = renderList("champ-1")

    championshipMock.mockResolvedValueOnce(response("Winter Series"))
    rerender(<RoundList championshipId="champ-2" onOpenRound={() => {}} onAuthLost={() => {}} />)
    expect(await screen.findByText("Winter Series")).toBeTruthy()

    settleFirst?.(response("Summer Series"))
    await waitFor(() => expect(screen.getByText("Winter Series")).toBeTruthy())
    expect(screen.queryByText("Summer Series")).toBeNull()
  })
})

describe("a round that has already been raced", () => {
  it("says raced rather than run", async () => {
    // As a chip beside a race, "run" reads as an instruction to start one.
    const r = response("Summer Series")
    r.championship.rounds[0]!.started = true
    championshipMock.mockResolvedValue(r)
    renderList("champ-1")
    expect(await screen.findByText("raced")).toBeTruthy()
    expect(screen.queryByText("run")).toBeNull()
  })

  it("does not call a finished round unscheduled", async () => {
    // ACSM clears `Scheduled` once an event starts, so every raced round
    // reported itself unscheduled — true, useless, and read as "nobody has set
    // a date for this yet" when the race had already happened.
    const r = response("Summer Series")
    r.championship.rounds[0]!.started = true
    r.championship.rounds[0]!.quali = null
    championshipMock.mockResolvedValue(r)
    renderList("champ-1")
    await screen.findByText("raced")
    expect(screen.queryByText(/unscheduled/)).toBeNull()
  })

  it("still says unscheduled when the round has not run", async () => {
    const r = response("Summer Series")
    r.championship.rounds[0]!.quali = null
    championshipMock.mockResolvedValue(r)
    renderList("champ-1")
    expect(await screen.findByText(/unscheduled/)).toBeTruthy()
  })
})

/**
 * Reordering the calendar.
 *
 * Same limitation as the create screen's drag test, and stated for the same
 * reason: jsdom runs no layout, so a drag here can only say "upwards" or
 * "downwards". The arrows are what these drive, because they express the same
 * move through the same `move()` — where a row lands for a given gesture is
 * `reorder.test.ts`, against measurements a test can state.
 */
describe("reordering the rounds", () => {
  const THREE = [
    round({ round: 1, eventId: "event-1", venue: { track: "suzuka", layout: "" } }),
    round({ round: 2, eventId: "event-2", venue: { track: "spa", layout: "" } }),
    round({ round: 3, eventId: "event-3", venue: { track: "monza", layout: "" } }),
  ]

  function planned(over: Partial<ReorderPlanView> = {}): ReorderPlanView {
    return {
      planId: "reorder-1",
      championshipId: "champ-1",
      rounds: [],
      moves: [
        {
          round: 1,
          cameFrom: 2,
          changes: [{ label: "Track", before: "suzuka", after: "spa" }],
          formChanges: [],
        },
      ],
      gridmom: { findings: [], counts: { ERROR: 0, WARN: 0, INFO: 0 }, ok: true },
      blocked: false,
      needsAcknowledgement: false,
      noop: false,
      ...over,
    }
  }

  async function settle() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
  }

  /**
   * Open the reorder screen. Set `planReorderMock` *before* calling this if
   * the test wants a different plan — this only supplies the championship, so
   * an override made beforehand is not quietly replaced.
   */
  async function reordering(rounds = THREE) {
    championshipMock.mockResolvedValue(response("Summer Series", rounds))
    renderList("champ-1")
    await screen.findByText("Summer Series")
    fireEvent.click(screen.getByRole("button", { name: /Reorder rounds/ }))
    await screen.findByRole("heading", { name: "Reorder rounds" })
  }

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    planReorderMock.mockResolvedValue({ plan: planned() })
    applyReorderMock.mockResolvedValue({ rounds: [1, 2] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("is not offered for a championship with one round", async () => {
    // There is no order to change, and a button that cannot do anything is
    // worse than no button.
    championshipMock.mockResolvedValue(response("Summer Series"))
    renderList("champ-1")
    await screen.findByText("Summer Series")
    expect(screen.queryByRole("button", { name: /Reorder rounds/ })).toBeNull()
  })

  it("previews the order it is asked for, and only when it differs", async () => {
    await reordering()
    // Opening the screen is not a change, so nothing has been asked for yet.
    await settle()
    expect(planReorderMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: /Move round 2 up/ }))
    await settle()
    expect(planReorderMock.mock.lastCall?.[1]).toEqual([2, 1, 3])
  })

  it("shows the night each slot keeps rather than moving it", async () => {
    // The thing people expect to travel with the track and doesn't, so the
    // screen has to show round 1 keeping round 1's night.
    await reordering([
      round({ round: 1, quali: { date: "2026-09-02", time: "20:00", display: "Sep 2, 20:00" } }),
      round({
        round: 2,
        eventId: "event-2",
        venue: { track: "spa", layout: "" },
        quali: { date: "2026-09-09", time: "20:00", display: "Sep 9, 20:00" },
      }),
    ])
    fireEvent.click(screen.getByRole("button", { name: /Move round 2 up/ }))

    const rows = document.querySelectorAll(".tracks.reorder li")
    expect(rows[0]?.textContent).toContain("spa")
    expect(rows[0]?.textContent).toContain("Sep 2, 20:00")
  })

  it("will not offer to move a round that has been raced", async () => {
    // The server refuses this by name; the screen does not offer the gesture
    // that would earn the refusal.
    await reordering([
      round({ round: 1, started: true }),
      round({ round: 2, eventId: "event-2", venue: { track: "spa", layout: "" } }),
      round({ round: 3, eventId: "event-3", venue: { track: "monza", layout: "" } }),
    ])
    expect(
      (screen.getByRole("button", { name: /Move round 1 down/ }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(document.querySelectorAll(".tracks.reorder .round-grip")).toHaveLength(2)
  })

  /**
   * The other half of the same rule, and the half that was only enforced on
   * the server: a raced round cannot move, *and nothing can move into its
   * slot*. Round 2's up arrow points at round 1's night, which has happened.
   */
  it("will not offer to move a round onto a night that has already happened", async () => {
    await reordering([
      round({ round: 1, started: true }),
      round({ round: 2, eventId: "event-2", venue: { track: "spa", layout: "" } }),
      round({ round: 3, eventId: "event-3", venue: { track: "monza", layout: "" } }),
    ])
    expect(
      (screen.getByRole("button", { name: /Move round 2 up/ }) as HTMLButtonElement).disabled,
      "round 1 has raced, so round 2 has nowhere above it",
    ).toBe(true)
    // Down is still fine — round 3 has not run.
    expect(
      (screen.getByRole("button", { name: /Move round 2 down/ }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })

  it("applies with the plan id and nothing else", async () => {
    await reordering()
    fireEvent.click(screen.getByRole("button", { name: /Move round 2 up/ }))
    await settle()

    fireEvent.click(screen.getByRole("button", { name: /Apply the new order/ }))
    await waitFor(() => expect(applyReorderMock).toHaveBeenCalled())
    expect(applyReorderMock.mock.lastCall).toEqual(["reorder-1", false])
  })

  it("goes dead the moment the order changes again", async () => {
    // The same rule as the other two write screens: `previewing` alone is
    // false during the debounce, so the button would offer to apply an order
    // the rows no longer show.
    await reordering()
    fireEvent.click(screen.getByRole("button", { name: /Move round 2 up/ }))
    await settle()
    expect(
      (screen.getByRole("button", { name: /Apply the new order/ }) as HTMLButtonElement).disabled,
    ).toBe(false)

    fireEvent.click(screen.getByRole("button", { name: /Move round 3 up/ }))
    expect(
      (screen.getByRole("button", { name: /Apply the new order/ }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it("refuses to apply when gridmom found an error", async () => {
    planReorderMock.mockResolvedValue({ plan: planned({ blocked: true }) })
    await reordering()
    fireEvent.click(screen.getByRole("button", { name: /Move round 2 up/ }))
    await settle()

    expect(screen.getByRole("button", { name: /Blocked by an error/ })).toBeTruthy()
    expect(
      (screen.getByRole("button", { name: /Blocked by an error/ }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it("wants the warnings acknowledged, and says so in what it sends", async () => {
    planReorderMock.mockResolvedValue({ plan: planned({ needsAcknowledgement: true }) })
    await reordering()
    fireEvent.click(screen.getByRole("button", { name: /Move round 2 up/ }))
    await settle()

    const apply = screen.getByRole("button", { name: /Apply the new order/ }) as HTMLButtonElement
    expect(apply.disabled).toBe(true)

    fireEvent.click(screen.getByLabelText(/I've read the warnings/))
    fireEvent.click(apply)
    await waitFor(() => expect(applyReorderMock).toHaveBeenCalled())
    expect(applyReorderMock.mock.lastCall).toEqual(["reorder-1", true])
  })

  it("re-reads the championship rather than patching what is on screen", async () => {
    // The championship has changed underneath, and the export is the only
    // thing that knows what it now says — gridmom included.
    await reordering()
    fireEvent.click(screen.getByRole("button", { name: /Move round 2 up/ }))
    await settle()
    const before = championshipMock.mock.calls.length

    fireEvent.click(screen.getByRole("button", { name: /Apply the new order/ }))
    await waitFor(() => expect(championshipMock.mock.calls.length).toBe(before + 1))
    expect(await screen.findByText("Summer Series")).toBeTruthy()
  })

  it("shows what champctl said when it refuses", async () => {
    planReorderMock.mockRejectedValue(
      new ApiFailure(422, "reorder", "Round 1 has already been raced."),
    )
    await reordering()
    fireEvent.click(screen.getByRole("button", { name: /Move round 2 up/ }))
    await settle()
    expect(screen.getByText(/already been raced/)).toBeTruthy()
  })

  it("leaves the order alone on cancel", async () => {
    await reordering()
    fireEvent.click(screen.getByRole("button", { name: /Move round 2 up/ }))
    await settle()
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }))

    expect(await screen.findByText("Summer Series")).toBeTruthy()
    expect(applyReorderMock).not.toHaveBeenCalled()
  })
})
