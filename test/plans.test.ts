/**
 * The plan store's lease.
 *
 * A finalize plan is computed from one person's authenticated read and applied
 * by posting a form fetched with their cookies, so who owns a plan is a
 * security question and not bookkeeping. The single-use lease is a correctness
 * question: ACSM's event form replaces the whole entry list, so two applies
 * racing over one plan is two full-form writes over one entry list.
 *
 * Neither property is visible from the outside — a store that had quietly lost
 * both would serve every request in this repo's other tests identically.
 */

import { describe, expect, it } from "vitest"

import type { FinalizePlan } from "../src/finalize/plan.js"
import { PlanStore } from "../src/web/plans.js"

/** Only identity matters here; the plan's contents are never inspected. */
function plan(round = 1): FinalizePlan {
  return { round } as FinalizePlan
}

function store(over: { ttlMs?: number; maxPlans?: number } = {}) {
  let now = 1_000_000
  const s = new PlanStore({
    ttlMs: over.ttlMs ?? 60_000,
    maxPlans: over.maxPlans ?? 2000,
    now: () => now,
  })
  return { s, advance: (ms: number) => (now += ms) }
}

const SESSION = "session-a"
const OTHER = "session-b"

describe("holding a plan", () => {
  it("gives back the plan it stored, to the session that stored it", () => {
    const { s } = store()
    const id = s.create(SESSION, plan(3))
    expect(s.get(id, SESSION)).toEqual(plan(3))
  })

  it("gives every plan its own id", () => {
    const { s } = store()
    expect(s.create(SESSION, plan(1))).not.toBe(s.create(SESSION, plan(2)))
    expect(s.size).toBe(2)
  })

  it("has nothing for an id it never issued", () => {
    const { s } = store()
    expect(s.get("made-up", SESSION)).toBeUndefined()
    expect(s.get(undefined, SESSION)).toBeUndefined()
  })
})

describe("who owns a plan", () => {
  it("does not hand a plan to another session", () => {
    const { s } = store()
    const id = s.create(SESSION, plan())
    expect(s.get(id, OTHER)).toBeUndefined()
    expect(s.acquire(id, OTHER)).toEqual({ kind: "not-found" })
  })

  it("reports a wrong owner as not-found rather than as a refusal", () => {
    // Telling a caller that a plan exists but isn't theirs confirms the id is
    // real, which is the one thing an id they shouldn't have is missing.
    const { s } = store()
    const id = s.create(SESSION, plan())
    expect(s.acquire(id, OTHER)).toEqual({ kind: "not-found" })
  })

  it("will not let another session release an in-flight plan", () => {
    // The lease is what stops two applies writing over one entry list, so
    // clearing someone else's in-flight flag is the way to defeat it.
    const { s } = store()
    const id = s.create(SESSION, plan())
    expect(s.acquire(id, SESSION).kind).toBe("acquired")
    s.release(id, OTHER)
    expect(s.acquire(id, SESSION)).toEqual({ kind: "in-flight" })
  })

  it("will not let another session destroy a plan", () => {
    const { s } = store()
    const id = s.create(SESSION, plan())
    expect(s.destroy(id, OTHER)).toBe(false)
    expect(s.get(id, SESSION)).toBeDefined()
  })

  it("drops every plan a session owns, and only those", () => {
    const { s } = store()
    const mine = s.create(SESSION, plan(1))
    const theirs = s.create(OTHER, plan(2))
    expect(s.dropForSession(SESSION)).toBe(1)
    expect(s.get(mine, SESSION)).toBeUndefined()
    expect(s.get(theirs, OTHER)).toBeDefined()
  })
})

describe("the single-use lease", () => {
  it("refuses a second acquire while the first is in flight", () => {
    const { s } = store()
    const id = s.create(SESSION, plan())
    expect(s.acquire(id, SESSION)).toEqual({ kind: "acquired", plan: plan() })
    expect(s.acquire(id, SESSION)).toEqual({ kind: "in-flight" })
  })

  it("lets the plan be applied again after a release", () => {
    // Release is for refusals the person can act on — an unacknowledged
    // warning. Making them rebuild the preview to tick a box would be a reason
    // to stop reading warnings.
    const { s } = store()
    const id = s.create(SESSION, plan())
    s.acquire(id, SESSION)
    s.release(id, SESSION)
    expect(s.acquire(id, SESSION).kind).toBe("acquired")
  })

  it("is gone for good once destroyed", () => {
    const { s } = store()
    const id = s.create(SESSION, plan())
    s.acquire(id, SESSION)
    expect(s.destroy(id, SESSION)).toBe(true)
    expect(s.acquire(id, SESSION)).toEqual({ kind: "not-found" })
    expect(s.get(id, SESSION)).toBeUndefined()
  })

  it("reports nothing destroyed for an id that was already spent", () => {
    const { s } = store()
    const id = s.create(SESSION, plan())
    expect(s.destroy(id, SESSION)).toBe(true)
    expect(s.destroy(id, SESSION)).toBe(false)
    expect(s.destroy(undefined, SESSION)).toBe(false)
  })
})

describe("not holding plans forever", () => {
  it("refuses an expired plan on read, without waiting for a sweep", () => {
    // A plan holds a parsed entry list — driver names and Steam GUIDs — and
    // stays valid for as long as it is readable, so expiry cannot depend on
    // something else happening to run first.
    const { s, advance } = store({ ttlMs: 60_000 })
    const id = s.create(SESSION, plan())
    advance(60_000)
    expect(s.get(id, SESSION)).toBeUndefined()
    expect(s.acquire(id, SESSION)).toEqual({ kind: "not-found" })
  })

  it("still serves a plan on the last millisecond of its life", () => {
    const { s, advance } = store({ ttlMs: 60_000 })
    const id = s.create(SESSION, plan())
    advance(59_999)
    expect(s.get(id, SESSION)).toBeDefined()
  })

  it("forgets an expired plan rather than just hiding it", () => {
    const { s, advance } = store({ ttlMs: 60_000 })
    const id = s.create(SESSION, plan())
    advance(60_000)
    s.get(id, SESSION)
    expect(s.size).toBe(0)
  })

  it("sweeps the expired and leaves the living", () => {
    const { s, advance } = store({ ttlMs: 60_000 })
    s.create(SESSION, plan(1))
    advance(30_000)
    const later = s.create(SESSION, plan(2))
    advance(30_000)
    expect(s.sweep()).toBe(1)
    expect(s.get(later, SESSION)).toBeDefined()
  })

  it("sweeps before storing, so previewing on every keystroke doesn't pile up", () => {
    const { s, advance } = store({ ttlMs: 60_000 })
    s.create(SESSION, plan(1))
    advance(60_000)
    s.create(SESSION, plan(2))
    expect(s.size).toBe(1)
  })

  it("refuses to grow without bound, and says what that means", () => {
    const { s } = store({ maxPlans: 2 })
    s.create(SESSION, plan(1))
    s.create(SESSION, plan(2))
    expect(() => s.create(SESSION, plan(3))).toThrow(/previewing without ever pushing/)
  })
})
