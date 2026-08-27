/**
 * Reordering a championship's rounds.
 *
 * The thing under test is a rearrangement expressed as several event-form
 * writes, so most of what matters here is what it *refuses* — a permutation
 * that isn't one, a round that has already been raced, a partial write it must
 * describe rather than swallow. The happy path is one assertion; the refusals
 * are the feature.
 */

import { describe, expect, it } from "vitest"

import { AcsmSession } from "../src/acsm/session.js"
import type { Championship, ChampionshipEvent } from "../src/acsm/types.js"
import { EntryListChangedError } from "../src/finalize/apply.js"
import { readFormat } from "../src/finalize/format.js"
import { applyReorder, PartialReorderError } from "../src/reorder/apply.js"
import {
  assertPermutation,
  movedSlots,
  planReorder,
  reordered,
  ReorderError,
  venueOf,
} from "../src/reorder/plan.js"
import { eventFormHtml, type FormEntrant } from "./support/acsm-html.js"
import {
  championship,
  driver,
  entryList,
  NOW,
  pitTable,
  raceEvent,
  suzukaPits,
  testProfile,
} from "./support/build.js"

const CHAMP_ID = "champ-1"
const GO_ZERO = "0001-01-01T00:00:00Z"

const TWO: FormEntrant[] = [
  { name: "Ada", guid: "76561198000000001", pit: 0 },
  { name: "Grace", guid: "76561198000000002", pit: 1 },
]

/**
 * Three rounds: suzuka, spa, ks_brands_hatch/indy — in that order.
 *
 * **Every field a test distinguishes on has to differ per round.** The dates
 * were `raceEvent`'s single default when this was written, which made "the
 * dates stay with the slot" compare three identical strings against three
 * identical strings — it passed against an implementation that moved the dates
 * too. A week apart, as a league actually runs them.
 */
function threeRounds(over: Partial<ChampionshipEvent>[] = []): Championship {
  const at = (
    id: string,
    track: string,
    layout: string,
    laps: number,
    scheduled: string,
    extra: Partial<ChampionshipEvent> = {},
  ): ChampionshipEvent =>
    raceEvent({
      ID: id,
      Scheduled: scheduled,
      EntryList: entryList([driver("Ada"), driver("Grace")]),
      RaceSetup: {
        Track: track,
        TrackLayout: layout,
        Sessions: { RACE: { Name: "Race", Time: 0, Laps: laps, IsOpen: 1 } },
      },
      ...extra,
    })

  return championship({
    ID: CHAMP_ID,
    Events: [
      at("event-1", "suzuka", "", 20, "2026-09-02T19:00:00-07:00", over[0] ?? {}),
      at("event-2", "spa", "", 30, "2026-09-09T19:00:00-07:00", over[1] ?? {}),
      at("event-3", "ks_brands_hatch", "indy", 40, "2026-09-16T19:00:00-07:00", over[2] ?? {}),
    ],
  })
}

interface HarnessOptions {
  /** Fail the POST for these event ids, so a partial write can be produced. */
  failFor?: string[]
  /** Serve a different entry list for these event ids, to trip the guard. */
  movedListFor?: string[]
}

async function harness(options: HarnessOptions = {}) {
  const posts: { url: string; body: URLSearchParams }[] = []
  /** GETs per event id, so a list can change between the plan and the write. */
  const gets = new Map<string, number>()

  const fetchImpl: typeof globalThis.fetch = async (input, init = {}) => {
    const url = String(input)
    if (url.endsWith("/login")) {
      return new Response("", {
        status: 302,
        headers: { "set-cookie": "_acsm_data=x; Path=/", location: "/" },
      })
    }
    if (init.method === "POST") {
      posts.push({ url, body: init.body as URLSearchParams })
      if ((options.failFor ?? []).some((id) => posts.at(-1)?.body.get("Editing") === id)) {
        return new Response("nope", { status: 500, statusText: "Internal Server Error" })
      }
      return new Response("", { status: 302, headers: { location: "/" } })
    }

    // Which round's form is being asked for, so each answers with its own
    // track — a fixture that served one page for every event would let a
    // reorder that read the wrong round's venue pass.
    const id = /\/event\/([^/]+)\/edit/.exec(url)?.[1] ?? ""
    const track = id === "event-1" ? "suzuka" : id === "event-2" ? "spa" : "ks_brands_hatch"
    const layout = id === "event-3" ? "indy" : ""
    const laps = id === "event-1" ? "20" : id === "event-2" ? "30" : "40"

    // The second GET of a round is the apply-time re-read. Growing the list
    // there is exactly the sign-up-approved-mid-preview case the guard is for.
    const seen = (gets.get(id) ?? 0) + 1
    gets.set(id, seen)
    const entrants: FormEntrant[] =
      seen > 1 && (options.movedListFor ?? []).includes(id)
        ? [...TWO, { name: "Katherine", guid: "76561198000000003", pit: 2 }]
        : TWO

    return new Response(
      eventFormHtml(CHAMP_ID, entrants, {
        Track: track,
        TrackLayout: layout,
        "Race.Laps": laps,
      }),
      { status: 200 },
    )
  }

  const session = new AcsmSession({
    baseUrl: "https://acsm.example",
    fetch: fetchImpl,
    rateLimit: false,
  })
  await session.login({ username: "admin", password: "x" })
  return { session, posts }
}

