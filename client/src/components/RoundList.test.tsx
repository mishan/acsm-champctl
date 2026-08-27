/**
 * The round list, in a DOM.
 *
 * One rule, and it is the kind that only shows up in a sequence: a failure
 * belongs to the championship that failed, not to the screen. Every assertion
 * here is about what happens on the *second* load, because the first one
 * always looks right.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ApiFailure } from "../api"
import type { ChampionshipResponse } from "../api"

const { championshipMock } = vi.hoisted(() => ({
  championshipMock: vi.fn<(...args: unknown[]) => Promise<ChampionshipResponse>>(),
}))

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>()
  return { ...actual, api: { ...actual.api, championship: championshipMock } }
})

const { RoundList } = await import("./RoundList")

function response(name: string): ChampionshipResponse {
  return {
    championship: {
      id: "champ-1",
      name,
      timezone: "America/Los_Angeles",
      cars: ["rss_formula_hybrid_2021"],
      description: "",
      rounds: [
        {
          round: 1,
          eventId: "event-1",
          track: "suzuka",
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
        },
      ],
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
