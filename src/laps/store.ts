/**
 * Race-day lap counts, in the shared database. `champctl-laps` decides each
 * round's count and writes it to ACSM; the bot reads the outcome and posts it.
 * That split is the point: the bot holds no ACSM credentials, so these tables
 * are the only thing the two share. See docs/lap-count.md.
 */

import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { migrate, type Migration, restrictToOwner } from "../sqlite.js"

export const LAP_MIGRATIONS: Migration[] = [
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
  {
    // The counts go nullable for a round left alone, which has none; SQLite
    // can't relax NOT NULL in place, so the table is rebuilt.
    name: "laps: race-day counts, baselines and race minutes",
    up: (db) => {
      db.exec(`
        CREATE TABLE lap_proposal_v2 (
          id              INTEGER PRIMARY KEY,
          championship_id TEXT NOT NULL,
          event_id        TEXT NOT NULL,
          night           TEXT NOT NULL,
          cutoff          TEXT NOT NULL,
          minutes         INTEGER,
          laps            INTEGER,
          was_laps        INTEGER,
          best_ms         INTEGER,
          detail          TEXT,
          status          TEXT NOT NULL,
          outcome         TEXT,
          -- Who is writing it, and until when: a writer that dies lets go.
          holder          TEXT,
          lease_until     TEXT,
          channel_id      TEXT,
          message_id      TEXT,
          announced       TEXT,
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL,
          UNIQUE (championship_id, event_id, night),
          -- Fail closed: a row to write without a count is a bug, never a write.
          CHECK (status NOT IN ('approved', 'applying', 'applied') OR laps IS NOT NULL)
        ) STRICT;
        -- Nothing wrote v1 rows (it was never wired up); a pending or
        -- applying one would otherwise sit unclaimable and unexpirable.
        INSERT INTO lap_proposal_v2 (id, championship_id, event_id, night, cutoff, minutes, laps,
            was_laps, best_ms, detail, status, outcome, channel_id, message_id, announced,
            created_at, updated_at)
          SELECT id, championship_id, event_id, night, cutoff, minutes, laps, was_laps, best_ms,
            detail,
            CASE status WHEN 'pending' THEN 'expired' WHEN 'applying' THEN 'approved'
              ELSE status END,
            outcome, channel_id, message_id, announced, created_at, updated_at
          FROM lap_proposal;
        DROP TABLE lap_proposal;
        ALTER TABLE lap_proposal_v2 RENAME TO lap_proposal;

        -- A round's laps when champctl first saw it. A count that differs on
        -- race day was set by someone, and is left alone.
        CREATE TABLE lap_baseline (
          championship_id TEXT NOT NULL,
          event_id        TEXT NOT NULL,
          laps            INTEGER NOT NULL,
          seen_at         TEXT NOT NULL,
          PRIMARY KEY (championship_id, event_id)
        ) STRICT;

        CREATE TABLE lap_minutes (
          championship_id TEXT PRIMARY KEY,
          minutes         INTEGER NOT NULL,
          set_by          TEXT NOT NULL,
          set_at          TEXT NOT NULL
        ) STRICT;
      `)
    },
  },
]

export type ProposalStatus =
  /** To be written to the round. */
  | "approved"
  /** Being written, by `holder` until `leaseUntil`. */
  | "applying"
  | "applied"
  /** Left as it was: set by hand, timed, or a round champctl only saw today. */
  | "kept"
  /** No count could be worked out, such as a week with no clean practice laps. */
  | "none"
  /** Changed by hand while it was being written. */
  | "stale"
  | "failed"
  /** Not written before practice started. */
  | "expired"

/** How a row starts out: decided whole, in one insert. */
export type DecidedStatus = "approved" | "applied" | "kept" | "none"

const SETTLED = ["applied", "kept", "none", "stale", "failed", "expired"] as const

/** What the post says beyond the numbers it acts on. */
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
  status: DecidedStatus
  /** The count and what it came from; absent for a round left alone. */
  minutes?: number
  laps?: number
  /** The round's laps when it was decided. */
  wasLaps?: number
  bestMs?: number
  detail?: ProposalDetail
  outcome?: string
}

