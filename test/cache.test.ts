import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { SqliteCache } from "../src/acsm/cache.js"

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "champctl-cache-"))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const dbPath = () => join(root, "acsm", "cache.db")
const open = (o: { ttlMs?: number; now?: () => number } = {}) =>
  SqliteCache.open({ path: dbPath(), ...o })

function countRows(): number {
  const db = new DatabaseSync(dbPath())
  const row = db.prepare("SELECT count(*) AS n FROM response").get() as { n: number }
  db.close()
  return row.n
}

describe("SqliteCache", () => {
  it("returns what it stored", async () => {
    const c = await open()
    await c.set("https://acsm.example/a", "<html>hello</html>")
    expect(await c.get("https://acsm.example/a")).toBe("<html>hello</html>")
    c.close()
  })

  it("keeps keys apart", async () => {
    const c = await open()
    await c.set("https://acsm.example/a", "one")
    await c.set("https://acsm.example/b", "two")
    expect(await c.get("https://acsm.example/a")).toBe("one")
    expect(await c.get("https://acsm.example/b")).toBe("two")
    c.close()
  })

  it("overwrites a key rather than accumulating copies", async () => {
    const c = await open()
    await c.set("https://acsm.example/a", "before")
    await c.set("https://acsm.example/a", "after")
    expect(await c.get("https://acsm.example/a")).toBe("after")
    expect(countRows()).toBe(1)
    c.close()
  })

  it("ignores an entry past its TTL", async () => {
    let clock = 1_000_000
    const c = await open({ ttlMs: 60_000, now: () => clock })
    await c.set("https://acsm.example/a", "stale")
    clock += 60_001
    expect(await c.get("https://acsm.example/a")).toBeUndefined()
    c.close()
  })

  it("treats a missing entry as a miss, not an error", async () => {
    const c = await open()
    expect(await c.get("https://acsm.example/never-fetched")).toBeUndefined()
    c.close()
  })

  it("deletes what it expires instead of keeping it forever", async () => {
    // A TTL that only decides what may be *read* leaves every page ever
    // fetched sitting on disk — and those pages are entry lists, so that is
    // driver names and Steam GUIDs accumulating with nothing to clear them.
    let clock = 1_000_000
    const c = await open({ ttlMs: 60_000, now: () => clock })
    await c.set("https://acsm.example/old", "driver names")
    clock += 60_001
    await c.set("https://acsm.example/new", "other")

    expect(countRows(), "the expired body is gone, not merely unreadable").toBe(1)
    c.close()
  })

  it("keeps the entrant data it caches to the owner", async () => {
    // .gitignore keeps .cache/ out of the repo and does nothing about the
    // other accounts on a league VPS, where the usual 0022 umask leaves these
    // world-readable.
    const c = await open()
    await c.set("https://acsm.example/a", "driver names and GUIDs")

    expect((await stat(join(root, "acsm"))).mode & 0o777).toBe(0o700)
    expect((await stat(dbPath())).mode & 0o777).toBe(0o600)
    c.close()
  })

  it("fails to open loudly rather than pretending to cache", async () => {
    // Distinct from get/set, which swallow. A caller that asked for a cache
    // and got an object that silently never caches has no way to find out.
    await writeFile(join(root, "in-the-way"), "not a directory")
    await expect(SqliteCache.open({ path: join(root, "in-the-way", "cache.db") })).rejects.toThrow()
  })

  it("never serves half an entry to a reader mid-write", async () => {
    // What the file-per-entry version got wrong: writeFile truncates before it
    // writes, so a run reading an entry while another rewrote it saw neither
    // body — and an unparseable entry reads as a miss, so a cache that stops
    // caching under concurrent use looks exactly like a cold one. An upsert
    // has no such window.
    const c = await open()
    const key = "https://acsm.example/championship/abc"
    const before = "a".repeat(500_000)
    const after = "b".repeat(500_000)

    await c.set(key, before)

    let torn = 0
    let reads = 0
    let writing = true
    const reader = (async () => {
      while (writing) {
        const got = await c.get(key)
        reads++
        if (got !== before && got !== after) torn++
      }
    })()

    for (let i = 0; i < 20; i++) await c.set(key, i % 2 === 0 ? after : before)
    writing = false
    await reader

    expect(reads, "the reader actually ran during the writes").toBeGreaterThan(5)
    expect(torn, "every read saw one whole body").toBe(0)
    c.close()
  })

  it("is shared by two handles on the same file", async () => {
    // A nightly archive run and someone at a terminal are two processes
    // against one league. WAL and a busy timeout are what make that queue
    // rather than fail.
    const a = await open()
    const b = await open()
    await a.set("https://acsm.example/a", "written by the first")
    expect(await b.get("https://acsm.example/a")).toBe("written by the first")
    a.close()
    b.close()
  })

  it("leaves nothing open behind it when closed", async () => {
    // The connection owns a WAL and a shared-memory file. SQLite removes both
    // on a clean close and leaves them for the next process to recover on an
    // unclean one, so their absence is the observable form of "closed" —
    // worth pinning, because nothing else in a CLI that exits immediately
    // would ever notice the difference.
    const c = await open()
    await c.set("https://acsm.example/a", "x")
    expect(await readdir(join(root, "acsm"))).toContain("cache.db-wal")

    c.close()
    expect(await readdir(join(root, "acsm"))).toEqual(["cache.db"])
  })

  it("keeps the cache directory to the database and its sidecars", async () => {
    const c = await open()
    await c.set("https://acsm.example/a", "x")
    const files = await readdir(join(root, "acsm"))
    expect(files.every((f) => f.startsWith("cache.db"))).toBe(true)
    c.close()
  })
})
