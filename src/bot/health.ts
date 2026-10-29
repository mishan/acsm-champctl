/**
 * Lets `serve` give up when one of its loops stops working, so Docker starts
 * it afresh, with a growing wait between attempts.
 *
 * In-process recovery missed the cases that mattered: a loop that has decided
 * something wrong keeps deciding it, and one that hangs never reaches its
 * catch. A fresh process re-reads everything. The wait is ours rather than
 * Docker's, whose backoff tops out at a minute: restarting into an ACSM ban
 * once a minute is the kind of burst that earned the ban.
 */

import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { migrate, type Migration, restrictToOwner } from "../sqlite.js"

const MINUTE = 60_000
/** How long a loop may go without a good tick, at the least. */
const STALE = 30 * MINUTE
/** The first wait after giving up; it doubles from there. */
const FIRST_WAIT = MINUTE
const LONGEST_WAIT = 30 * MINUTE
/** Running this long counts as working again, and forgets the earlier exits. */
const HEALTHY = 30 * MINUTE

/** Each loop's last good tick, and which has gone too long without one. */
export class Watchdog {
  readonly #loops = new Map<string, { everyMs: number; lastOk: number }>()
  readonly #now: () => number

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  /** Registers a loop; call the returned function after each of its ticks. */
  watch(name: string, everyMs: number): (ok: boolean) => void {
    const loop = { everyMs, lastOk: this.#now() }
    this.#loops.set(name, loop)
    return (ok) => {
      if (ok) loop.lastOk = this.#now()
    }
  }

  /** Why the process should exit, or undefined while every loop is working. */
  stale(): string | undefined {
    const now = this.#now()
    for (const [name, loop] of this.#loops) {
      // Three missed intervals, so a slow loop isn't judged by a fast one's clock.
      const limit = Math.max(STALE, 3 * loop.everyMs)
      if (now - loop.lastOk > limit) {
        return `${name} has had no good tick for ${Math.round((now - loop.lastOk) / MINUTE)} minutes`
      }
    }
    return undefined
  }
}

const MIGRATIONS: Migration[] = [
  {
    name: "restarts: initial schema",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS bot_restart (
          id     INTEGER PRIMARY KEY CHECK (id = 1),
          exits  INTEGER NOT NULL
        ) STRICT;
      `)
    },
  },
]

/** How many times in a row `serve` has given up, in the shared database. */
export class SqliteRestartStore {
  readonly #db: DatabaseSync
  readonly #now: () => number

  private constructor(db: DatabaseSync, now: () => number) {
    this.#db = db
    this.#now = now
  }

  static async open(path: string, now: () => number = Date.now): Promise<SqliteRestartStore> {
    if (path !== ":memory:") await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(path)
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA busy_timeout = 5000")
    migrate(db, "restarts", MIGRATIONS)
    if (path !== ":memory:") await restrictToOwner(path)
    return new SqliteRestartStore(db, now)
  }

  close(): void {
    this.#db.close()
  }

  /** How long to wait before starting, given the exits so far. */
  waitMs(): number {
    const exits = this.#exits()
    return exits === 0 ? 0 : Math.min(FIRST_WAIT * 2 ** (exits - 1), LONGEST_WAIT)
  }

  gaveUp(): void {
    this.#db
      .prepare(
        "INSERT INTO bot_restart (id, exits) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET exits = exits + 1",
      )
      .run()
  }

  /** Forgets the exits once this process has run HEALTHY since `startedAt`. */
  working(startedAt: number): void {
    if (this.#now() - startedAt >= HEALTHY) this.#db.exec("DELETE FROM bot_restart")
  }

  #exits(): number {
    const row = this.#db.prepare("SELECT exits FROM bot_restart WHERE id = 1").get() as
      | { exits: number }
      | undefined
    return row?.exits ?? 0
  }
}
