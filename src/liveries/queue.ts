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
import { migrate, type Migration, restrictToOwner } from "../sqlite.js"

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

const MIGRATIONS: Migration[] = [
  {
    name: "queue: initial schema",
    up: (db) => {
      db.exec(`
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

        -- When a drain last ran, per championship.
        --
        -- This exists so the bot can stop making a promise nobody kept. autoApply in
        -- the profile is a claim about a *different* process: the timer lives in
        -- champctl-liveries, which holds the credentials, and the bot only changes its
        -- wording to match. An operator who sets the flag and never starts the watcher
        -- would otherwise have every driver told "it'll go on shortly" for ever, with
        -- nothing anywhere reporting that nothing is applying anything.
        CREATE TABLE IF NOT EXISTS drain_run (
          championship_id  TEXT PRIMARY KEY,
          ran_at           TEXT NOT NULL
        ) STRICT;

        -- Which process is draining this championship right now.
        --
        -- One at a time, per championship, whatever the trigger. Batching every
        -- submission into one pack stops a drain overwriting *itself*; it does nothing
        -- about the watcher and an impatient operator running at the same time, and
        -- saveChampionshipSkins is GET the form, mutate, POST the whole form. Two of
        -- those overlapping means the later POST replays an entry list read before the
        -- earlier one landed, and the earlier drain's skins are gone with nothing
        -- reporting it. RosterChangedError cannot see it: it compares names, and a skin
        -- write does not change a name.
        --
        -- In the database rather than in memory, because the two processes racing are
        -- two processes. The lease expires so that a drain killed mid-run does not lock
        -- the championship out for ever, and is renewed while one is running so that a
        -- slow upload does not hand the lease to somebody else halfway through.
        CREATE TABLE IF NOT EXISTS drain_lease (
          championship_id  TEXT PRIMARY KEY,
          holder           TEXT NOT NULL,
          acquired_at      TEXT NOT NULL,
          expires_at       TEXT NOT NULL
        ) STRICT;
      `)
    },
  },
  {
    name: "queue: constrain the queued invariants, and index the budget",
    up: (db) => {
      db.exec(`
        -- One queued submission per driver and car, expressed where it cannot
        -- be forgotten. Superseding is a read-then-write, correct today only
        -- because every writer goes through submit() under BEGIN IMMEDIATE —
        -- and it supersedes exactly one prior row, so anything that ever did
        -- break the rule would leave dead artwork queued in front of the live
        -- one, permanently.
        CREATE UNIQUE INDEX IF NOT EXISTS livery_submission_one_queued
          ON livery_submission (championship_id, car_model, driver_name)
          WHERE state = 'queued';

        -- queuedBytes() runs on every upload and had to scan a table that never
        -- sheds rows: settled submissions stay for ever as the audit trail.
        CREATE INDEX IF NOT EXISTS livery_submission_queued
          ON livery_submission (state) WHERE state = 'queued';
      `)
    },
  },
]

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

/**
 * Every column except the zip.
 *
 * Named rather than `SELECT *` wherever only the metadata is wanted: a queued
 * row carries the driver's whole submission, so a query that reads a hundred
 * rows to print an audit line reads a hundred zips with them.
 */
const ROW_COLUMNS = `id, discord_user_id, discord_handle, championship_id, driver_name,
  car_model, skin_folder, bytes, state, submitted_at, settled_at, reason`

function stateOf(value: string): SubmissionState {
  return value === "queued" || value === "applied" || value === "refused" || value === "superseded"
    ? value
    : "refused"
}