const planOptions = (c: Championship, order: number[]) => ({
  championship: c,
  championshipId: CHAMP_ID,
  order,
  profile: testProfile(),
  pits: pitTable([suzukaPits]),
  now: NOW,
})

// ---------------------------------------------------------------------------
// The permutation itself
// ---------------------------------------------------------------------------

describe("validating an order", () => {
  it("accepts a rearrangement of every round", () => {
    expect(() => assertPermutation([3, 1, 2], 3)).not.toThrow()
    expect(() => assertPermutation([1, 2, 3], 3)).not.toThrow()
  })

  it("refuses an order that drops a round", () => {
    // Not pedantry: [2, 1] against three rounds would write rounds 1 and 2 and
    // leave round 3 holding what it held, so the season would quietly end up
    // with two rounds at the same track and one missing.
    expect(() => assertPermutation([2, 1], 3)).toThrow(/lists 2/)
  })

  it("refuses an order that runs a round twice", () => {
    expect(() => assertPermutation([2, 2, 3], 3)).toThrow(/appears twice/)
  })

  it("refuses a round number that doesn't exist", () => {
    expect(() => assertPermutation([1, 2, 9], 3)).toThrow(/isn't one of/)
    expect(() => assertPermutation([0, 1, 2], 3)).toThrow(/isn't one of/)
    expect(() => assertPermutation([1, 2, 2.5], 3)).toThrow(/isn't one of/)
  })
})

describe("working out what moves", () => {
  it("names only the slots whose contents change", () => {
    expect(movedSlots([1, 2, 3])).toEqual([])
    expect(movedSlots([2, 1, 3])).toEqual([0, 1])
    expect(movedSlots([3, 1, 2])).toEqual([0, 1, 2])
  })
})

describe("the championship as it would be", () => {
  it("moves the track and the format, and leaves the slot alone", () => {
    const before = threeRounds()
    const after = reordered(before, [3, 1, 2])
    const evs = after.Events ?? []

    // Round 1 is still event-1, on its own date, with its own entry list. What
    // changed is where it races and for how long.
    expect(evs[0]?.ID).toBe("event-1")
    expect(evs[0]?.Scheduled).toBe(before.Events?.[0]?.Scheduled)
    expect(evs[0]?.EntryList).toEqual(before.Events?.[0]?.EntryList)
    expect(venueOf(evs[0] as ChampionshipEvent)).toEqual({
      track: "ks_brands_hatch",
      layout: "indy",
    })
    expect(readFormat(evs[0] as ChampionshipEvent).length).toEqual({ kind: "laps", laps: 40 })
  })

  it("keeps the dates in calendar order", () => {
    // The whole point of the slot/contents split: reordering the calendar must
    // not leave round 2 dated before round 1.
    const after = reordered(threeRounds(), [3, 2, 1])
    expect((after.Events ?? []).map((e) => e.Scheduled)).toEqual([
      "2026-09-02T19:00:00-07:00",
      "2026-09-09T19:00:00-07:00",
      "2026-09-16T19:00:00-07:00",
    ])
  })

  it("moves the format with the round", () => {
    // The lap count voted for Monza is about Monza, not about the third
    // Wednesday in September.
    const after = reordered(threeRounds(), [3, 1, 2])
    expect((after.Events ?? []).map((e) => readFormat(e).length)).toEqual([
      { kind: "laps", laps: 40 },
      { kind: "laps", laps: 20 },
      { kind: "laps", laps: 30 },
    ])
  })

  it("moves the layout with the track", () => {
    // A layout belongs to one track — `indy` means nothing at Spa — so a
    // rearrangement that left it behind would put a round on a circuit ACSM
    // cannot render.
    const after = reordered(threeRounds(), [3, 1, 2])
    expect((after.Events ?? []).map((e) => venueOf(e))).toEqual([
      { track: "ks_brands_hatch", layout: "indy" },
      { track: "suzuka", layout: "" },
      { track: "spa", layout: "" },
    ])
  })

  it("does not mutate what it was given", () => {
    const before = threeRounds()
    reordered(before, [3, 1, 2])
    expect(venueOf(before.Events?.[0] as ChampionshipEvent).track).toBe("suzuka")
  })
})

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

describe("planning a reorder", () => {
  it("plans one write per round that moves, and none for the rest", async () => {
    const { session } = await harness()
    const plan = await planReorder(session, planOptions(threeRounds(), [2, 1, 3]))

    expect(plan.moves.map((m) => m.round)).toEqual([1, 2])
    expect(plan.moves[0]?.eventId).toBe("event-1")
    expect(plan.moves[0]?.cameFrom).toBe(2)
    expect(plan.moves[0]?.venue.to).toEqual({ track: "spa", layout: "" })
    expect(plan.noop).toBe(false)
  })

  it("says there is nothing to do when the order is the order it is in", async () => {
    const { session } = await harness()
    const plan = await planReorder(session, planOptions(threeRounds(), [1, 2, 3]))
    expect(plan.noop).toBe(true)
    expect(plan.moves).toEqual([])
  })

  it("posts nothing while planning", async () => {
    const { session, posts } = await harness()
    await planReorder(session, planOptions(threeRounds(), [3, 2, 1]))
    expect(posts).toEqual([])
  })

  it("carries the layout with the round", async () => {
    // A layout belongs to a track, so moving Brands Hatch without `indy` puts
    // the round on a circuit ACSM cannot render.
    const { session } = await harness()
    const plan = await planReorder(session, planOptions(threeRounds(), [3, 1, 2]))
    const first = plan.moves.find((m) => m.round === 1)
    expect(first?.venue.to).toEqual({ track: "ks_brands_hatch", layout: "indy" })
    const sent = Object.fromEntries(first?.formChanges.map((c) => [c.name, c.after]) ?? [])
    expect(sent.Track).toBe("ks_brands_hatch")
    expect(sent.TrackLayout).toBe("indy")
  })

  it("moves the race length with the track", async () => {
    const { session } = await harness()
    const plan = await planReorder(session, planOptions(threeRounds(), [2, 1, 3]))
    const first = plan.moves.find((m) => m.round === 1)
    expect(first?.format.to.length).toEqual({ kind: "laps", laps: 30 })
    expect(first?.changes).toContainEqual({
      label: "Race length",
      before: "20 laps",
      after: "30 laps",
    })
  })

  it("refuses to move a round that has already been raced", async () => {
    // Results belong to the track they were set at. There is no undo for a set
    // of lap times attached to a circuit nobody drove.
    const { session } = await harness()
    const raced = threeRounds([{ StartedTime: "2026-09-02T20:00:00-07:00" }])
    await expect(planReorder(session, planOptions(raced, [2, 1, 3]))).rejects.toThrow(
      /Round 1 has already been raced/,
    )
  })

  it("lets the rounds still to come be reordered around a raced one", async () => {
    const { session } = await harness()
    const raced = threeRounds([{ StartedTime: "2026-09-02T20:00:00-07:00" }])
    const plan = await planReorder(session, planOptions(raced, [1, 3, 2]))
    expect(plan.moves.map((m) => m.round)).toEqual([2, 3])
  })

  it("refuses before it fetches anything", async () => {
    // A refusal that costs a round trip per round is a refusal someone waits
    // for, and the reads are what make this slow.
    const { session, posts } = await harness()
    const raced = threeRounds([{ StartedTime: "2026-09-02T20:00:00-07:00" }])
    await expect(planReorder(session, planOptions(raced, [2, 1, 3]))).rejects.toThrow(ReorderError)
    expect(posts).toEqual([])
  })

  it("runs gridmom against the finished rearrangement, not a half-done one", async () => {
    // Mid-permutation there really are two rounds at the same circuit, and a
    // per-round check would report that as a warning about a state that never
    // exists. Swapping two rounds leaves the set of tracks identical, so the
    // repeated-track check must stay quiet.
    const { session } = await harness()
    const plan = await planReorder(session, planOptions(threeRounds(), [2, 1, 3]))
    expect(plan.gridmom.findings.map((f) => f.code)).not.toContain("champ.repeated-track")
  })
})

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

describe("applying a reorder", () => {
  it("posts each moved round's own form, in slot order", async () => {
    const { session, posts } = await harness()
    const plan = await planReorder(session, planOptions(threeRounds(), [3, 1, 2]))
    const result = await applyReorder(session, plan, { acknowledgeWarnings: true })

    expect(result.rounds).toEqual([1, 2, 3])
    expect(posts.map((p) => p.body.get("Editing"))).toEqual(["event-1", "event-2", "event-3"])
    // Round 1 takes round 3's track and lap count.
    expect(posts[0]?.body.get("Track")).toBe("ks_brands_hatch")
    expect(posts[0]?.body.get("TrackLayout")).toBe("indy")
    expect(posts[0]?.body.get("Race.Laps")).toBe("40")
  })

  it("keeps every entrant on the round it posts", async () => {
    // The event form is a full-list replace. A reorder that dropped the entry
    // list would delete the grid of every round it touched.
    const { session, posts } = await harness()
    const plan = await planReorder(session, planOptions(threeRounds(), [2, 1, 3]))
    await applyReorder(session, plan, { acknowledgeWarnings: true })
    expect(posts[0]?.body.getAll("EntryList.Name")).toEqual(["Ada", "Grace"])
  })

  it("writes nothing at all for a no-op", async () => {
    const { session, posts } = await harness()
    const plan = await planReorder(session, planOptions(threeRounds(), [1, 2, 3]))
    await applyReorder(session, plan)
    expect(posts).toEqual([])
  })

  it("refuses when the entry list moved under the first round", async () => {
    // Every round in a reorder gets the guard, not just the one the person was
    // looking at. Nothing has been written yet here, so the refusal arrives as
    // itself.
    const { session, posts } = await harness({ movedListFor: ["event-1"] })
    const plan = await planReorder(session, planOptions(threeRounds(), [2, 1, 3]))
    await expect(applyReorder(session, plan, { acknowledgeWarnings: true })).rejects.toThrow(
      EntryListChangedError,
    )
    expect(posts).toEqual([])
  })

  it("reports a later round's changed entry list as a partial reorder", async () => {
    // Round 1 is already at its new track by the time round 2 refuses, so the
    // person needs both facts: a sign-up was nearly deleted, and the calendar
    // is half moved.
    const { session } = await harness({ movedListFor: ["event-2"] })
    const plan = await planReorder(session, planOptions(threeRounds(), [2, 1, 3]))
    const err = await applyReorder(session, plan, { acknowledgeWarnings: true }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(PartialReorderError)
    expect((err as PartialReorderError).cause).toBeInstanceOf(EntryListChangedError)
    expect((err as PartialReorderError).written).toEqual([1])
  })

  it("names what landed and what didn't when a write fails part way", async () => {
    // The failure this whole module is shaped around: ACSM has no transaction,
    // so "the reorder failed" would send someone to look at the wrong end of a
    // season.
    const { session } = await harness({ failFor: ["event-3"] })
    const plan = await planReorder(session, planOptions(threeRounds(), [3, 1, 2]))

    const err = await applyReorder(session, plan, { acknowledgeWarnings: true }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(PartialReorderError)
    const partial = err as PartialReorderError
    expect(partial.written).toEqual([1, 2])
    expect(partial.pending).toEqual([3])
    expect(partial.message).toMatch(/Do not re-run/)
  })

  it("lets the first round's failure through as itself", async () => {
    // Nothing landed, so the underlying reason is the whole story. Wrapping it
    // would bury "the entry list changed" under a paragraph about damage that
    // did not happen.
    const { session } = await harness({ failFor: ["event-1"] })
    const plan = await planReorder(session, planOptions(threeRounds(), [3, 1, 2]))
    const err = await applyReorder(session, plan, { acknowledgeWarnings: true }).catch(
      (e: unknown) => e,
    )
    expect(err).not.toBeInstanceOf(PartialReorderError)
  })

  it("will not reorder past a gridmom error", async () => {
    const { session, posts } = await harness()
    const plan = await planReorder(session, planOptions(threeRounds(), [2, 1, 3]))
    const blocked = { ...plan, blocked: true }
    await expect(applyReorder(session, blocked, { acknowledgeWarnings: true })).rejects.toThrow(
      /Refusing to reorder/,
    )
    expect(posts).toEqual([])
  })

  it("wants warnings acknowledged", async () => {
    const { session, posts } = await harness()
    const plan = await planReorder(session, planOptions(threeRounds(), [2, 1, 3]))
    if (plan.gridmom.counts.WARN === 0) {
      // The fixture has to produce one for this to be testing anything.
      throw new Error("fixture produced no warnings, so this test proves nothing")
    }
    await expect(applyReorder(session, plan)).rejects.toThrow(/without an acknowledgement/)
    expect(posts).toEqual([])
  })
})

describe("a championship whose rounds have not been raced", () => {
  it("treats Go's zero time as not raced", async () => {
    // Every unstarted event carries `0001-01-01T00:00:00Z`, so reading that as
    // "has a start time" would refuse every reorder there is.
    const { session } = await harness()
    const plan = await planReorder(
      session,
      planOptions(threeRounds([{ StartedTime: GO_ZERO }]), [2, 1, 3]),
    )
    expect(plan.moves.length).toBe(2)
  })
})
