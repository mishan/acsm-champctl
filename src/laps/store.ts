/**
 * Lap count proposals, in the shared database: the bot writes them and records
 * approvals, the drain claims and applies them. That split is the point — the
 * bot holds no ACSM credentials, so an approval has to travel to a process that
 * does, and this table is the only thing the two share.
 */

import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { migrate, type Migration, restrictToOwner } from "../sqlite.js"

const MIGRATIONS: Migration[] = [
  {
    name: "laps: initial schema",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS lap_proposal (
          id              INTEGER PRIMARY KEY,
          championship_id TEXT NOT NULL,
          event_id        TEXT NOT NULL,
          -- The round's race day, league-local. Part of the key so a round moved
          -- to another night is proposed again; the old night's row keeps its
          -- cutoff, so the applier checks the live round, not this.
          night           TEXT NOT NULL,
          -- The round's practice start: past it, ACSM has loaded the sessions
          -- and a new lap count waits for next time.
          cutoff          TEXT NOT NULL,
          minutes         INTEGER NOT NULL,
          laps            INTEGER NOT NULL,
          -- The round's laps when proposed. The applier refuses if they have
          -- changed since: someone set them by hand.
          was_laps        INTEGER NOT NULL,
          best_ms         INTEGER NOT NULL,
          detail          TEXT NOT NULL,
          status          TEXT NOT NULL,
          outcome         TEXT,
          approved_by     TEXT,
          channel_id      TEXT,
          message_id      TEXT,
          -- The status the channel last heard about. A change of minutes keeps
          -- the status, so whoever makes one edits the message there and then.
          announced       TEXT,
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL,
          UNIQUE (championship_id, event_id, night)
        ) STRICT;
      `)
    },
  },
]

export type ProposalStatus =
  | "pending"
  | "approved"
  | "applying"
  | "applied"
  | "stale"
  | "failed"
  /** Not applied before practice started. */
  | "expired"

/** What the proposal message says beyond the numbers it acts on. */
export interface ProposalDetail {
  driver: string
  sessions: number
  validLaps: number
  drivers: number
}

export interface NewProposal {
  championshipId: string
  eventId: string
  night: string
  /** Stored as UTC ISO text, the only form whose text order is time order. */
  cutoff: Date
  minutes: number
  laps: number
  wasLaps: number
  bestMs: number
  detail: ProposalDetail
}

export interface LapProposal extends NewProposal {
  id: number
  status: ProposalStatus
  outcome?: string
  approvedBy?: string
  channelId?: string
  messageId?: string
}

interface Row {
  id: number
  championship_id: string
  event_id: string
  night: string
  cutoff: string
  minutes: number
  laps: number
  was_laps: number
  best_ms: number
  detail: string
  status: ProposalStatus
  outcome: string | null
  approved_by: string | null
  channel_id: string | null
  message_id: string | null
}

function fromRow(r: Row): LapProposal {
  return {
    id: r.id,
    championshipId: r.championship_id,
    eventId: r.event_id,
    night: r.night,
    cutoff: new Date(r.cutoff),
    minutes: r.minutes,
    laps: r.laps,
    wasLaps: r.was_laps,
    bestMs: r.best_ms,
    detail: JSON.parse(r.detail) as ProposalDetail,
    status: r.status,
    ...(r.outcome !== null ? { outcome: r.outcome } : {}),
    ...(r.approved_by !== null ? { approvedBy: r.approved_by } : {}),
    ...(r.channel_id !== null ? { channelId: r.channel_id } : {}),
    ...(r.message_id !== null ? { messageId: r.message_id } : {}),
  }
}

export class SqliteLapProposals {
  readonly #db: DatabaseSync

  private constructor(db: DatabaseSync) {
    this.#db = db
  }

  static async open(path: string): Promise<SqliteLapProposals> {
    if (path !== ":memory:") await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(path)
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA busy_timeout = 5000")
    migrate(db, "laps", MIGRATIONS)
    if (path !== ":memory:") await restrictToOwner(path)
    return new SqliteLapProposals(db)
  }

  close(): void {
    this.#db.close()
  }

  /**
   * The round's proposal for that night, made now unless one already was.
   * Returned either way: one made by a run that died before posting it has no
   * `messageId`, and the next run posts it.
   */
  create(p: NewProposal, now: Date): LapProposal {
    const at = now.toISOString()
    this.#db
      .prepare(
        `INSERT INTO lap_proposal (championship_id, event_id, night, cutoff, minutes, laps,
           was_laps, best_ms, detail, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
         ON CONFLICT (championship_id, event_id, night) DO NOTHING`,
      )
      .run(
        p.championshipId,
        p.eventId,
        p.night,
        p.cutoff.toISOString(),
        p.minutes,
        p.laps,
        p.wasLaps,
        p.bestMs,
        JSON.stringify(p.detail),
        at,
        at,
      )
    const row = this.#db
      .prepare(
        "SELECT * FROM lap_proposal WHERE championship_id = ? AND event_id = ? AND night = ?",
      )
      .get(p.championshipId, p.eventId, p.night) as unknown as Row
    return fromRow(row)
  }

  get(id: number): LapProposal | undefined {
    const row = this.#db.prepare("SELECT * FROM lap_proposal WHERE id = ?").get(id) as
      | Row
      | undefined
    return row ? fromRow(row) : undefined
  }

  setMessage(id: number, channelId: string, messageId: string): void {
    this.#db
      .prepare("UPDATE lap_proposal SET channel_id = ?, message_id = ? WHERE id = ?")
      .run(channelId, messageId, id)
  }

  /** New minutes and the laps they make. Only while pending: after that, someone approved a number. */
  setMinutes(id: number, minutes: number, laps: number, now: Date): boolean {
    return (
      this.#db
        .prepare(
          `UPDATE lap_proposal SET minutes = ?, laps = ?, updated_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(minutes, laps, now.toISOString(), id).changes === 1
    )
  }

  /**
   * Approves the proposal if it still says `laps` and practice hasn't
   * started. The lap count comes from the button, so a click on a message
   * someone has since recomputed approves nothing rather than a number its
   * presser never saw.
   */
  approve(id: number, laps: number, by: string, now: Date): boolean {
    return (
      this.#db
        .prepare(
          `UPDATE lap_proposal SET status = 'approved', approved_by = ?, updated_at = ?
           WHERE id = ? AND status = 'pending' AND laps = ? AND cutoff > ?`,
        )
        .run(by, now.toISOString(), id, laps, now.toISOString()).changes === 1
    )
  }

  /**
   * Closes what wasn't applied before practice started, approved or not, so
   * its message can say so.
   */
  expire(now: Date): void {
    this.#db
      .prepare(
        `UPDATE lap_proposal SET status = 'expired', updated_at = ?
         WHERE status IN ('pending', 'approved') AND cutoff <= ?`,
      )
      .run(now.toISOString(), now.toISOString())
  }

  /**
   * The oldest approval, now this caller's to apply. A caller that dies
   * holding one leaves it `applying`; the applier has to reclaim those, and
   * read a round already at `laps` as applied rather than changed by hand.
   */
  claim(now: Date): LapProposal | undefined {
    const row = this.#db
      .prepare(
        `UPDATE lap_proposal SET status = 'applying', updated_at = ?
         WHERE id = (SELECT id FROM lap_proposal
                     WHERE status = 'approved' AND cutoff > ? ORDER BY id LIMIT 1)
         RETURNING *`,
      )
      .get(now.toISOString(), now.toISOString()) as Row | undefined
    return row ? fromRow(row) : undefined
  }

  /** Records how applying went. Only for a row this caller claimed. */
  finish(id: number, status: "applied" | "stale" | "failed", outcome: string, now: Date): boolean {
    return (
      this.#db
        .prepare(
          `UPDATE lap_proposal SET status = ?, outcome = ?, updated_at = ?
           WHERE id = ? AND status = 'applying'`,
        )
        .run(status, outcome, now.toISOString(), id).changes === 1
    )
  }

  /** Posted proposals whose status the channel hasn't been told. */
  unannounced(): LapProposal[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM lap_proposal
         WHERE message_id IS NOT NULL AND (announced IS NULL OR announced != status)
         ORDER BY id`,
      )
      .all() as unknown as Row[]
    return rows.map(fromRow)
  }

  announced(id: number, status: ProposalStatus): void {
    this.#db.prepare("UPDATE lap_proposal SET announced = ? WHERE id = ?").run(status, id)
  }
}
