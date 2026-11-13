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

import { migrate, type Migration, openForReading, restrictToOwner } from "../sqlite.js"

export const INCIDENT_MIGRATIONS: Migration[] = [
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
  {
    name: "incidents: the vote",
    up: (db) => {
      db.exec(`
        ALTER TABLE incidents ADD COLUMN poll_message_id TEXT;
        ALTER TABLE incidents ADD COLUMN poll_ends_at TEXT;
        ALTER TABLE incidents ADD COLUMN poll_settled INTEGER NOT NULL DEFAULT 0;
      `)
    },
  },
]

/**
 * A component of their own, so the version an older champctl checks for
 * `incidents` doesn't move: rolling back leaves this table unread, not the
 * database refused.
 */
const DRAFT_MIGRATIONS: Migration[] = [
  {
    name: "incident drafts: initial schema",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS incident_drafts (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          made_at           TEXT NOT NULL,
          reporter_discord  TEXT NOT NULL,
          reporter          TEXT NOT NULL,
          other             TEXT NOT NULL,
          journal           TEXT NOT NULL,
          at_ms             INTEGER NOT NULL,
          collision_index   INTEGER,
          description       TEXT NOT NULL,
          channel_id        TEXT UNIQUE,
          number            INTEGER
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

/** A report only its reporter has seen, until they open it as an incident or withdraw it. */
export interface Draft extends Omit<IncidentFiling, "otherDiscord"> {
  id: number
  madeAt: string
  channelId?: string
  /** The incident it's being opened as, once opening has begun. */
  number?: number
}

export interface Incident extends IncidentFiling {
  number: number
  filedAt: string
  channelId?: string
  decision?: string
  decidedBy?: string
  decidedAt?: string
  /** The Racers' vote on who was at fault, and when it closes. */
  pollMessageId?: string
  pollEndsAt?: string
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
  poll_message_id: string | null
  poll_ends_at: string | null
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
  ...(r.poll_message_id ? { pollMessageId: r.poll_message_id } : {}),
  ...(r.poll_ends_at ? { pollEndsAt: r.poll_ends_at } : {}),
})

interface DraftRow {
  id: number
  made_at: string
  reporter_discord: string
  reporter: string
  other: string
  journal: string
  at_ms: number
  collision_index: number | null
  description: string
  channel_id: string | null
  number: number | null
}

const fromDraftRow = (r: DraftRow): Draft => ({
  id: r.id,
  madeAt: r.made_at,
  reporterDiscord: r.reporter_discord,
  reporter: r.reporter,
  other: r.other,
  journal: r.journal,
  atMs: r.at_ms,
  ...(r.collision_index === null ? {} : { collisionIndex: r.collision_index }),
  description: r.description,
  ...(r.channel_id ? { channelId: r.channel_id } : {}),
  ...(r.number === null ? {} : { number: r.number }),
})

export class SqliteIncidentStore {
  readonly #db: DatabaseSync

  private constructor(db: DatabaseSync) {
    this.#db = db
  }

  /** For reading alongside the process that writes it: see `openForReading`. */
  static openForReading(path: string): SqliteIncidentStore {
    return new SqliteIncidentStore(openForReading(path, "incidents", INCIDENT_MIGRATIONS))
  }

  static async open(path: string): Promise<SqliteIncidentStore> {
    if (path !== ":memory:") await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(path)
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA busy_timeout = 5000")
    migrate(db, "incidents", INCIDENT_MIGRATIONS)
    migrate(db, "incident drafts", DRAFT_MIGRATIONS)
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

  setPoll(number: number, messageId: string, endsAt: Date): void {
    this.#db
      .prepare("UPDATE incidents SET poll_message_id = ?, poll_ends_at = ? WHERE number = ?")
      .run(messageId, endsAt.toISOString(), number)
  }

  /** Votes that have closed on incidents nobody has decided, and that haven't been counted. */
  pollsDue(now: Date): Incident[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM incidents WHERE poll_message_id IS NOT NULL AND decision IS NULL
           AND poll_settled = 0 AND poll_ends_at <= ? ORDER BY number`,
      )
      .all(now.toISOString()) as unknown as Row[]
    return rows.map(fromRow)
  }

  /** Counted: a decision, or a tie handed to the stewards. Either way, not counted again. */
  settlePoll(number: number): void {
    this.#db.prepare("UPDATE incidents SET poll_settled = 1 WHERE number = ?").run(number)
  }

  /** Reports that got a channel, newest first; with `open`, only those not yet decided. */
  list(o: { open?: boolean } = {}): Incident[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM incidents WHERE channel_id IS NOT NULL ${o.open ? "AND decision IS NULL" : ""}
         ORDER BY number DESC`,
      )
      .all() as unknown as Row[]
    return rows.map(fromRow)
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

  /** A driver's drafts, and the reports they filed that got a channel and haven't been decided. */
  openCount(reporterDiscord: string): number {
    const r = this.#db
      .prepare(
        `SELECT (SELECT count(*) FROM incidents WHERE reporter_discord = ? AND decision IS NULL
           AND channel_id IS NOT NULL) + (SELECT count(*) FROM incident_drafts WHERE reporter_discord = ?) AS n`,
      )
      .get(reporterDiscord, reporterDiscord) as { n: number }
    return r.n
  }

  draft(f: Omit<IncidentFiling, "otherDiscord">, at: Date): Draft {
    const r = this.#db
      .prepare(
        `INSERT INTO incident_drafts (made_at, reporter_discord, reporter, other, journal, at_ms,
           collision_index, description)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        at.toISOString(),
        f.reporterDiscord,
        f.reporter,
        f.other,
        f.journal,
        Math.round(f.atMs),
        f.collisionIndex ?? null,
        f.description,
      ) as unknown as DraftRow
    return fromDraftRow(r)
  }

  setDraftChannel(id: number, channelId: string): void {
    this.#db.prepare("UPDATE incident_drafts SET channel_id = ? WHERE id = ?").run(channelId, id)
  }

  draftById(id: number): Draft | undefined {
    const r = this.#db.prepare("SELECT * FROM incident_drafts WHERE id = ?").get(id) as
      | DraftRow
      | undefined
    return r && fromDraftRow(r)
  }

  /** A driver's draft of this moment, as `existing` finds a report of it. */
  draftOf(reporterDiscord: string, journal: string, atMs: number): Draft | undefined {
    const r = this.#db
      .prepare(
        `SELECT * FROM incident_drafts WHERE reporter_discord = ? AND journal = ?
         AND abs(at_ms - ?) < 5000 ORDER BY id LIMIT 1`,
      )
      .get(reporterDiscord, journal, Math.round(atMs)) as DraftRow | undefined
    return r && fromDraftRow(r)
  }

  /**
   * Drafts made before `before`. One with a number was being opened when
   * something stopped it, and its channel may already be public: it's to be
   * opened, not withdrawn.
   */
  staleDrafts(before: Date): Draft[] {
    const rows = this.#db
      .prepare("SELECT * FROM incident_drafts WHERE made_at < ? ORDER BY id")
      .all(before.toISOString()) as unknown as DraftRow[]
    return rows.map(fromDraftRow)
  }

  /**
   * The incident a draft is being opened as: numbered on the first try, and
   * the same number on every retry, so a channel opened before a crash isn't
   * filed twice. The other driver's claim is as it is now.
   */
  reserve(id: number, otherDiscord: string | undefined, at: Date): Incident | undefined {
    return this.#transaction(() => {
      const d = this.draftById(id)
      if (!d) return undefined
      if (d.number !== undefined) {
        this.#db
          .prepare("UPDATE incidents SET other_discord = ? WHERE number = ?")
          .run(otherDiscord ?? null, d.number)
        const r = this.#db.prepare("SELECT * FROM incidents WHERE number = ?").get(d.number)
        if (!r)
          throw new Error(`Draft ${id} was being opened as incident #${d.number}, which is gone.`)
        return fromRow(r as unknown as Row)
      }
      const { id: _, madeAt: __, channelId: ___, ...filing } = d
      const incident = this.file({ ...filing, ...(otherDiscord ? { otherDiscord } : {}) }, at)
      this.#db
        .prepare("UPDATE incident_drafts SET number = ? WHERE id = ?")
        .run(incident.number, id)
      return incident
    })
  }

  /** The draft's channel is its incident's now, and the draft is gone; false if it wasn't reserved. */
  opened(id: number): boolean {
    return this.#transaction(() => {
      const d = this.draftById(id)
      if (d?.number === undefined || !d.channelId) return false
      this.#db.prepare("DELETE FROM incident_drafts WHERE id = ?").run(id)
      this.setChannel(d.number, d.channelId)
      return true
    })
  }

  /** False for a draft being opened: its number is taken, and its channel may be public. */
  withdraw(id: number): boolean {
    return (
      this.#db.prepare("DELETE FROM incident_drafts WHERE id = ? AND number IS NULL").run(id)
        .changes > 0
    )
  }

  #transaction<T>(f: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE")
    try {
      const out = f()
      this.#db.exec("COMMIT")
      return out
    } catch (e) {
      this.#db.exec("ROLLBACK")
      throw e
    }
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
