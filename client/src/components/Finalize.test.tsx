/**
 * The finalize screen, in a DOM.
 *
 * These exist because the three things this screen promises are all about
 * *not lying*, and none of them is checkable from the outside. A push button
 * that offers to apply a plan the fields no longer describe, a preview that
 * silently stops updating, an acknowledgement that carries over from the
 * previous change — each renders perfectly, typechecks, and is wrong.
 *
 * The API is stubbed rather than served: what is under test is the screen's
 * own rules, and `test/web.test.ts` already drives the real endpoints. Timers
 * are faked because the preview debounce is 350ms and a test that waits it out
 * for real is a test nobody runs.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ApiFailure } from "../api"
import type {
  ApplyResponse,
  CheckReport,
  Config,
  Finding,
  PlanResponse,
  PlanView,
  RoundView,
} from "../api"

// `vi.hoisted` because `vi.mock` is hoisted above every declaration in this
// file, and the factory now runs at import time — this module imports a *value*
// from "../api" (`ApiFailure`), not only types. Plain consts were initialised
// too late and the factory saw them undefined.
const { planMock, applyMock } = vi.hoisted(() => ({
  planMock: vi.fn<(...args: unknown[]) => Promise<PlanResponse>>(),
  applyMock: vi.fn<(...args: unknown[]) => Promise<ApplyResponse>>(),
}))

vi.mock("../api", async (importOriginal) => {
  // `ApiFailure` is a real class the component narrows on with `instanceof`, so
  // it has to be the real one rather than a stand-in.
  const actual = await importOriginal<typeof import("../api")>()
  return { ...actual, api: { ...actual.api, plan: planMock, apply: applyMock } }
})

const { Finalize } = await import("./Finalize")

const CHAMP = "champ-1"

function round(over: Partial<RoundView> = {}): RoundView {
  return {
    round: 1,
    eventId: "event-1",
    track: "suzuka",
    label: "Round 1 — suzuka",
    started: false,
    format: {
      length: { kind: "minutes", minutes: 40 },
      reversedGridPositions: 0,
      mandatoryPit: true,
      extraLap: false,
    },
    practiceMinutes: 30,
    quali: { date: "2026-09-02", time: "19:00", display: "2026-09-02 19:00 PDT" },
    practiceStart: { date: "2026-09-02", time: "18:30", display: "2026-09-02 18:30 PDT" },
    ...over,
  }
}

/**
 * A gridmom report whose counts match its findings.
 *
 * Built rather than written out because `counts` is derived, and a fixture
 * where the two disagree tests a state the server cannot produce.
 */
function report(findings: Finding[]): CheckReport {
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

function planView(over: Partial<PlanView> = {}): PlanView {
  return {
    planId: "plan-1",
    championshipId: CHAMP,
    eventId: "event-1",
    round: 1,
    current: round().format,
    desired: round().format,
    changes: [{ label: "Race length", before: "40 minutes", after: "18 laps" }],
    formChanges: [{ name: "Sessions.Race.Laps", before: "0", after: "18" }],
    schedule: null,
    gridmom: report([]),
    blocked: false,
    needsAcknowledgement: false,
    noop: false,
    ...over,
  }
}

const config: Config = {
  league: { id: "batl", name: "BATL" },
  baseUrl: "https://acsm.example",
  timezone: "America/Los_Angeles",
  qualiStart: "19:00",
  practiceMinutes: 30,
  formats: [
    {
      name: "1x40",
      length: { kind: "minutes", minutes: 40 },
      reversedGridPositions: 0,
      mandatoryPit: true,
      extraLap: false,
    },
  ],
}

function renderScreen(over: Partial<React.ComponentProps<typeof Finalize>> = {}) {
  return render(
    <Finalize
      championshipId={CHAMP}
      round={1}
      config={config}
      onBack={() => {}}
      onAuthLost={() => {}}
      {...over}
    />,
  )
}

/**
 * The length input, as distinct from the radio that chooses which unit it
 * means. Both are labelled "Minutes", so the label alone finds two elements.
 */
function lengthField(): HTMLInputElement {
  return screen.getByLabelText(/^(Laps|Minutes)$/, { selector: "#length" }) as HTMLInputElement
}

function unitRadio(name: "Laps" | "Minutes"): HTMLInputElement {
  return screen.getByLabelText(name, { selector: 'input[type="radio"]' }) as HTMLInputElement
}

function field(label: RegExp): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement
}

