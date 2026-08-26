/**
 * On-disk response cache, in SQLite.
 *
 * Cache everything, and never poll on a timer tighter than the rate limit
 * (plan §3.1). A short TTL is right for the CLI — long enough that re-running
 * gridmom three times while fixing a pit box costs one request, short enough
 * that it still sees your fix.
 *
 * ## Why a database for a cache
 *
 * This was a file per entry, and that version had to grow a unique temp name,
 * a rename, an explicit chmod and a sweep to expire anything — several dozen
 * lines of hand-written plumbing for properties SQLite already has.
 * `node:sqlite` ships with the runtime and the archive store (§8.1) already
 * uses it, so this costs no dependency, no daemon and nothing to configure: an
 * upsert is atomic, WAL lets a read run while a write commits, and expiry is a
 * DELETE rather than a directory walk.
 *
 * ## What ends up on disk
 *
 * Whole ACSM response bodies, verbatim. An entry list carries driver names,
 * Steam GUIDs and whatever else a league puts in an entrant's fields, so this
 * file holds personal data even though nothing here is about people — it
 * caches pages, and the pages are full of them.
 *
 * `.gitignore` keeps `.cache/` out of the repo, which says nothing about the
 * other accounts on a league VPS, so a directory champctl creates is 0700 and
 * the database 0600. Expired rows are deleted on write rather than left to
 * accumulate: a TTL that only decides what may be *read* leaves every page
 * ever fetched sitting there, which is a different thing from a cache.
 */

import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { restrictToOwner } from "../sqlite.js"

import type { ResponseCache } from "./client.js"

const SCHEMA = `
CREATE TABLE IF NOT EXISTS response (
  key        TEXT PRIMARY KEY,
  fetched_at INTEGER NOT NULL,
  body       TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS response_by_age ON response (fetched_at);

/*
 * Things that must outlive the response TTL.
 *
 * A second table rather than a flag on the first, because the two want
 * opposite things and one sweep would serve both otherwise. The response
 * table exists to expire -- five minutes, deleted on write -- and this one
 * exists to survive a restart. The installed-content index is what it holds:
 * walking /cars is several requests against a rate limiter, so re-reading it
 * on every boot is minutes a person spends looking at an empty dropdown.
 *
 * Whoever writes here owns the freshness question. Nothing expires these.
 */
CREATE TABLE IF NOT EXISTS kept (
  key        TEXT PRIMARY KEY,
  written_at INTEGER NOT NULL,
  body       TEXT NOT NULL
) STRICT;
`

export interface SqliteCacheOptions {
  /** Database file. `:memory:` for a cache that lives as long as the process. */
  path: string
  /** Entries older than this are ignored. Default 5 minutes. */
  ttlMs?: number
  /** Injectable so a test doesn't have to wait out a TTL. */
  now?: () => number
}

export class SqliteCache implements ResponseCache {
  readonly #db: DatabaseSync
  readonly #ttlMs: number
  readonly #now: () => number

  private constructor(db: DatabaseSync, ttlMs: number, now: () => number) {
    this.#db = db
    this.#ttlMs = ttlMs
    this.#now = now
  }

  static async open(options: SqliteCacheOptions): Promise<SqliteCache> {
    const { path } = options
    // 0700 on a directory champctl creates. An existing one is the operator's
    // to set, and quietly rewriting its mode would be worse than leaving it —
    // the same rule the archive store follows.
    if (path !== ":memory:") await mkdir(dirname(path), { recursive: true, mode: 0o700 })

    const db = new DatabaseSync(path)
    // WAL so a reader isn't blocked by a writer committing, and a busy timeout
    // so two champctl runs queue rather than one failing outright. A cache is
    // the last thing that should turn contention into an error.
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA busy_timeout = 5000")
    db.exec(SCHEMA)

    if (path !== ":memory:") await restrictToOwner(path)
    return new SqliteCache(db, options.ttlMs ?? 5 * 60_000, options.now ?? (() => Date.now()))
  }

  async get(key: string): Promise<string | undefined> {
    try {
      const row = this.#db
        .prepare("SELECT body FROM response WHERE key = ? AND fetched_at > ?")
        .get(key, this.#now() - this.#ttlMs) as { body: string } | undefined
      return row?.body
    } catch {
      // A cache that can't be read is a miss, never an error.
      return undefined
    }
  }

  async set(key: string, value: string): Promise<void> {
    try {
      const now = this.#now()
      // Upsert rather than delete-then-insert: one statement, so there is no
      // moment when the entry is neither the old body nor the new one.
      this.#db
        .prepare(
          `INSERT INTO response (key, fetched_at, body) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET fetched_at = excluded.fetched_at, body = excluded.body`,
        )
        .run(key, now, value)
      // Expiry has to happen somewhere, and a write is the only moment this
      // class is reliably called. Cheap: the index makes it a range scan over
      // rows that are all about to be deleted anyway.
      this.#db.prepare("DELETE FROM response WHERE fetched_at <= ?").run(now - this.#ttlMs)
    } catch {
      // Caching is an optimisation; failing to write must not fail the request.
    }
  }

  /**
   * Read something stored without a lifetime.
   *
   * Separate from `get` on purpose: that one answers "is this still fresh",
   * and this one answers "what did the last run leave". A caller of `keep`
   * decides for itself when what it stored has gone stale — `ContentCache`
   * serves it and refreshes behind whoever asked.
   */
  async kept(key: string): Promise<{ writtenAt: number; body: string } | undefined> {
    try {
      const row = this.#db.prepare("SELECT written_at, body FROM kept WHERE key = ?").get(key) as
        | { written_at: number; body: string }
        | undefined
      return row ? { writtenAt: row.written_at, body: row.body } : undefined
    } catch {
      // Same rule as `get`: a store that can't be read is a miss.
      return undefined
    }
  }

  async keep(key: string, body: string): Promise<void> {
    try {
      this.#db
        .prepare(
          `INSERT INTO kept (key, written_at, body) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET written_at = excluded.written_at, body = excluded.body`,
        )
        .run(key, this.#now(), body)
    } catch {
      // Costs the next restart its head start, nothing more.
    }
  }

  close(): void {
    this.#db.close()
  }
}

/** No-op cache, for when a caller explicitly wants fresh data. */
export const NO_CACHE: ResponseCache = {
  async get() {
    return undefined
  },
  async set() {
    /* no-op */
  },
}
