/**
 * The failed-login throttle.
 *
 * Worth testing carefully because it is the only thing standing between
 * champctl's login endpoint and a credential-testing oracle for a league's
 * admin panel, and because every property it has is a *timing* property — the
 * kind that stays green by accident when the clock is real. Every test here
 * drives an injected clock, so "fifteen minutes later" is a fact rather than a
 * hope.
 */

import { describe, expect, it } from "vitest"

import { LoginThrottle } from "../src/web/throttle.js"

/** A throttle on a clock the test owns. Small numbers so the maths is legible. */
function throttle(over: { maxFailures?: number; maxTracked?: number } = {}) {
  let now = 1_000_000
  const t = new LoginThrottle({
    maxFailures: over.maxFailures ?? 3,
    windowMs: 60_000,
    cooldownMs: 300_000,
    maxTracked: over.maxTracked ?? 10_000,
    now: () => now,
  })
  return { t, advance: (ms: number) => (now += ms) }
}

describe("counting failures", () => {
  it("lets an address through until it has failed enough", () => {
    const { t } = throttle()
    expect(t.retryAfterMs("a")).toBe(0)
    t.fail("a")
    t.fail("a")
    expect(t.retryAfterMs("a")).toBe(0)
    t.fail("a")
    expect(t.retryAfterMs("a")).toBe(300_000)
  })

  it("refuses only the address that failed", () => {
    const { t } = throttle()
    for (let i = 0; i < 3; i++) t.fail("a")
    expect(t.retryAfterMs("a")).toBeGreaterThan(0)
    expect(t.retryAfterMs("b")).toBe(0)
  })

  it("slides the window, so an address isn't held to an old afternoon", () => {
    const { t, advance } = throttle()
    t.fail("a")
    t.fail("a")
    advance(60_001)
    // Both earlier failures are now outside the window, so this is the first
    // one that counts and two more would be needed to trigger a cooldown.
    t.fail("a")
    expect(t.retryAfterMs("a")).toBe(0)
  })

  it("counts down the cooldown and then lets the address try again", () => {
    const { t, advance } = throttle()
    for (let i = 0; i < 3; i++) t.fail("a")
    advance(100_000)
    expect(t.retryAfterMs("a")).toBe(200_000)
    advance(200_000)
    expect(t.retryAfterMs("a")).toBe(0)
  })

  it("forgets everything on a success", () => {
    const { t } = throttle()
    t.fail("a")
    t.fail("a")
    t.succeed("a")
    expect(t.size).toBe(0)
    // Not merely unblocked — the count is gone, so this is failure one of
    // three rather than the one that tips it over.
    t.fail("a")
    expect(t.retryAfterMs("a")).toBe(0)
  })
})

describe("not growing forever", () => {
  it("drops a record once there is nothing left to remember", () => {
    const { t, advance } = throttle()
    t.fail("a")
    expect(t.size).toBe(1)
    advance(60_001)
    // The read path is the one that runs on every attempt; if only `fail`
    // swept, an address that failed once and never returned would sit in the
    // map until some other address happened to fail.
    expect(t.retryAfterMs("a")).toBe(0)
    expect(t.size).toBe(0)
  })

  it("keeps a record while its cooldown is still running", () => {
    const { t, advance } = throttle()
    for (let i = 0; i < 3; i++) t.fail("a")
    advance(299_999)
    expect(t.retryAfterMs("a")).toBe(1)
    expect(t.size).toBe(1)
  })

  it("collects expired records when a new address fails", () => {
    const { t, advance } = throttle()
    t.fail("old")
    advance(60_001)
    t.fail("new")
    expect(t.size).toBe(1)
    expect(t.retryAfterMs("new")).toBe(0)
  })

  it("stops tracking new addresses when full rather than evicting", () => {
    // Evicting on a full map is what an attacker would arrange deliberately,
    // by cycling source addresses until the record that matters is pushed out.
    // Refusing to track is the safe direction: the addresses already being
    // counted keep being counted.
    const { t } = throttle({ maxTracked: 2 })
    for (let i = 0; i < 3; i++) t.fail("a")
    t.fail("b")
    t.fail("c")
    expect(t.size).toBe(2)
    expect(t.retryAfterMs("a")).toBe(300_000)
  })

  it("makes room again once the expired records are swept", () => {
    const { t, advance } = throttle({ maxTracked: 2 })
    t.fail("a")
    t.fail("b")
    advance(60_001)
    t.fail("c")
    expect(t.size).toBe(1)
    // The point of the previous test is that a full map doesn't evict; the
    // point of this one is that "full" is temporary, so the refusal to track
    // can't become permanent.
    for (let i = 0; i < 3; i++) t.fail("c")
    expect(t.retryAfterMs("c")).toBeGreaterThan(0)
  })
})
