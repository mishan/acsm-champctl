/**
 * The new-championship screen, in a DOM.
 *
 * The same three promises as the event screen, and they fail the same
 * silent way: a button that offers to create a championship the fields no longer
 * describe, a preview that quietly stops updating, an acknowledgement carried
 * over from a championship that has changed underneath it. Each renders correctly and
 * is wrong.
 *
 * One promise is sharper here. EventEditor applying twice re-applies a format
 * that is already applied; creating one twice leaves someone two
 * championships to tell apart and delete by hand.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ApiFailure } from "../api"
import type {
  ChampionshipListResponse,
  ChampionshipResponse,
  CheckReport,
  ContentResponse,
  Finding,
  NewChampionshipResponse,
  NewChampionshipPlanResponse,
  NewChampionshipPlan,
} from "../api"

const { championshipsMock, championshipMock, contentMock, planMock, createMock } = vi.hoisted(
  () => ({
    championshipsMock: vi.fn<(...a: unknown[]) => Promise<ChampionshipListResponse>>(),
    championshipMock: vi.fn<(...a: unknown[]) => Promise<ChampionshipResponse>>(),
    contentMock: vi.fn<(...a: unknown[]) => Promise<ContentResponse>>(),
    planMock: vi.fn<(...a: unknown[]) => Promise<NewChampionshipPlanResponse>>(),
    createMock: vi.fn<(...a: unknown[]) => Promise<NewChampionshipResponse>>(),
  }),
)

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>()
  return {
    ...actual,
    api: {
      ...actual.api,
      championships: championshipsMock,
      championship: championshipMock,
      content: contentMock,
      planNewChampionship: planMock,
      createChampionship: createMock,
    },
  }
})

const { NewChampionship } = await import("./NewChampionship")

const SOURCE = "champ-august"
/** What the manager has installed, which is all either picker will offer. */
const CARS = [
  { id: "rss_formula_hybrid_2021", name: "RSS Formula Hybrid 2021" },
  { id: "ks_porsche_911_gt3_r_2016", name: "Porsche 911 GT3 R" },
]
const TRACKS = [
  { id: "spa", name: "Spa" },
  { id: "ks_brands_hatch", name: "Brands Hatch" },
  { id: "monza", name: "Monza" },
]

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

/**
 * Choose something in a `Picker`, the way a person does: focus it, type part
 * of the name, click the suggestion.
 *
 * Not `fireEvent.change` on the input — that is what these tests did when the
 * field was free text, and it no longer commits anything. The value a picker
 * holds is only ever one of the offered items, which is the point of it.
 */
async function pick(label: RegExp, query: string): Promise<void> {
  const input = screen.getByLabelText(label)
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value: query } })
  const list = await screen.findByRole("listbox", { name: label })
  const options = within(list).getAllByRole("option")
  const first = options[0]
  if (!first) throw new Error(`nothing installed matches ${query}`)
  fireEvent.mouseDown(first)
}

/** Pick a source, name it and add one track — the smallest previewable championship. */
async function filled(track = "Spa") {
  const r = renderScreen()
  await screen.findByLabelText(/Clone from/)
  fireEvent.change(screen.getByLabelText(/Clone from/), { target: { value: SOURCE } })
  // The source's cars arrive on their own; wait for them, since a draft with
  // no cars is not previewable.
  await screen.findByText("RSS Formula Hybrid 2021")
  fireEvent.change(screen.getByLabelText(/^Name$/), { target: { value: "September 2026" } })
  fireEvent.click(screen.getByRole("button", { name: /Add a round/ }))
  await pick(/Round 1 track/, track)
  await settle()
  return r
}

function createButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /Create in ACSM|Blocked|Creating/ })
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  championshipsMock.mockReset()
  championshipMock.mockReset()
  contentMock.mockReset()
  planMock.mockReset()
  createMock.mockReset()
  championshipsMock.mockResolvedValue({
    championships: [{ id: SOURCE, name: "August 2026" }],
  })
  contentMock.mockResolvedValue({ cars: CARS, tracks: TRACKS })
  // The source, read so the Cars field can show what a clone would inherit.
  championshipMock.mockResolvedValue({
    championship: {
      id: SOURCE,
      name: "August 2026",
      timezone: "America/Los_Angeles",
      cars: ["rss_formula_hybrid_2021"],
      description: "August was a good month.",
      rounds: [],
    },
    gridmom: report(),
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

/**
 * The field this screen was missing.
 *
 * A clone inherited the source's cars and never said so, so the form asked
 * which tracks a season runs at and never mentioned what anyone would drive —
 * the one thing about a championship that cannot be worked out from the rest
 * of the form.
 */
describe("the car list", () => {
  it("shows the cars the source runs, without being asked", async () => {
    renderScreen()
    await screen.findByLabelText(/Clone from/)
    fireEvent.change(screen.getByLabelText(/Clone from/), { target: { value: SOURCE } })
    // By the name the manager gives it, with the folder name beside it.
    expect(await screen.findByText("RSS Formula Hybrid 2021")).toBeTruthy()
    expect(screen.getByText("rss_formula_hybrid_2021")).toBeTruthy()
  })

  it("sends the cars, so they are not silently inherited", async () => {
    await filled()
    expect(planMock.mock.lastCall?.[0]).toMatchObject({ cars: ["rss_formula_hybrid_2021"] })
  })

  it("adds a car and re-previews with it", async () => {
    await filled()
    await pick(/Add a car/, "Porsche")
    await settle()
    expect(planMock.mock.lastCall?.[0]).toMatchObject({
      cars: ["rss_formula_hybrid_2021", "ks_porsche_911_gt3_r_2016"],
    })
  })

  it("removes a car", async () => {
    await filled()
    await pick(/Add a car/, "Porsche")
    await settle()
    fireEvent.click(screen.getByRole("button", { name: /Remove RSS Formula Hybrid 2021/ }))
    await settle()
    expect(planMock.mock.lastCall?.[0]).toMatchObject({ cars: ["ks_porsche_911_gt3_r_2016"] })
  })

  it("does not offer a car that is already chosen", async () => {
    await filled()
    fireEvent.focus(screen.getByLabelText(/Add a car/))
    const list = await screen.findByRole("listbox", { name: /Add a car/ })
    expect(within(list).queryByText("RSS Formula Hybrid 2021")).toBeNull()
    expect(within(list).getByText("Porsche 911 GT3 R")).toBeTruthy()
  })

  /**
   * An empty list before anything has arrived is not somebody's mistake.
   *
   * The screen used to say "this championship would have nothing to drive" for
   * the moment between picking a source and its cars landing — a sentence
   * about a problem nobody had, on a form that was working correctly.
   */
  it("says it is still reading rather than that there are no cars", async () => {
    let release: ((r: ChampionshipResponse) => void) | undefined
    championshipMock.mockReturnValue(
      new Promise<ChampionshipResponse>((r) => {
        release = r
      }),
    )

    renderScreen()
    await screen.findByLabelText(/Clone from/)
    fireEvent.change(screen.getByLabelText(/Clone from/), { target: { value: SOURCE } })

    expect(await screen.findByText(/Reading the cars from the championship above/)).toBeTruthy()
    expect(screen.queryByText(/nothing to drive/)).toBeNull()

    release?.({
      championship: {
        id: SOURCE,
        name: "August 2026",
        timezone: "America/Los_Angeles",
        cars: ["rss_formula_hybrid_2021"],
        description: "",
        rounds: [],
      },
      gridmom: report(),
    })
    await waitFor(() => expect(screen.getByText("RSS Formula Hybrid 2021")).toBeTruthy())
  })

  /**
   * An empty list is not "inherit". Sending no `cars` key would fall back to
   * the source's, so the screen would show no cars and create a championship
   * full of them — the invisible inheritance this field exists to end, wearing
   * a disguise.
   */
  it("previews nothing while the car list is empty", async () => {
    await filled()
    planMock.mockClear()
    fireEvent.click(screen.getByRole("button", { name: /Remove RSS Formula Hybrid 2021/ }))
    await settle()
    expect(planMock).not.toHaveBeenCalled()
    expect(screen.getByText(/nothing to drive/i)).toBeTruthy()
  })
})

/**
 * The blurb ACSM shows on the championship page.
 *
 * Same invisible-inheritance problem the cars had: a clone carried the
 * source's description silently, which is how a September championship ends up
 * describing August's tracks.
 */
describe("the description", () => {
  it("shows what the source has, without being asked", async () => {
    renderScreen()
    await screen.findByLabelText(/Clone from/)
    fireEvent.change(screen.getByLabelText(/Clone from/), { target: { value: SOURCE } })
    const box = (await screen.findByLabelText(/Description/)) as HTMLTextAreaElement
    await waitFor(() => expect(box.value).toBe("August was a good month."))
  })

  it("sends what is in the box", async () => {
    await filled()
    fireEvent.change(screen.getByLabelText(/Description/), {
      target: { value: "September, and five new tracks." },
    })
    await settle()
    expect(planMock.mock.lastCall?.[0]).toMatchObject({
      description: "September, and five new tracks.",
    })
  })

  /**
   * Empty is a value, not an omission. The server reads an absent `description`
   * as "inherit the source's", so a cleared box that sent nothing would put
   * last month's blurb on this month's championship — the exact thing this
   * field exists to stop.
   */
  it("sends an empty description rather than omitting it", async () => {
    await filled()
    fireEvent.change(screen.getByLabelText(/Description/), { target: { value: "" } })
    await settle()
    const sent = planMock.mock.lastCall?.[0] as { description?: string }
    expect(sent.description).toBe("")
    expect("description" in sent).toBe(true)
  })
})

describe("when champctl cannot read what is installed", () => {
  /**
   * A strict picker with nothing to pick is a dead end, so it has to say why
   * rather than render an empty list somebody keeps typing into.
   */
  it("says so in the field rather than failing the screen", async () => {
    contentMock.mockRejectedValue(new Error("manager is down"))
    renderScreen()
    await screen.findByLabelText(/Clone from/)
    fireEvent.change(screen.getByLabelText(/Clone from/), { target: { value: SOURCE } })

    expect(await screen.findByText(/couldn't read the cars installed/i)).toBeTruthy()
    // And the rest of the screen is still usable.
    expect(screen.getByLabelText(/^Name$/)).toBeTruthy()
    expect((screen.getByLabelText(/Add a car/) as HTMLInputElement).disabled).toBe(true)
  })
})

describe("the track list", () => {
  it("sends the tracks in the order shown", async () => {
    await filled("Spa")
    fireEvent.click(screen.getByRole("button", { name: /Add a round/ }))
    await pick(/Round 2 track/, "Monza")
    await settle()
    expect(planMock.mock.lastCall?.[0]).toMatchObject({
      tracks: [{ track: "spa" }, { track: "monza" }],
    })
  })

  it("reorders a round and re-previews", async () => {
    await filled("Spa")
    fireEvent.click(screen.getByRole("button", { name: /Add a round/ }))
    await pick(/Round 2 track/, "Monza")
    await settle()

    fireEvent.click(screen.getByRole("button", { name: /Move round 2 up/ }))
    await settle()
    expect(planMock.mock.lastCall?.[0]).toMatchObject({
      tracks: [{ track: "monza" }, { track: "spa" }],
    })
  })

  it("will not move the first round up or the last one down", async () => {
    await filled("Spa")
    expect(
      (screen.getByRole("button", { name: /Move round 1 up/ }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(
      (screen.getByRole("button", { name: /Move round 1 down/ }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  /**
   * Named rounds, because ACSM shows an event's name instead of its track.
   *
   * The default is blank on purpose — that is what ACSM writes and it makes the
   * manager show the track — so this only sends a name when somebody types one.
   */
  it("carries a round name when one is typed", async () => {
    await filled("Spa")
    fireEvent.change(screen.getByLabelText(/Round 1 name/), {
      target: { value: "Season opener" },
    })
    await settle()
    expect(planMock.mock.lastCall?.[0]).toMatchObject({
      tracks: [{ track: "spa", name: "Season opener" }],
    })
  })

  it("sends no name for a round left unnamed", async () => {
    await filled("Spa")
    const sent = planMock.mock.lastCall?.[0] as { tracks: { name?: string }[] }
    expect("name" in (sent.tracks[0] ?? {})).toBe(false)
  })

  it("names rounds one at a time, not all of them", async () => {
    // Every round is built from the same template event server-side, which is
    // how they all ended up called "Donington Park National". The form must
    // not repeat that trick.
    await filled("Spa")
    fireEvent.click(screen.getByRole("button", { name: /Add a round/ }))
    await pick(/Round 2 track/, "Monza")
    fireEvent.change(screen.getByLabelText(/Round 1 name/), { target: { value: "Opener" } })
    await settle()
    expect(planMock.mock.lastCall?.[0]).toMatchObject({
      tracks: [{ track: "spa", name: "Opener" }, { track: "monza" }],
    })
  })

  it("carries the layout when there is one", async () => {
    await filled("Brands Hatch")
    fireEvent.change(screen.getByLabelText(/Round 1 layout/), { target: { value: "indy" } })
    await settle()
    expect(planMock.mock.lastCall?.[0]).toMatchObject({
      // The folder name the picker committed, not the name that was typed.
      tracks: [{ track: "ks_brands_hatch", layout: "indy" }],
    })
  })

  it("removes a round", async () => {
    await filled("Spa")
    fireEvent.click(screen.getByRole("button", { name: /Add a round/ }))
    await pick(/Round 2 track/, "Monza")
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
    await pick(/Round 2 track/, "Monza")
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

  it("previews again after a failure when the effect re-runs on its own", async () => {
    // Every path that edits the draft already clears `lastSent`, so a retry
    // after an edit works either way. This is the path that doesn't: the
    // preview effect re-running for some reason other than an edit — a parent
    // passing a fresh `onAuthLost` on re-render is the ordinary one — with the
    // draft unchanged. Leaving `lastSent` set after a failure makes that look
    // like a duplicate and the screen stays on the error.
    planMock.mockRejectedValueOnce(new ApiFailure(502, "acsm", "Server Manager answered 503."))
    const { rerender } = render(<NewChampionship onCreated={() => {}} onAuthLost={() => {}} />)
    await screen.findByLabelText(/Clone from/)
    fireEvent.change(screen.getByLabelText(/Clone from/), { target: { value: SOURCE } })
    fireEvent.change(screen.getByLabelText(/^Name$/), { target: { value: "September 2026" } })
    fireEvent.click(screen.getByRole("button", { name: /Add a round/ }))
    await pick(/Round 1 track/, "spa")
    await settle()

    expect(await screen.findByText(/Server Manager answered 503/)).toBeTruthy()
    expect(planMock).toHaveBeenCalledTimes(1)

    rerender(<NewChampionship onCreated={() => {}} onAuthLost={() => {}} />)
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