export interface LapProposal extends Omit<NewProposal, "status"> {
  id: number
  status: ProposalStatus
  holder?: string
  channelId?: string
  messageId?: string
}

interface Row {
  id: number
  championship_id: string
  event_id: string
  night: string
  cutoff: string
  minutes: number | null
  laps: number | null
  was_laps: number | null
  best_ms: number | null
  detail: string | null
  status: ProposalStatus
  outcome: string | null
  holder: string | null
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
    status: r.status,
    ...(r.minutes !== null ? { minutes: r.minutes } : {}),
    ...(r.laps !== null ? { laps: r.laps } : {}),
    ...(r.was_laps !== null ? { wasLaps: r.was_laps } : {}),
    ...(r.best_ms !== null ? { bestMs: r.best_ms } : {}),
    ...(r.detail !== null ? { detail: JSON.parse(r.detail) as ProposalDetail } : {}),
    ...(r.outcome !== null ? { outcome: r.outcome } : {}),
    ...(r.holder !== null ? { holder: r.holder } : {}),
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
    migrate(db, "laps", LAP_MIGRATIONS)
    if (path !== ":memory:") await restrictToOwner(path)
    return new SqliteLapProposals(db)
  }

  close(): void {
    this.#db.close()
  }

  /**
   * The round's row for that night, decided now unless one already was.
   * `inserted` says whether this call decided it, so only one caller logs it.
   */
  create(p: NewProposal, now: Date): { proposal: LapProposal; inserted: boolean } {
    const at = now.toISOString()
    const { changes } = this.#db
      .prepare(
        `INSERT INTO lap_proposal (championship_id, event_id, night, cutoff, minutes, laps,
           was_laps, best_ms, detail, status, outcome, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (championship_id, event_id, night) DO NOTHING`,
      )
      .run(
        p.championshipId,
        p.eventId,
        p.night,
        p.cutoff.toISOString(),
        p.minutes ?? null,
        p.laps ?? null,
        p.wasLaps ?? null,
        p.bestMs ?? null,
        p.detail ? JSON.stringify(p.detail) : null,
        p.status,
        p.outcome ?? null,
        at,
        at,
      )
    const row = this.#db
      .prepare(
        "SELECT * FROM lap_proposal WHERE championship_id = ? AND event_id = ? AND night = ?",
      )
      .get(p.championshipId, p.eventId, p.night) as unknown as Row
    return { proposal: fromRow(row), inserted: changes === 1 }
  }

  get(id: number): LapProposal | undefined {
    const row = this.#db.prepare("SELECT * FROM lap_proposal WHERE id = ?").get(id) as
      | Row
      | undefined
    return row ? fromRow(row) : undefined
  }

  /** The laps champctl last wrote to this round, on whatever night. */
  lastApplied(championshipId: string, eventId: string): number | undefined {
    const row = this.#db
      .prepare(
        `SELECT laps FROM lap_proposal
         WHERE championship_id = ? AND event_id = ? AND status = 'applied' AND laps IS NOT NULL
         ORDER BY updated_at DESC, id DESC LIMIT 1`,
      )
      .get(championshipId, eventId) as { laps: number } | undefined
    return row?.laps
  }

  /**
   * The oldest row to write, now `holder`'s until the lease runs out. A row
   * whose writer died is handed out again once its lease has: whoever takes it
   * reads the round to find out how far the last one got.
   *
   * The lease can run past the cutoff, and nothing here stops a save after it:
   * the writer checks the cutoff again just before saving, and keeps a save
   * well inside its lease.
   */
  claim(holder: string, now: Date, leaseMs: number): LapProposal | undefined {
    const at = now.toISOString()
    const row = this.#db
      .prepare(
        `UPDATE lap_proposal SET status = 'applying', holder = ?, lease_until = ?, updated_at = ?
         WHERE id = (SELECT id FROM lap_proposal
                     WHERE cutoff > ?
                       AND (status = 'approved' OR (status = 'applying' AND lease_until <= ?))
                     ORDER BY id LIMIT 1)
         RETURNING *`,
      )
      .get(holder, new Date(now.getTime() + leaseMs).toISOString(), at, at, at) as Row | undefined
    return row ? fromRow(row) : undefined
  }

  /** Records how writing went. Only for the holder of a row being written. */
  finish(
    id: number,
    holder: string,
    status: "applied" | "stale" | "failed",
    outcome: string,
    now: Date,
  ): boolean {
    return (
      this.#db
        .prepare(
          `UPDATE lap_proposal SET status = ?, outcome = ?, holder = NULL, lease_until = NULL,
             updated_at = ?
           WHERE id = ? AND status = 'applying' AND holder = ?`,
        )
        .run(status, outcome, now.toISOString(), id, holder).changes === 1
    )
  }

  /** Hands a row back unwritten, to be tried again. Only for its holder. */
  release(id: number, holder: string, now: Date): boolean {
    return (
      this.#db
        .prepare(
          `UPDATE lap_proposal SET status = 'approved', holder = NULL, lease_until = NULL,
             updated_at = ?
           WHERE id = ? AND status = 'applying' AND holder = ?`,
        )
        .run(now.toISOString(), id, holder).changes === 1
    )
  }

  /**
   * Closes what wasn't written before practice, so the bot can say so. A row
   * still within its lease is left to its writer, which may be mid-save.
   */
  expire(now: Date): void {
    const at = now.toISOString()
    this.#db
      .prepare(
        `UPDATE lap_proposal SET status = 'expired', holder = NULL, lease_until = NULL,
           updated_at = ?
         WHERE cutoff <= ?
           AND (status = 'approved' OR (status = 'applying' AND lease_until <= ?))`,
      )
      .run(at, at, at)
  }

  setMessage(id: number, channelId: string, messageId: string): void {
    this.#db
      .prepare("UPDATE lap_proposal SET channel_id = ?, message_id = ? WHERE id = ?")
      .run(channelId, messageId, id)
  }

  /** Settled rows the bot hasn't posted about. */
  unannounced(): LapProposal[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM lap_proposal
         WHERE status IN (${SETTLED.map(() => "?").join(", ")})
           AND (announced IS NULL OR announced != status)
         ORDER BY id`,
      )
      .all(...SETTLED) as unknown as Row[]
    return rows.map(fromRow)
  }

  announced(id: number, status: ProposalStatus): void {
    this.#db.prepare("UPDATE lap_proposal SET announced = ? WHERE id = ?").run(status, id)
  }

  /** Records a round's laps the first time it's seen; true if this was that time. */
  recordBaseline(championshipId: string, eventId: string, laps: number, now: Date): boolean {
    return (
      this.#db
        .prepare(
          `INSERT INTO lap_baseline (championship_id, event_id, laps, seen_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (championship_id, event_id) DO NOTHING`,
        )
        .run(championshipId, eventId, laps, now.toISOString()).changes === 1
    )
  }

  baseline(championshipId: string, eventId: string): { laps: number; seenAt: Date } | undefined {
    const row = this.#db
      .prepare("SELECT laps, seen_at FROM lap_baseline WHERE championship_id = ? AND event_id = ?")
      .get(championshipId, eventId) as { laps: number; seen_at: string } | undefined
    return row ? { laps: row.laps, seenAt: new Date(row.seen_at) } : undefined
  }

  /** A championship's own race minutes, or undefined to clear them. */
  setRaceMinutes(championshipId: string, minutes: number | undefined, by: string, now: Date): void {
    if (minutes === undefined) {
      this.#db.prepare("DELETE FROM lap_minutes WHERE championship_id = ?").run(championshipId)
      return
    }
    this.#db
      .prepare(
        `INSERT INTO lap_minutes (championship_id, minutes, set_by, set_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (championship_id) DO UPDATE
           SET minutes = excluded.minutes, set_by = excluded.set_by, set_at = excluded.set_at`,
      )
      .run(championshipId, minutes, by, now.toISOString())
  }

  /** The championship's own race minutes; undefined means the profile's. */
  raceMinutes(championshipId: string): number | undefined {
    const row = this.#db
      .prepare("SELECT minutes FROM lap_minutes WHERE championship_id = ?")
      .get(championshipId) as { minutes: number } | undefined
    return row?.minutes
  }
}
