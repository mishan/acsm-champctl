/**
 * The content index, kept across restarts in the response cache's database.
 *
 * This exists so a restart doesn't re-walk `/cars`, which is minutes against a
 * league's manager. What it has to survive is the ways a row written by a
 * previous run can be wrong, and the ways two managers could be confused for
 * each other.
 */

import { describe, expect, it } from "vitest"

import { SqliteCache } from "../src/acsm/cache.js"
import { contentStore, type KeptStore } from "../src/web/content-store.js"

const INDEX = {
  at: 0,
  value: {
    cars: [{ id: "ks_porsche_911_gt3_r_2016", name: "Porsche 911 GT3 R" }],
    tracks: [{ id: "ks_brands_hatch", name: "Brands Hatch" }],
  },
}

/** A `KeptStore` whose contents a test can reach into. */
function fake(): KeptStore & { rows: Map<string, { writtenAt: number; body: string }> } {
  const rows = new Map<string, { writtenAt: number; body: string }>()
  return {
    rows,
    async kept(key) {
      return rows.get(key)
    },
    async keep(key, body) {
      rows.set(key, { writtenAt: 1_700_000_000_000, body })
    },
  }
}

describe("keeping the content index across restarts", () => {
  it("reads back what it wrote", async () => {
    const store = contentStore(fake(), "https://acsm.example")
    await store.write(INDEX)
    expect((await store.read())?.value).toEqual(INDEX.value)
  })

  it("survives a real database, which is the point", async () => {
    // Against `SqliteCache` rather than the double, because the row has to
    // outlive the response TTL and that is a property of the schema — the
    // `kept` table exists precisely because `response` sweeps itself.
    let clock = 0
    const cache = await SqliteCache.open({ path: ":memory:", ttlMs: 1000, now: () => clock })
    try {
      const store = contentStore(cache, "https://acsm.example")
      await store.write(INDEX)
      await cache.set("https://acsm.example/x", "body")

      // Past the response TTL: that entry is gone.
      clock = 5000
      expect(await cache.get("https://acsm.example/x")).toBeUndefined()
      // The index is not, which is the whole reason it is in its own table.
      expect((await store.read())?.value).toEqual(INDEX.value)
    } finally {
      cache.close()
    }
  })

  /**
   * Pointing champctl at a different manager must not hand it the last one's
   * car list. The folder names belong to the manager, not to champctl.
   */
  it("gives each manager its own row", async () => {
    const kept = fake()
    await contentStore(kept, "https://a.example").write(INDEX)
    expect(await contentStore(kept, "https://b.example").read()).toBeUndefined()
    expect(await contentStore(kept, "https://a.example").read()).toBeTruthy()
  })

  it("has nothing to say on the first run", async () => {
    expect(await contentStore(fake(), "https://acsm.example").read()).toBeUndefined()
  })

  describe("a row that cannot be trusted", () => {
    /**
     * Written by a previous version of champctl as much as by this one. Half a
     * car list reaching the screen is a picker that silently offers the wrong
     * thing, which is worse than the slow start it was avoiding.
     */
    it("is ignored when the shape is wrong", async () => {
      const kept = fake()
      const store = contentStore(kept, "https://acsm.example")
      const key = "content:https://acsm.example"

      kept.rows.set(key, { writtenAt: 1, body: JSON.stringify({ cars: [] }) })
      expect(await store.read(), "no tracks key").toBeUndefined()

      kept.rows.set(key, { writtenAt: 1, body: JSON.stringify([1, 2, 3]) })
      expect(await store.read(), "not an object").toBeUndefined()

      kept.rows.set(key, { writtenAt: 1, body: JSON.stringify({ cars: 3, tracks: [] }) })
      expect(await store.read(), "cars is not a list").toBeUndefined()
    })

    it("throws on one that isn't JSON, for the caller to swallow", async () => {
      // `ContentCache.warm` catches this. Returning undefined here instead
      // would make "there was no row" and "the row is corrupt" the same thing,
      // and only one of those is worth knowing about.
      const kept = fake()
      kept.rows.set("content:https://acsm.example", { writtenAt: 1, body: "{ truncated" })
      await expect(contentStore(kept, "https://acsm.example").read()).rejects.toThrow()
    })
  })
})