/** The screen opens with a no-change preview; wait for that to land. */
async function opened(over: Partial<React.ComponentProps<typeof Finalize>> = {}) {
  const r = renderScreen(over)
  await screen.findByLabelText(/^(Laps|Minutes)$/, { selector: "#length" })
  return r
}

/** Push past the debounce and let the preview request settle. */
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400)
  })
}

function pushButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /Push to ACSM|Blocked|Nothing to change|Pushing/ })
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  planMock.mockReset()
  applyMock.mockReset()
  planMock.mockResolvedValue({ plan: planView(), round: round() })
  applyMock.mockResolvedValue({ eventSaved: true, scheduleSaved: true, changes: [] })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("opening a round", () => {
  it("asks for a preview of no change, which writes nothing", async () => {
    await opened()
    expect(planMock).toHaveBeenCalledTimes(1)
    expect(planMock.mock.calls[0]?.[2]).toEqual({})
    expect(applyMock).not.toHaveBeenCalled()
  })

  it("seeds the fields from the round as it stands", async () => {
    await opened()
    expect(lengthField().value).toBe("40")
    expect(unitRadio("Minutes").checked).toBe(true)
    expect(field(/Reversed grid positions/).value).toBe("0")
    expect(field(/Date/).value).toBe("2026-09-02")
    expect(field(/Start/).value).toBe("19:00")
  })

  it("does not re-ask for the preview it was just given", async () => {
    // Seeding the form is a state change like any other, and without the
    // guard it looks exactly like an edit — so opening a round would spend two
    // requests to learn the same thing.
    await opened()
    await settle()
    expect(planMock).toHaveBeenCalledTimes(1)
  })

  it("says so when the round has already been run", async () => {
    planMock.mockResolvedValue({ plan: planView(), round: round({ started: true }) })
    await opened()
    expect(screen.getByText(/already been run/i)).toBeTruthy()
  })
})

describe("editing the form", () => {
  it("re-previews once the typing stops", async () => {
    await opened()
    fireEvent.change(lengthField(), { target: { value: "22" } })
    await settle()
    expect(planMock).toHaveBeenCalledTimes(2)
    expect(planMock.mock.calls[1]?.[2]).toMatchObject({ minutes: 22 })
  })

  it("sends one request for a burst of typing, not one per keystroke", async () => {
    await opened()
    const length = lengthField()
    fireEvent.change(length, { target: { value: "1" } })
    fireEvent.change(length, { target: { value: "18" } })
    fireEvent.change(length, { target: { value: "180" } })
    await settle()
    expect(planMock).toHaveBeenCalledTimes(2)
  })

  it("recovers when an edit is undone before the preview went out", async () => {
    // The regression this file was written for, and it needs both edits inside
    // the debounce window. `set` drops the plan on every keystroke, but
    // `lastSent` still holds the seeded body — so when the second edit restores
    // that exact body, the "don't re-ask for what we already asked" guard
    // matches and no request is ever sent. The screen is then left with no
    // preview and a dead push button until something *else* is changed.
    await opened()
    expect(planMock).toHaveBeenCalledTimes(1)

    fireEvent.change(lengthField(), { target: { value: "22" } })
    expect(pushButton().disabled).toBe(true)
    fireEvent.change(lengthField(), { target: { value: "40" } })
    await settle()

    expect(planMock).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(pushButton().disabled).toBe(false))
  })

  it("re-previews after a field is put back across two settled previews", async () => {
    await opened()
    fireEvent.change(lengthField(), { target: { value: "22" } })
    await settle()
    expect(planMock).toHaveBeenCalledTimes(2)

    fireEvent.change(lengthField(), { target: { value: "40" } })
    await settle()
    expect(planMock).toHaveBeenCalledTimes(3)
  })

  it("switches which field the length comes from", async () => {
    await opened()
    fireEvent.click(unitRadio("Laps"))
    fireEvent.change(lengthField(), { target: { value: "18" } })
    await settle()
    expect(planMock.mock.lastCall?.[2]).toMatchObject({ laps: 18 })
  })

  it("applies a preset from the league's profile", async () => {
    await opened()
    fireEvent.click(screen.getByRole("button", { name: /1x40/ }))
    await settle()
    expect(planMock.mock.lastCall?.[2]).toMatchObject({ minutes: 40, mandatoryPit: true })
  })

  it("does not preview a half-filled quali time", async () => {
    // A date with no time is a request to schedule a round at midnight, which
    // nobody means. The draft is incomplete rather than wrong, so the screen
    // waits rather than refusing.
    await opened()
    fireEvent.change(field(/Start/), { target: { value: "" } })
    await settle()
    expect(planMock).toHaveBeenCalledTimes(1)
  })
})

