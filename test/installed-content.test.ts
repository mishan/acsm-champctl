import { describe, expect, it, vi } from "vitest"

import type { InstalledContent } from "../src/acsm/content.js"
import { ContentCache } from "../src/acsm/content-cache.js"
import {
  changes,
  reconcileDaily,
  reconcileDue,
  refreshContent,
  unbelievable,
} from "../src/acsm/installed-content.js"

const list = (cars: number, tracks = 2) => ({
  cars: Array.from({ length: cars }, (_, i) => ({ id: `c${i}`, name: `Car ${i}` })),
  tracks: Array.from({ length: tracks }, (_, i) => ({ id: `t${i}`, name: `Track ${i}` })),
})

describe("which reads of what's installed to believe", () => {
  // A listing that fails reads as an empty one: Server Manager down for a
  // moment mustn't leave a week of empty pickers.
  it.each([
    ["the first read", list(0, 0), undefined, undefined],
    ["a car installed", list(11), list(10), undefined],
    ["a few cars removed", list(7), list(10), undefined],
    ["no cars where there were some", list(0), list(10), /cars/],
    ["no tracks where there were some", list(10, 0), list(10), /tracks/],
    ["more than half the cars gone", list(4), list(10), /cars/],
  ])("%s", (_, next, held, refused) => {
    const why = unbelievable(next, held)
    if (refused) expect(why).toMatch(refused)
    else expect(why).toBeUndefined()
  })
})

describe("what changed in what's installed", () => {
  it("names what was added, removed and renamed, and says nothing when nothing was", () => {
    const before = {
      cars: [
        { id: "ks_c7r", name: "Corvette C7R" },
        { id: "lotus_72d", name: "Lotus 72D" },
      ],
      tracks: [{ id: "vir", name: "VIR" }],
    }
    const after = {
      cars: [
        { id: "ks_c7r", name: "Chevrolet Corvette C7R" },
        { id: "c8r", name: "Corvette C8.R" },
      ],
      tracks: [{ id: "vir", name: "VIR" }],
    }
    expect(changes(before, after)).toBe(
      "Server Manager's cars changed: added Corvette C8.R; removed Lotus 72D; renamed Corvette C7R to Chevrolet Corvette C7R.",
    )
    expect(changes(before, before)).toBeUndefined()
  })
})

describe("when the daily reconcile is due", () => {
  const zone = "America/Los_Angeles"
  // 05:00 in Los Angeles: 13:00 UTC in winter, 12:00 in summer.
  it.each([
    ["read yesterday, now past 05:00", "2026-11-16T20:00:00Z", "2026-11-17T13:01:00Z", true],
    ["read yesterday, not 05:00 yet", "2026-11-16T20:00:00Z", "2026-11-17T12:59:00Z", false],
    ["read since today's 05:00", "2026-11-17T13:30:00Z", "2026-11-17T20:00:00Z", false],
    ["in summer time", "2026-07-01T20:00:00Z", "2026-07-02T12:01:00Z", true],
    ["never read", undefined, "2026-11-17T13:01:00Z", true],
  ])("%s", (_, readAt, now, due) => {
    expect(reconcileDue(readAt ? Date.parse(readAt) : undefined, new Date(now), zone)).toBe(due)
  })
})

describe("reading what's installed again each day", () => {
  it("tries once a day, though the read fails", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-17T12:00:00Z") })
    try {
      let reads = 0
      const cache = new ContentCache<InstalledContent>({
        load: async () => {
          reads++
          throw new Error("Server Manager is down")
        },
      })
      const stop = reconcileDaily(cache, "America/Los_Angeles", () => undefined)
      // 04:00 to 05:00 the next morning, Los Angeles time, in five-minute ticks.
      await vi.advanceTimersByTimeAsync(2 * 3600_000)
      expect(reads).toBe(1)
      await vi.advanceTimersByTimeAsync(24 * 3600_000)
      expect(reads).toBe(2)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("an operator's refresh", () => {
  const cache = (...reads: (() => InstalledContent)[]) =>
    new ContentCache<InstalledContent>({ load: async () => reads.shift()!() })

  it("says what changed, or that nothing did", async () => {
    const c = cache(
      () => list(2),
      () => list(3),
      () => list(3),
    )
    await c.get()
    expect(await refreshContent(c)).toBe("Server Manager's cars changed: added Car 2.")
    expect(await refreshContent(c)).toBe(
      "Nothing changed: Server Manager has the 3 cars and 2 tracks champctl had.",
    )
  })

  it("says the list is unchanged when Server Manager can't be read", async () => {
    const c = cache(
      () => list(2),
      () => {
        throw new Error("fetch failed")
      },
    )
    await c.get()
    await expect(refreshContent(c)).rejects.toThrow(
      "I couldn't read Server Manager (fetch failed). The list of what's installed is unchanged.",
    )
    expect((await c.get()).cars).toHaveLength(2)
  })
})
