/**
 * Which podiums have been posted to the trophy room.
 *
 * The nightly job posts a championship's podium once, the night after its last
 * round. Without a record it posts it again the next night, and every night
 * after for the week it counts as recent — so this lives in the shared
 * database beside the queue, the one file a deployment already keeps.
 */

import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { migrate, type Migration, restrictToOwner } from "../sqlite.js"

const MIGRATIONS: Migration[] = [
  {
    name: "trophies: initial schema",
    up: (db) => {
      db.exec(`
        -- One row per class posted. A multi-class championship whose post
        -- failed part way through finishes the rest the next night rather than
        -- posting the classes that already went out a second time.
        CREATE TABLE IF NOT EXISTS trophy_posted (
          championship_id  TEXT NOT NULL,
          class_name       TEXT NOT NULL,
          posted_at        TEXT NOT NULL,
          PRIMARY KEY (championship_id, class_name)
        ) STRICT;
      `)
    },
  },
]

export class SqliteTrophyStore {
  readonly #db: DatabaseSync

  private constructor(db: DatabaseSync) {
    this.#db = db
  }

  static async open(path: string): Promise<SqliteTrophyStore> {
    if (path !== ":memory:") await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(path)
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA busy_timeout = 5000")
    migrate(db, "trophies", MIGRATIONS)
    if (path !== ":memory:") await restrictToOwner(path)
    return new SqliteTrophyStore(db)
  }

  /** The classes of this championship already posted; "" is a single-class one. */
  posted(championshipId: string): Set<string> {
    const rows = this.#db
      .prepare("SELECT class_name FROM trophy_posted WHERE championship_id = ?")
      .all(championshipId) as unknown as { class_name: string }[]
    return new Set(rows.map((r) => r.class_name))
  }

  record(championshipId: string, className: string, at: Date): void {
    this.#db
      .prepare(
        `INSERT INTO trophy_posted (championship_id, class_name, posted_at) VALUES (?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(championshipId, className, at.toISOString())
  }

  close(): void {
    this.#db.close()
  }
}
