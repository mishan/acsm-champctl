/**
 * What the Racers watch has already done, so a restart doesn't do it again: a
 * season's sign-ups announced, its last reminder, a finished season's
 * holders warned about and removed. In the shared database beside the claims.
 */

import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { migrate, type Migration, restrictToOwner } from "../sqlite.js"

const MIGRATIONS: Migration[] = [
  {
    name: "racers: initial schema",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS racers_marks (
          key  TEXT PRIMARY KEY,
          at   TEXT NOT NULL
        ) STRICT;
      `)
    },
  },
]

export interface RacerMarks {
  get(key: string): Date | undefined
  set(key: string, at: Date): void
}

export class SqliteRacersStore implements RacerMarks {
  readonly #db: DatabaseSync

  private constructor(db: DatabaseSync) {
    this.#db = db
  }

  static async open(path: string): Promise<SqliteRacersStore> {
    if (path !== ":memory:") await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(path)
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA busy_timeout = 5000")
    migrate(db, "racers", MIGRATIONS)
    if (path !== ":memory:") await restrictToOwner(path)
    return new SqliteRacersStore(db)
  }

  close(): void {
    this.#db.close()
  }

  get(key: string): Date | undefined {
    const r = this.#db.prepare("SELECT at FROM racers_marks WHERE key = ?").get(key) as
      | { at: string }
      | undefined
    return r && new Date(r.at)
  }

  set(key: string, at: Date): void {
    this.#db
      .prepare(
        "INSERT INTO racers_marks (key, at) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET at = excluded.at",
      )
      .run(key, at.toISOString())
  }
}
