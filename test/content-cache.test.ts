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

import { describe, expect, it, vi } from "vitest"

import type { InstalledContent } from "../src/acsm/content.js"
import { ContentCache } from "../src/acsm/content-cache.js"

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

  /**
   * Stale is served, and refreshed behind whoever asked.
   *
   * Waiting for the refresh puts the whole cost of a walk back on a person,
   * once an hour, at random — which is the thing that made opening the create
   * screen hang. So the caller gets the old list immediately and the new one
   * lands for whoever comes next.
   */
  it("hands back what it has while it refreshes", async () => {
    let reads = 0
    let clock = 0
    let release: (() => void) | undefined
    const cache = new ContentCache({
      ttlMs: 1000,
      now: () => clock,
      load: async () => {
        reads++
        if (reads > 1) await new Promise<void>((r) => (release = r))
        return content(String(reads))
      },
    })

    expect((await cache.get()).cars[0]?.id).toBe("1")
    clock = 1001

    // Stale, and the refresh is deliberately still hanging. The old value
    // comes back anyway rather than this awaiting the read.
    expect((await cache.get()).cars[0]?.id).toBe("1")
    expect(reads).toBe(2)

    release?.()
    await vi.waitFor(async () => {
      expect((await cache.get()).cars[0]?.id).toBe("2")
    })
  })

  it("takes another process's fresh read from the store rather than reading again", async () => {
    // champctl web and the bot share one store: one reading is enough for both.
    let clock = 0
    let stored: { at: number; value: InstalledContent } | undefined
    const store = {
      read: async () => stored,
      write: async (e: typeof stored) => {
        stored = e
      },
    }
    const reads: string[] = []
    const cache = (who: string) =>
      new ContentCache({
        ttlMs: 1000,
        now: () => clock,
        store,
        load: async () => {
          reads.push(who)
          return content(who)
        },
      })
    const web = cache("web")
    const bot = cache("bot")
    await bot.get()
    clock = 1500
    await web.get()
    clock = 2100
    // The bot's own copy is stale; the store's, from the web a moment ago, isn't.
    await bot.get()
    await vi.waitFor(async () => expect((await bot.get()).cars[0]?.id).toBe("web"))
    expect(reads).toEqual(["bot", "web"])
  })

  it("peeks without ever waiting on a read, and starts one when it has nothing", async () => {
    let release: (() => void) | undefined
    const cache = new ContentCache({
      load: () => new Promise<InstalledContent>((r) => (release = () => r(content("a")))),
    })
    expect(cache.peek()).toBeUndefined()
    release?.()
    await vi.waitFor(() => expect(cache.peek()?.cars[0]?.id).toBe("a"))
  })

  it("reconciles: reads again though what it holds is fresh, and says what it had", async () => {
    let reads = 0
    let release: (() => void) | undefined
    const changed: [string, string][] = []
    const cache = new ContentCache({
      load: async () => {
        reads++
        if (reads > 1) await new Promise<void>((r) => (release = r))
        return content(String(reads))
      },
      onChange: (before, after) => changed.push([before.cars[0]!.id, after.cars[0]!.id]),
    })
    await cache.get()
    const reconciling = cache.reconcile()
    await vi.waitFor(() => expect(release).toBeDefined())
    release?.()
    const { before, after } = await reconciling
    expect([before?.cars[0]?.id, after.cars[0]?.id]).toEqual(["1", "2"])
    expect(changed).toEqual([["1", "2"]])
  })

  it("reconciles from Server Manager though a stale peek starts a read as it begins", async () => {
    let clock = 0
    let reads = 0
    const cache = new ContentCache({
      ttlMs: 1000,
      now: () => clock,
      // Always fresh: a read that took it would never ask Server Manager.
      store: {
        read: async () => ({ at: clock, value: content("stored") }),
        write: async () => undefined,
      },
      load: async () => (reads++, content("read")),
    })
    await cache.get()
    clock = 2000
    const reconciling = cache.reconcile()
    cache.peek()
    expect((await reconciling).after.cars[0]?.id).toBe("read")
    expect(reads).toBe(1)
  })

  it("reconciles from Server Manager, not from a fresh copy in the store", async () => {
    let reads = 0
    const cache = new ContentCache({
      store: {
        read: async () => ({ at: Date.now(), value: content("stored") }),
        write: async () => undefined,
      },
      load: async () => (reads++, content("read")),
    })
    expect((await cache.get()).cars[0]?.id).toBe("stored")
    expect((await cache.reconcile()).after.cars[0]?.id).toBe("read")
    expect(reads).toBe(1)
  })

  it("takes a newer copy another process stored, looking at most once a minute", async () => {
    let clock = 0
    let stored: { at: number; value: InstalledContent } | undefined = { at: 0, value: content("a") }
    let looks = 0
    const changed: string[] = []
    const cache = new ContentCache({
      now: () => clock,
      store: {
        read: async () => (looks++, stored),
        write: async () => undefined,
      },
      load: async () => content("never"),
      onChange: (_, after) => changed.push(after.cars[0]!.id),
    })
    await cache.warm()
    await new Promise((r) => setImmediate(r))
    const before = looks
    stored = { at: 1000, value: content("b") }
    clock = 30_000
    cache.peek()
    expect(looks).toBe(before)
    clock = 61_000
    cache.peek()
    await vi.waitFor(() => expect(cache.peek()?.cars[0]?.id).toBe("b"))
    expect(changed).toEqual(["b"])
  })

  describe("across a restart", () => {
    /**
     * The point of persisting it. Re-walking `/cars` on every boot is minutes
     * against a league's manager, and the person who just restarted champctl
     * is usually the person about to open the screen.
     */
    it("serves what the last run stored, without waiting for a read", async () => {
      let released: (() => void) | undefined
      const cache = new ContentCache({
        store: {
          read: async () => ({ at: 0, value: content("from-disk") }),
          write: async () => undefined,
        },
        // Never resolves during this test: anything that answers must have
        // come from the store.
        load: () => new Promise<InstalledContent>((r) => (released = () => r(content("fresh")))),
      })

      await cache.warm()
      expect((await cache.get()).cars[0]?.id).toBe("from-disk")
      released?.()
    })

    it("stores what it read, for the next boot", async () => {
      const written: { at: number; value: InstalledContent }[] = []
      const cache = new ContentCache({
        store: { read: async () => undefined, write: async (e) => void written.push(e) },
        load: async () => content("a"),
      })

      await cache.get()
      expect(written).toHaveLength(1)
      expect(written[0]?.value.cars[0]?.id).toBe("a")
    })

    /**
     * A store that cannot be read is a slow start, not a failed one — and a
     * manager that is down at boot is one champctl should still come up
     * against.
     */
    it("starts anyway when the store or the manager is unavailable", async () => {
      const cache = new ContentCache({
        store: {
          read: async () => {
            throw new Error("no such file")
          },
          write: async () => {
            throw new Error("read-only filesystem")
          },
        },
        load: async () => {
          throw new Error("manager is down")
        },
      })

      await expect(cache.warm()).resolves.toBeUndefined()
    })
  })

  it("reads again after an hour unless told otherwise, and not before", async () => {
    let clock = 0
    let reads = 0
    // As the layouts index is: no lifetime given, and nothing to read until it's asked.
    const cache = new ContentCache<null>({ now: () => clock, load: async () => (reads++, null) })
    await cache.get()
    clock = 59 * 60_000
    await cache.get()
    expect(reads).toBe(1)
    clock = 61 * 60_000
    await cache.get()
    await vi.waitFor(() => expect(reads).toBe(2))
    await new Promise((r) => setImmediate(r))
    // The same answer again is still a new read: it isn't asked for again until the next hour.
    clock = 62 * 60_000
    await cache.get()
    await new Promise((r) => setImmediate(r))
    expect(reads).toBe(2)
  })

  it("keeps what it holds when a new read is one it shouldn't believe", async () => {
    let clock = 0
    let reads = 0
    const cache = new ContentCache({
      ttlMs: 1000,
      now: () => clock,
      load: async () => (++reads === 1 ? content("a") : { cars: [], tracks: [] }),
      believe: (next) => (next.cars.length ? undefined : "no cars"),
    })
    await cache.get()
    clock = 1001
    await cache.get()
    await vi.waitFor(() => expect(reads).toBe(2))
    await new Promise((r) => setImmediate(r))
    expect((await cache.get()).cars[0]?.id).toBe("a")
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