function toSubmission(row: Omit<Row, "body">): Submission {
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

/** The outcome of asking for the drain lease. */
export type DrainLease = { ok: true; holder: string } | { ok: false; heldBy: string; until: string }

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
    migrate(db, "queue", MIGRATIONS)
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
      // Every column but the body. `SELECT *` here read the previous
      // submission's whole zip out of SQLite to use one integer off it, on the
      // most reachable path in the feature and while the new zip is already in
      // memory — a driver re-sending a 90 MB livery paid for it twice.
      const previous = this.#db
        .prepare(
          `SELECT ${ROW_COLUMNS} FROM livery_submission
           WHERE championship_id = ? AND car_model = ? AND driver_name = ? AND state = 'queued'
           ORDER BY id DESC LIMIT 1`,
        )
        .get(input.championshipId, input.carModel, input.driverName) as unknown as
        | Omit<Row, "body">
        | undefined

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
    // Guarded on `queued` the way `markApplied` is. Without it a drain that lost
    // a race can rewrite a row the winner already applied, and the audit trail
    // then records a refusal for artwork that is sitting on the server.
    this.#db
      .prepare(
        `UPDATE livery_submission SET state = 'refused', settled_at = ?, reason = ?, body = NULL
         WHERE id = ? AND state = 'queued'`,
      )
      .run(at.toISOString(), reason, id)
  }

  /**
   * Takes the drain lease for a championship, if nobody else holds it.
   *
   * `BEGIN IMMEDIATE` around the read and the write, so two drains starting in
   * the same millisecond cannot both find it free. An expired lease is taken
   * over rather than waited for — the holder is gone, and a championship that
   * could never be drained again after one `kill -9` would be worse than the
   * race this prevents.
   */
  async acquireDrainLease(
    championshipId: string,
    holder: string,
    at: Date,
    ttlMs: number,
  ): Promise<DrainLease> {
    const now = at.toISOString()
    const expires = new Date(at.getTime() + ttlMs).toISOString()
    this.#db.exec("BEGIN IMMEDIATE")
    try {
      const held = this.#db
        .prepare(`SELECT holder, expires_at FROM drain_lease WHERE championship_id = ?`)
        .get(championshipId) as { holder: string; expires_at: string } | undefined

      // String comparison, and that is safe: both sides are `Date.toISOString`,
      // which is fixed-width UTC. Parsing them back would only add a way to be
      // wrong about a timezone.
      if (held && held.expires_at > now && held.holder !== holder) {
        this.#db.exec("COMMIT")
        return { ok: false, heldBy: held.holder, until: held.expires_at }
      }

      this.#db
        .prepare(
          `INSERT INTO drain_lease (championship_id, holder, acquired_at, expires_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(championship_id) DO UPDATE SET
             holder = excluded.holder,
             acquired_at = excluded.acquired_at,
             expires_at = excluded.expires_at`,
        )
        .run(championshipId, holder, now, expires)
      this.#db.exec("COMMIT")
    } catch (e) {
      this.#db.exec("ROLLBACK")
      throw e
    }
    return { ok: true, holder }
  }

  /**
   * Pushes the lease's expiry out while a drain is still running.
   *
   * Guarded on the holder: a drain whose lease expired and was taken over by
   * somebody else must not quietly take it back mid-upload. `false` here means
   * this process no longer owns the championship.
   */
  async renewDrainLease(
    championshipId: string,
    holder: string,
    at: Date,
    ttlMs: number,
  ): Promise<boolean> {
    const changed = this.#db
      .prepare(`UPDATE drain_lease SET expires_at = ? WHERE championship_id = ? AND holder = ?`)
      .run(new Date(at.getTime() + ttlMs).toISOString(), championshipId, holder).changes
    return Number(changed) > 0
  }

  /** Gives the lease back. Guarded on the holder, for the same reason. */
  async releaseDrainLease(championshipId: string, holder: string): Promise<void> {
    this.#db
      .prepare(`DELETE FROM drain_lease WHERE championship_id = ? AND holder = ?`)
      .run(championshipId, holder)
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

  /**
   * Notes that a drain ran, whether or not it had anything to do.
   *
   * A drain that found an empty queue still proves the watcher is alive, which
   * is the question this answers.
   */
  async recordDrainRun(championshipId: string, at: Date): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO drain_run (championship_id, ran_at) VALUES (?, ?)
         ON CONFLICT(championship_id) DO UPDATE SET ran_at = excluded.ran_at`,
      )
      .run(championshipId, at.toISOString())
  }

  async lastDrainRun(championshipId: string): Promise<Date | undefined> {
    const row = this.#db
      .prepare("SELECT ran_at FROM drain_run WHERE championship_id = ?")
      .get(championshipId) as unknown as { ran_at: string } | undefined
    return row ? new Date(row.ran_at) : undefined
  }

  /** The audit trail, newest first. */
  async history(championshipId: string, limit = 50): Promise<Submission[]> {
    const rows = this.#db
      .prepare(
        `SELECT ${ROW_COLUMNS} FROM livery_submission WHERE championship_id = ?
         ORDER BY id DESC LIMIT ?`,
      )
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
