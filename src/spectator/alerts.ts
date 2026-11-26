/**
 * What the recorder needs someone to know, kept in the shared database: the
 * recorder holds no Discord token, so the bot posts these for it.
 */

import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { migrate, type Migration, restrictToOwner } from "../sqlite.js"

export const ALERT_MIGRATIONS: Migration[] = [
  {
    name: "recorder alerts: initial schema",
    up: (db) => {
      db.exec(`
        CREATE TABLE recorder_alert (
          key               TEXT PRIMARY KEY,
          message           TEXT NOT NULL,
          opened_at         INTEGER NOT NULL,
          resolved_at       INTEGER,
          posted_at         INTEGER,
          resolution_posted INTEGER NOT NULL DEFAULT 0
        ) STRICT;
      `)
    },
  },
]

/** What the recorder does with alerts. */
export interface RecorderAlerts {
  /** Opens the alert, or reopens it if resolved; an open one takes the new message. */
  raise(key: string, message: string, now: Date): void
  resolve(key: string, now: Date): void
}

/** An alert the bot owes a post. */
export interface DueAlert {
  key: string
  kind: "open" | "resolved"
  message: string
  /** Which opening this is, so marking it told can't mark a later one. */
  openedAt: number
}

const DAY = 24 * 3600_000

export class SqliteRecorderAlerts implements RecorderAlerts {
  readonly #db: DatabaseSync

  private constructor(db: DatabaseSync) {
    this.#db = db
  }

  static async open(path: string): Promise<SqliteRecorderAlerts> {
    if (path !== ":memory:") await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(path)
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA busy_timeout = 5000")
    migrate(db, "recorder alerts", ALERT_MIGRATIONS)
    if (path !== ":memory:") await restrictToOwner(path)
    return new SqliteRecorderAlerts(db)
  }

  close(): void {
    this.#db.close()
  }

  raise(key: string, message: string, now: Date): void {
    // A reopened alert starts over: posted afresh, and its resolution owed again.
    this.#db
      .prepare(
        `INSERT INTO recorder_alert (key, message, opened_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET
           message = excluded.message,
           opened_at = CASE WHEN resolved_at IS NULL THEN opened_at ELSE excluded.opened_at END,
           posted_at = CASE WHEN resolved_at IS NULL THEN posted_at ELSE NULL END,
           resolution_posted = CASE WHEN resolved_at IS NULL THEN resolution_posted ELSE 0 END,
           resolved_at = NULL`,
      )
      .run(key, message, now.getTime())
  }

  resolve(key: string, now: Date): void {
    this.#db
      .prepare("UPDATE recorder_alert SET resolved_at = ? WHERE key = ? AND resolved_at IS NULL")
      .run(now.getTime(), key)
  }

  /**
   * Open alerts not posted in the last day, and resolutions of alerts that
   * were posted. One resolved before anyone was told needs no word.
   */
  due(now: Date): DueAlert[] {
    const rows = this.#db
      .prepare(
        `SELECT key, message, opened_at, resolved_at FROM recorder_alert
         WHERE (resolved_at IS NULL AND (posted_at IS NULL OR posted_at <= ?))
            OR (resolved_at IS NOT NULL AND posted_at IS NOT NULL AND resolution_posted = 0)
         ORDER BY key`,
      )
      .all(now.getTime() - DAY) as {
      key: string
      message: string
      opened_at: number
      resolved_at: number | null
    }[]
    return rows.map((r) => ({
      key: r.key,
      kind: r.resolved_at === null ? "open" : "resolved",
      message: r.message,
      openedAt: r.opened_at,
    }))
  }

  /** Records the post, unless the alert has been reopened since `due` read it. */
  told(a: DueAlert, now: Date): void {
    // An open alert's post stands even if it resolved meanwhile: its
    // resolution is then owed.
    const sql =
      a.kind === "open"
        ? "UPDATE recorder_alert SET posted_at = ? WHERE key = ? AND opened_at = ?"
        : `UPDATE recorder_alert SET resolution_posted = 1
           WHERE key = ? AND opened_at = ? AND resolved_at IS NOT NULL`
    const args = a.kind === "open" ? [now.getTime(), a.key, a.openedAt] : [a.key, a.openedAt]
    this.#db.prepare(sql).run(...args)
  }
}
