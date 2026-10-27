/**
 * The championships each of the bot's watchers has found finished, so a
 * restart doesn't read them all again. Each watcher walks every championship
 * through ACSM's five requests in twenty seconds, and three of them doing it at
 * once kept commands that read ACSM waiting minutes after every deploy. In the
 * shared database.
 */

import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { migrate, type Migration, restrictToOwner } from "../sqlite.js"

const MIGRATIONS: Migration[] = [
  {
    name: "finished: initial schema",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS finished_championship (
          watcher  TEXT NOT NULL,
          id       TEXT NOT NULL,
          kept     TEXT NOT NULL,
          PRIMARY KEY (watcher, id)
        ) STRICT;
      `)
    },
  },
]

/** One watcher's finished championships, each with whatever it keeps about one. */
export interface FinishedChampionships {
  all(): Map<string, string>
  add(id: string, kept?: string): void
}

export class SqliteFinishedStore {
  readonly #db: DatabaseSync

  private constructor(db: DatabaseSync) {
    this.#db = db
  }

  static async open(path: string): Promise<SqliteFinishedStore> {
    if (path !== ":memory:") await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(path)
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA busy_timeout = 5000")
    migrate(db, "finished", MIGRATIONS)
    if (path !== ":memory:") await restrictToOwner(path)
    return new SqliteFinishedStore(db)
  }

  close(): void {
    this.#db.close()
  }

  for(watcher: string): FinishedChampionships {
    return {
      all: () => {
        const rows = this.#db
          .prepare("SELECT id, kept FROM finished_championship WHERE watcher = ?")
          .all(watcher) as { id: string; kept: string }[]
        return new Map(rows.map((r) => [r.id, r.kept]))
      },
      add: (id, kept = "") => {
        this.#db
          .prepare(
            "INSERT INTO finished_championship (watcher, id, kept) VALUES (?, ?, ?) ON CONFLICT(watcher, id) DO UPDATE SET kept = excluded.kept",
          )
          .run(watcher, id, kept)
      },
    }
  }
}
