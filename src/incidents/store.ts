/**
 * Incident reports: who filed what, about which moment of which recording,
 * where it's being discussed and what the stewards decided.
 *
 * In the shared database beside the claims and the queue, the one file a
 * deployment already keeps and backs up. A report is numbered when it's filed,
 * so a steward can say "#12" from then on, whatever happens to its channel.
 */

import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { migrate, type Migration, restrictToOwner } from "../sqlite.js"

const MIGRATIONS: Migration[] = [
  {
    name: "incidents: initial schema",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS incidents (
          number            INTEGER PRIMARY KEY AUTOINCREMENT,
          filed_at          TEXT NOT NULL,
          reporter_discord  TEXT NOT NULL,
          reporter          TEXT NOT NULL,
          other             TEXT NOT NULL,
          other_discord     TEXT,
          journal           TEXT NOT NULL,
          at_ms             INTEGER NOT NULL,
          collision_index   INTEGER,
          description       TEXT NOT NULL,
          channel_id        TEXT UNIQUE,
          decision          TEXT,
          decided_by        TEXT,
          decided_at        TEXT
        ) STRICT;
      `)
    },
  },
]

export interface IncidentFiling {
  reporterDiscord: string
  /** Entrant names, as on the entry list. */
  reporter: string
  other: string
  otherDiscord?: string
  /** The journal's file name in the recordings folder. */
  journal: string
  /** The moment, in ms from the session's start. */
  atMs: number
  collisionIndex?: number
  description: string
}

export interface Incident extends IncidentFiling {
  number: number
  filedAt: string
  channelId?: string
  decision?: string
  decidedBy?: string
  decidedAt?: string
}

interface Row {
  number: number
  filed_at: string
  reporter_discord: string
  reporter: string
  other: string
  other_discord: string | null
  journal: string
  at_ms: number
  collision_index: number | null
  description: string
  channel_id: string | null
  decision: string | null
  decided_by: string | null
  decided_at: string | null
}

const fromRow = (r: Row): Incident => ({
  number: r.number,
  filedAt: r.filed_at,
  reporterDiscord: r.reporter_discord,
  reporter: r.reporter,
  other: r.other,
  ...(r.other_discord ? { otherDiscord: r.other_discord } : {}),
  journal: r.journal,
  atMs: r.at_ms,
  ...(r.collision_index === null ? {} : { collisionIndex: r.collision_index }),
  description: r.description,
  ...(r.channel_id ? { channelId: r.channel_id } : {}),
  ...(r.decision === null ? {} : { decision: r.decision }),
  ...(r.decided_by ? { decidedBy: r.decided_by } : {}),
  ...(r.decided_at ? { decidedAt: r.decided_at } : {}),
})

export class SqliteIncidentStore {
  readonly #db: DatabaseSync

  private constructor(db: DatabaseSync) {
    this.#db = db
  }

  static async open(path: string): Promise<SqliteIncidentStore> {
    if (path !== ":memory:") await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(path)
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA busy_timeout = 5000")
    migrate(db, "incidents", MIGRATIONS)
    if (path !== ":memory:") await restrictToOwner(path)
    return new SqliteIncidentStore(db)
  }

  file(f: IncidentFiling, at: Date): Incident {
    const r = this.#db
      .prepare(
        `INSERT INTO incidents (filed_at, reporter_discord, reporter, other, other_discord, journal,
           at_ms, collision_index, description)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        at.toISOString(),
        f.reporterDiscord,
        f.reporter,
        f.other,
        f.otherDiscord ?? null,
        f.journal,
        Math.round(f.atMs),
        f.collisionIndex ?? null,
        f.description,
      ) as unknown as Row
    return fromRow(r)
  }

  setChannel(number: number, channelId: string): void {
    this.#db.prepare("UPDATE incidents SET channel_id = ? WHERE number = ?").run(channelId, number)
  }

  byChannel(channelId: string): Incident | undefined {
    const r = this.#db.prepare("SELECT * FROM incidents WHERE channel_id = ?").get(channelId) as
      | Row
      | undefined
    return r && fromRow(r)
  }

  /** The same report filed twice, by the same driver: a double-tap, not two incidents. */
  existing(reporterDiscord: string, journal: string, atMs: number): Incident | undefined {
    const r = this.#db
      .prepare(
        // Without a channel, the report never got anywhere, and filing it again should.
        `SELECT * FROM incidents WHERE reporter_discord = ? AND journal = ? AND abs(at_ms - ?) < 5000
         AND channel_id IS NOT NULL ORDER BY number LIMIT 1`,
      )
      .get(reporterDiscord, journal, Math.round(atMs)) as Row | undefined
    return r && fromRow(r)
  }

  decide(number: number, decision: string, by: string, at: Date): void {
    this.#db
      .prepare("UPDATE incidents SET decision = ?, decided_by = ?, decided_at = ? WHERE number = ?")
      .run(decision, by, at.toISOString(), number)
  }

  close(): void {
    this.#db.close()
  }
}
