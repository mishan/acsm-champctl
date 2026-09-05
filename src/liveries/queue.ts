/**
 * Liveries drivers have sent, waiting to be applied
 * (docs/discord-livery-upload.md §5).
 *
 * This table is the wall in the middle of the feature. The process that accepts
 * bytes from a stranger holds a Discord token and no ACSM credentials; the
 * process that writes to the game server holds ACSM credentials and no Discord
 * token. They share this and nothing else, which is what lets plan §7's "the
 * bot never holds write credentials" stay literally true while a driver's
 * upload still reaches the server without a human in the middle.
 *
 * **Bytes are stored as received.** Not as the validated file list: re-running
 * `readSingleLivery` at apply time means the thing applied went through the
 * checks twice with the same input, rather than trusting an unpacking the bot
 * did an hour earlier and stored in pieces. The store in `store.ts` keeps the
 * validated files, and that is a different job — this is a queue and that is a
 * record.
 *
 * **Supersede rather than accumulate.** A driver who uploads twice before a
 * drain should end up with one queued row. The skin folder is their name either
 * way, so both were always going to land on the same folder on the server —
 * queuing both means uploading the dead one first and then overwriting it,
 * which is right by luck.
 *
 * **Nothing here is deleted on apply, only emptied.** The row stays as an audit
 * line with its bytes dropped, because "who uploaded the thing that broke
 * Suzuka" currently has an answer only because a human received the file, and
 * it should keep having one.
 */

import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { restrictToOwner } from "../sqlite.js"

export type SubmissionState = "queued" | "applied" | "refused" | "superseded"

export interface Submission {
  id: number
  discordUserId: string
  /** Handle at submission time. Display only; the id is the identity. */
  discordHandle?: string
  championshipId: string
  driverName: string
  carModel: string
  skinFolder: string
  bytes: number
  state: SubmissionState
  submittedAt: string
  settledAt?: string
  /** Why it was refused, for the operator reading the audit trail. */
  reason?: string
}

export interface QueuedSubmission extends Submission {
  state: "queued"
  /** The zip exactly as the driver sent it. */
  body: Uint8Array
}

export interface SubmitInput {
  discordUserId: string
  discordHandle?: string
  championshipId: string
  driverName: string
  carModel: string
  skinFolder: string
  body: Uint8Array
  at: Date
}

export interface SubmitResult {
  submission: Submission
  /** The submission this one replaced, if the driver had one waiting. */
  superseded?: Submission
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS livery_submission (
  id               INTEGER PRIMARY KEY,
  discord_user_id  TEXT NOT NULL,
  discord_handle   TEXT,
  championship_id  TEXT NOT NULL,
  driver_name      TEXT NOT NULL,
  car_model        TEXT NOT NULL,
  skin_folder      TEXT NOT NULL,
  bytes            INTEGER NOT NULL,
  state            TEXT NOT NULL,
  submitted_at     TEXT NOT NULL,
  settled_at       TEXT,
  reason           TEXT,
  body             BLOB
) STRICT;

-- Drains read by championship and state, and the cooldown reads by user and
-- time. Both are the whole access pattern; nothing here scans.
CREATE INDEX IF NOT EXISTS livery_submission_pending
  ON livery_submission (championship_id, state, id);
CREATE INDEX IF NOT EXISTS livery_submission_by_user
  ON livery_submission (discord_user_id, submitted_at);
`

interface Row {
  id: number
  discord_user_id: string
  discord_handle: string | null
  championship_id: string
  driver_name: string
  car_model: string
  skin_folder: string
  bytes: number
  state: string
  submitted_at: string
  settled_at: string | null
  reason: string | null
  body: Uint8Array | null
}

function stateOf(value: string): SubmissionState {
  return value === "queued" || value === "applied" || value === "refused" || value === "superseded"
    ? value
    : "refused"
}

function toSubmission(row: Row): Submission {
  return {
    id: row.id,
    discordUserId: row.discord_user_id,
    ...(row.discord_handle ? { discordHandle: row.discord_handle } : {}),
    championshipId: row.championship_id,
    driverName: row.driver_name,
    carModel: row.car_model,
    skinFolder: row.skin_folder,
    bytes: row.bytes,
    state: stateOf(row.state),
    submittedAt: row.submitted_at,
    ...(row.settled_at ? { settledAt: row.settled_at } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
  }
}

export interface OpenOptions {
  busyTimeoutMs?: number
}

export class SqliteSubmissionQueue {
  readonly #db: DatabaseSync

  private constructor(db: DatabaseSync) {
    this.#db = db
  }

  static async open(path: string, options: OpenOptions = {}): Promise<SqliteSubmissionQueue> {
    if (path !== ":memory:") await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(path)
    db.exec("PRAGMA journal_mode = WAL")
    db.exec(`PRAGMA busy_timeout = ${Number(options.busyTimeoutMs ?? 5000)}`)
    db.exec(SCHEMA)
    if (path !== ":memory:") await restrictToOwner(path)
    return new SqliteSubmissionQueue(db)
  }

  /**
   * Accepts a validated livery.
   *
   * Supersede and insert in one transaction: two uploads from one driver
   * arriving together is exactly the case superseding exists for, so it cannot
   * be the case that slips between the update and the insert.
   */
  async submit(input: SubmitInput): Promise<SubmitResult> {
    const when = input.at.toISOString()

    this.#db.exec("BEGIN IMMEDIATE")
    try {
      const previous = this.#db
        .prepare(
          `SELECT * FROM livery_submission
           WHERE championship_id = ? AND car_model = ? AND driver_name = ? AND state = 'queued'
           ORDER BY id DESC LIMIT 1`,
        )
        .get(input.championshipId, input.carModel, input.driverName) as unknown as Row | undefined

      if (previous) {
        // Bytes dropped with the state. A superseded submission has no reader:
        // the newer one is going to land on the same skin folder, and keeping
        // the dead artwork is disk the league did not ask to spend.
        this.#db
          .prepare(
            `UPDATE livery_submission SET state = 'superseded', settled_at = ?, body = NULL,
             reason = 'replaced by a later upload from the same driver' WHERE id = ?`,
          )
          .run(when, previous.id)
      }

      const inserted = this.#db
        .prepare(
          `INSERT INTO livery_submission (
             discord_user_id, discord_handle, championship_id, driver_name, car_model,
             skin_folder, bytes, state, submitted_at, body
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        )
        .run(
          input.discordUserId,
          input.discordHandle ?? null,
          input.championshipId,
          input.driverName,
          input.carModel,
          input.skinFolder,
          input.body.length,
          when,
          Buffer.from(input.body),
        )
      this.#db.exec("COMMIT")