describe("the push button", () => {
  it("pushes the plan id it was shown, and nothing else", async () => {
    await opened()
    fireEvent.change(lengthField(), { target: { value: "22" } })
    await settle()

    fireEvent.click(pushButton())
    await waitFor(() => expect(applyMock).toHaveBeenCalled())
    expect(applyMock).toHaveBeenCalledWith("plan-1", false)
  })

  it("goes dead the moment a field changes, before any new preview arrives", async () => {
    // `previewing` alone did not cover this: it is false during the debounce,
    // false again after a failed preview, and never set at all for a draft the
    // client rejects. In each of those the old plan was still pushable while
    // the fields on screen described something else.
    await opened()
    expect(pushButton().disabled).toBe(false)

    fireEvent.change(lengthField(), { target: { value: "22" } })
    expect(pushButton().disabled).toBe(true)
  })

  it("refuses to push at all when gridmom found an error", async () => {
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
      round: round(),
    })
    await opened()
    expect(pushButton().disabled).toBe(true)
    expect(pushButton().textContent).toMatch(/Blocked by an error/)
  })

  it("wants the warnings acknowledged first, and says so in what it sends", async () => {
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
      round: round(),
    })
    await opened()
    expect(pushButton().disabled).toBe(true)

    fireEvent.click(screen.getByLabelText(/read the warnings/i))
    expect(pushButton().disabled).toBe(false)

    fireEvent.click(pushButton())
    await waitFor(() => expect(applyMock).toHaveBeenCalledWith("plan-1", true))
  })

  it("drops an acknowledgement when the change it was about is edited away", async () => {
    // A box ticked about the previous change's warnings is not agreement to
    // this one.
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
      round: round(),
    })
    await opened()
    fireEvent.click(screen.getByLabelText(/read the warnings/i))
    expect(pushButton().disabled).toBe(false)

    fireEvent.change(lengthField(), { target: { value: "22" } })
    await settle()

    expect(field(/read the warnings/i).checked).toBe(false)
    expect(pushButton().disabled).toBe(true)
  })

  it("has nothing to offer when the round already matches", async () => {
    planMock.mockResolvedValue({ plan: planView({ noop: true }), round: round() })
    await opened()
    expect(pushButton().disabled).toBe(true)
    expect(pushButton().textContent).toMatch(/Nothing to change/)
  })
})

describe("when the server refuses", () => {
  it("shows what champctl said rather than a generic failure", async () => {
    await opened()
    planMock.mockRejectedValueOnce(new Error("That wall clock doesn't exist in that zone."))
    fireEvent.change(lengthField(), { target: { value: "22" } })
    await settle()
    expect(await screen.findByText(/wall clock doesn't exist/)).toBeTruthy()
  })

  it("offers a reload, not a retry, once the plan is gone", async () => {
    // The entry-list refusal: the plan is already destroyed server-side, so
    // pushing again would refuse again. The way forward is a fresh look.
    //
    // Keyed on the code rather than the message, which is why this test has to
    // throw a real ApiFailure — a plain Error with the same words does not and
    // must not trigger it.
    await opened()
    applyMock.mockRejectedValueOnce(
      new ApiFailure(409, "entry-list-changed", "The entry list for this event changed."),
    )
    fireEvent.click(pushButton())

    expect(await screen.findByRole("button", { name: /Reload the round/ })).toBeTruthy()
    expect(pushButton().disabled).toBe(true)
  })

  it("keeps the plan pushable when the failure was not about the plan", async () => {
    // ACSM being briefly unreachable is worth retrying with the same plan.
    // Dropping it here would make every transient failure cost the person
    // their preview.
    await opened()
    applyMock.mockRejectedValueOnce(new ApiFailure(502, "acsm", "ACSM returned 503."))
    fireEvent.click(pushButton())

    expect(await screen.findByText(/ACSM returned 503/)).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Reload the round/ })).toBeNull()
    await waitFor(() => expect(pushButton().disabled).toBe(false))
  })
})
