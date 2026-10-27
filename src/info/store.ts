/**
 * Which message is the championship info, and what it last said, so a
 * restart edits it rather than posting another. In the shared database.
 */

import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { migrate, type Migration, restrictToOwner } from "../sqlite.js"

const MIGRATIONS: Migration[] = [
  {
    name: "info: initial schema",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS info_message (
          key    TEXT PRIMARY KEY,
          value  TEXT NOT NULL
        ) STRICT;
      `)
    },
  },
]

export interface InfoStore {
  get(key: string): string | undefined
  set(key: string, value: string): void
}

export class SqliteInfoStore implements InfoStore {
  readonly #db: DatabaseSync

  private constructor(db: DatabaseSync) {
    this.#db = db
  }

  static async open(path: string): Promise<SqliteInfoStore> {
    if (path !== ":memory:") await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(path)
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA busy_timeout = 5000")
    migrate(db, "info", MIGRATIONS)
    if (path !== ":memory:") await restrictToOwner(path)
    return new SqliteInfoStore(db)
  }

  close(): void {
    this.#db.close()
  }

  get(key: string): string | undefined {
    const r = this.#db.prepare("SELECT value FROM info_message WHERE key = ?").get(key) as
      | { value: string }
      | undefined
    return r?.value
  }

  set(key: string, value: string): void {
    this.#db
      .prepare(
        "INSERT INTO info_message (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value)
  }
}