      const submission = this.#read(Number(inserted.lastInsertRowid))
      const superseded = previous ? toSubmission(previous) : undefined
      return superseded ? { submission, superseded } : { submission }
    } catch (e) {
      this.#db.exec("ROLLBACK")
      throw e
    }
  }

  /** Everything waiting for a championship, oldest first, with the bytes. */
  async queued(championshipId: string): Promise<QueuedSubmission[]> {
    const rows = this.#db
      .prepare(
        `SELECT * FROM livery_submission WHERE championship_id = ? AND state = 'queued'
         ORDER BY id`,
      )
      .all(championshipId) as unknown as Row[]
    return rows.map((row) => ({
      ...toSubmission(row),
      state: "queued" as const,
      body: new Uint8Array(row.body ?? new Uint8Array()),
    }))
  }

  /**
   * Marks submissions applied and drops their bytes.
   *
   * The row survives as an audit line. `store.ts` holds the artwork now, and
   * two copies of the same files is one copy too many.
   */
  async markApplied(ids: readonly number[], at: Date): Promise<number> {
    if (ids.length === 0) return 0
    const when = at.toISOString()
    const statement = this.#db.prepare(
      `UPDATE livery_submission SET state = 'applied', settled_at = ?, body = NULL
       WHERE id = ? AND state = 'queued'`,
    )
    let changed = 0
    this.#db.exec("BEGIN IMMEDIATE")
    try {
      for (const id of ids) changed += Number(statement.run(when, id).changes)
      this.#db.exec("COMMIT")
    } catch (e) {
      this.#db.exec("ROLLBACK")
      throw e
    }
    return changed
  }

  /**
   * Marks one submission refused, with the sentence the driver was given.
   *
   * Kept rather than deleted because a refusal is the more interesting half of
   * the audit trail: four drivers fighting the extension allowlist on a Tuesday
   * is the signal that the documentation is wrong, and it is invisible if every
   * refusal is thrown away.
   */
  async markRefused(id: number, reason: string, at: Date): Promise<void> {
    this.#db
      .prepare(
        `UPDATE livery_submission SET state = 'refused', settled_at = ?, reason = ?, body = NULL
         WHERE id = ?`,
      )
      .run(at.toISOString(), reason, id)
  }

  /**
   * When this driver last had a submission accepted.
   *
   * Only accepted ones, which is the point: a driver iterating on a zip that
   * keeps being rejected is doing exactly what the refusals are for, and a
   * cooldown that counted those would punish them for reading the error
   * message.
   */
  async lastAcceptedAt(discordUserId: string): Promise<Date | undefined> {
    const row = this.#db
      .prepare(
        `SELECT submitted_at FROM livery_submission
         WHERE discord_user_id = ? AND state <> 'refused'
         ORDER BY submitted_at DESC LIMIT 1`,
      )
      .get(discordUserId) as unknown as { submitted_at: string } | undefined
    return row ? new Date(row.submitted_at) : undefined
  }

  /**
   * Bytes currently held in the queue, across every championship.
   *
   * `maxTotalBytes` in `pack.ts` caps one submission. Nothing caps a hundred of
   * them, and the queue is the only place that can.
   */
  async queuedBytes(): Promise<number> {
    const row = this.#db
      .prepare("SELECT coalesce(sum(bytes), 0) AS n FROM livery_submission WHERE state = 'queued'")
      .get() as unknown as { n: number }
    return row.n
  }

  /** The audit trail, newest first. */
  async history(championshipId: string, limit = 50): Promise<Submission[]> {
    const rows = this.#db
      .prepare("SELECT * FROM livery_submission WHERE championship_id = ? ORDER BY id DESC LIMIT ?")
      .all(championshipId, limit) as unknown as Row[]
    return rows.map(toSubmission)
  }

  #read(id: number): Submission {
    const row = this.#db
      .prepare("SELECT * FROM livery_submission WHERE id = ?")
      .get(id) as unknown as Row
    return toSubmission(row)
  }

  close(): void {
    this.#db.close()
  }
}
