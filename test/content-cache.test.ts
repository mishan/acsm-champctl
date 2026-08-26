/**
 * Holding the installed-content index.
 *
 * The reason this is cached at all is a number: `/cars` pages at fifty, so a
 * stock install is four requests plus `/tracks`, against champctl's own limiter
 * of five reads per twenty seconds. A screen that fetched it on every mount
 * would spend twenty seconds waiting for permission champctl gave itself. So
 * what these check is not "does it memoise" but the two ways the memo could
 * still let that happen.
 */

import { describe, expect, it } from "vitest"

import type { InstalledContent } from "../src/acsm/content.js"
import { ContentCache } from "../src/web/content-cache.js"

const content = (id: string): InstalledContent => ({
  cars: [{ id, name: id }],
  tracks: [],
})

describe("holding the content index", () => {
  it("reads once and answers from what it read", async () => {
    let reads = 0
    const cache = new ContentCache({
      load: async () => {
        reads++
        return content("a")
      },
    })

    expect((await cache.get()).cars[0]?.id).toBe("a")
    expect((await cache.get()).cars[0]?.id).toBe("a")
    expect(reads).toBe(1)
  })

  /**
   * Two people opening the screen at once is the ordinary case, not the rare
   * one. Memoising only the *finished* answer leaves that as two full walks of
   * `/cars` — which is more requests than the limiter allows in its window, so
   * the second person waits out champctl's own rate limiting rather than
   * anything to do with their answer.
   */
  it("makes one read for however many callers arrive while it is in flight", async () => {
    let reads = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((r) => {
      release = r
    })

    const cache = new ContentCache({
      load: async () => {
        reads++
        await gate
        return content("a")
      },
    })

    const both = Promise.all([cache.get(), cache.get()])
    release?.()
    const [first, second] = await both

    expect(reads).toBe(1)
    expect(first).toBe(second)
  })

  it("reads again once what it held has aged out", async () => {
    let reads = 0
    let clock = 0
    const cache = new ContentCache({
      ttlMs: 1000,
      now: () => clock,
      load: async () => content(String(++reads)),
    })

    expect((await cache.get()).cars[0]?.id).toBe("1")
    clock = 999
    expect((await cache.get()).cars[0]?.id).toBe("1")
    clock = 1001
    expect((await cache.get()).cars[0]?.id).toBe("2")
  })

  /**
   * A failed read must not be remembered as an answer, or a manager that was
   * briefly down leaves the screen with an empty car list for an hour — and a
   * strict picker with an empty list is a screen nobody can use.
   */
  it("does not hold on to a failure", async () => {
    let reads = 0
    const cache = new ContentCache({
      load: async () => {
        reads++
        if (reads === 1) throw new Error("manager is down")
        return content("a")
      },
    })

    await expect(cache.get()).rejects.toThrow(/manager is down/)
    expect((await cache.get()).cars[0]?.id).toBe("a")
    expect(reads).toBe(2)
  })
})
