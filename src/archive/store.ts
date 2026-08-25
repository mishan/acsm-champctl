/**
 * The archive: every championship export the league has ever run, kept as the
 * bytes the server sent (plan §8.1).
 *
 * Two rules shape everything here.
 *
 * **Raw JSON is immutable.** Nothing in this module edits, normalises or
 * re-serialises a stored export. Stats tables are a projection built on top and
 * are expected to be thrown away and rebuilt whenever a definition changes or
 * two driver identities get merged. That only works if the source bytes are
 * still exactly what ACSM produced — so bodies are `BLOB`, not `TEXT`, and go
 * in and come back out as `Buffer`.
 *
 * **Snapshots are deduplicated by content.** A nightly run over a finished
 * season would otherwise write an identical copy of every championship every
 * night forever. Instead a snapshot is written only when the body differs from
 * the last one stored, and `lastCheckedAt` records that the run happened. The
 * snapshot list then doubles as a change history: one row per time a
 * championship actually changed.
 *
 * ## Why SQLite
 *
 * This began as a directory of JSON files with an `index.json` beside them, and
 * every bug found in it was the same bug wearing a different hat: two writes
 * that had to land together, landing separately.
 *
 * - A torn `index.json` read as "no index", so the next run started a fresh one
 *   and silently dropped the history while the bodies sat orphaned on disk.
 * - Writing through a shared `index.json.tmp` meant one run's `rename` could
 *   publish another run's bytes, and the loser got an ENOENT about a file it
 *   had written itself.
 * - Two overlapping runs both read the old index, and the second to finish
 *   published one missing the first's snapshot.
 * - Dedup trusted the recorded hash without checking the body was still there,
 *   so a deleted snapshot was masked forever by `lastCheckedAt` moving on.
 *
 * Each had a fix, and the fixes were accumulating into a hand-rolled
 * transaction log. SQLite already is one. A body and its metadata are now one
 * row written in one transaction: there is no window where one exists without
 * the other, no scratch file to collide over, and no second copy of the hash to
 * disagree with the bytes it describes.
 *
 * Path-safety machinery went with it. Championship IDs used to become directory
 * names, so a hostile or malformed one could escape the archive root and had to
 * be validated; they are now bound parameters in prepared statements, where the
 * question does not arise.
 */

import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { restrictToOwner } from "../sqlite.js"

/** One stored copy of an export. */
export interface Snapshot {
  /**
   * Identifies the snapshot. A surrogate key, not the timestamp: two runs can
   * fetch different bodies in the same millisecond, and keying on `fetchedAt`
   * made that a primary-key collision that rolled the second one back — losing
   * an archive state, which is the one thing this module must not do.
   */
  id: number
  /** When this body was fetched. Ordering metadata; not an identity. */
  fetchedAt: string
  sha256: string
  bytes: number
  /** The championship's name at the time, for reading the history by eye. */
  name?: string
}

/** Per-championship metadata, alongside its snapshots. */
export interface ChampionshipIndex {
  championshipId: string
  firstSeen: string
  /** Last time the ingest asked, whether or not anything had changed. */
  lastCheckedAt: string
  snapshots: Snapshot[]
}

export interface StoreResult {
  championshipId: string
  /** False when the body was identical to the previous snapshot. */
  stored: boolean
  sha256: string
  snapshot: Snapshot
}

export interface ArchiveStore {
  put(championshipId: string, body: Buffer, at: Date, name?: string): Promise<StoreResult>
  read(championshipId: string): Promise<ChampionshipIndex | undefined>
  list(): Promise<string[]>
}

/**
 * The digest of the stored bytes.
 *
 * Takes a `Buffer` and not a string on purpose: hashing a decoded-then-
 * re-encoded copy would describe something other than what is stored, and then
 * `sha256` could never be checked against the source or the server.
 */
export function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex")
}

/**
 * `STRICT` so a column that says INTEGER holds an integer. SQLite's default is
 * to accept anything anywhere, which for an archive means a corrupt write is
 * discovered on read, months later, rather than on write.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS championship (
  id             TEXT PRIMARY KEY,
  first_seen     TEXT NOT NULL,
  last_checked   TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS snapshot (
  id              INTEGER PRIMARY KEY,
  championship_id TEXT NOT NULL REFERENCES championship(id) ON DELETE CASCADE,
  fetched_at      TEXT NOT NULL,
  sha256          TEXT NOT NULL,
  bytes           INTEGER NOT NULL,
  name            TEXT,
  body            BLOB NOT NULL
) STRICT;

-- Dropped by its old name rather than left to CREATE IF NOT EXISTS, which is
-- a no-op when an index of that name already exists *with different columns*.
-- An archive created before snapshots were ordered by fetch time would
-- otherwise keep an index on (championship_id, id) and silently never get one
-- matching the queries that replaced it.
DROP INDEX IF EXISTS snapshot_history;

CREATE INDEX IF NOT EXISTS snapshot_by_fetch
  ON snapshot (championship_id, fetched_at, id);
`

export interface OpenOptions {
  /** How long a writer waits for another writer's lock. Default 5s. */
  busyTimeoutMs?: number
}

export class SqliteArchiveStore implements ArchiveStore {
  readonly #db: DatabaseSync

  private constructor(db: DatabaseSync) {
    this.#db = db
  }

  /**
   * Opens, and if necessary creates, the archive.
   *
   * Async only because the containing directory may need making; everything
   * after that is synchronous, which is what `node:sqlite` offers and is amply
   * fast for a nightly job writing a few dozen rows.
   */
  static async open(path: string, options: OpenOptions = {}): Promise<SqliteArchiveStore> {
    // 0700 on any directory this creates. The archive holds driver names and
    // Steam GUIDs, and .gitignore keeps it out of the repo but does nothing
    // about the other accounts on a league VPS — under the usual 0022 umask
    // the default is world-readable. Only directories champctl creates are
    // restricted; an existing one is the operator's to set, and quietly
    // rewriting its mode would be worse than leaving it.
    if (path !== ":memory:") await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(path)

    // WAL so `status` reading doesn't block `run` writing, and a busy timeout
    // so two writers queue rather than one failing outright — a nightly job
    // overlapping a manual run should be slow, not fatal. The timeout is an
    // option only so a test can prove the lock exists without waiting for it.
    db.exec("PRAGMA journal_mode = WAL")
    db.exec(`PRAGMA busy_timeout = ${Number(options.busyTimeoutMs ?? 5000)}`)
    db.exec("PRAGMA foreign_keys = ON")
    db.exec(SCHEMA)
    if (path !== ":memory:") await restrictToOwner(path)
    return new SqliteArchiveStore(db)
  }

  /**
   * Records a body, storing it only when it differs from the last one.
   *
   * One `BEGIN IMMEDIATE` transaction throughout. Immediate rather than
   * deferred because this is a read-modify-write: it reads the latest hash and
   * then decides whether to insert, and a deferred transaction takes the write
   * lock only at the insert — by which point another process could have
   * inserted the row this one just decided was absent.
   */
  async put(championshipId: string, body: Buffer, at: Date, name?: string): Promise<StoreResult> {
    const digest = sha256(body)
    const when = at.toISOString()

    this.#db.exec("BEGIN IMMEDIATE")
    try {
      this.#db
        .prepare(
          // Both bounds are clamped rather than assigned. Two processes take
          // the write lock in whatever order they get it, which is not
          // necessarily the order they fetched in — so a slow older run
          // committing last would otherwise drag last_checked backwards, and
          // --since would then re-fetch everything it had already done. Same
          // argument for first_seen in the other direction. ISO-8601 UTC sorts
          // lexicographically, so string min/max are chronological.
          `INSERT INTO championship (id, first_seen, last_checked) VALUES (?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             first_seen   = min(championship.first_seen, excluded.first_seen),
             last_checked = max(championship.last_checked, excluded.last_checked)`,
        )
        .run(championshipId, when, when)

      // Latest by *fetch* time, with the surrogate id only breaking ties.
      //
      // Ordering by id alone is commit order, and the two differ exactly when
      // it matters: an older fetch that waited behind a newer writer commits
      // last, so it became the baseline, and the next ordinary run then stored
      // the newer body again as though the championship had reverted. Fetch
      // time is what "the most recent state of this championship" means; id
      // settles two fetches in the same millisecond.
      const previous = this.#db
        .prepare(
          `SELECT id, fetched_at, sha256, bytes, name FROM snapshot
           WHERE championship_id = ? ORDER BY fetched_at DESC, id DESC LIMIT 1`,
        )
        .get(championshipId) as unknown as SnapshotRow | undefined

      // Unchanged: last_checked has already moved and no new body is written.
      // The hash compared here lives in the same row as the bytes it describes,
      // so unlike a file layout it cannot be vouching for something that is no
      // longer on disk.
      if (previous && previous.sha256 === digest) {
        this.#db.exec("COMMIT")
        return { championshipId, stored: false, sha256: digest, snapshot: toSnapshot(previous) }
      }

      const inserted = this.#db
        .prepare(
          `INSERT INTO snapshot (championship_id, fetched_at, sha256, bytes, name, body)
           VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
        )
        .get(championshipId, when, digest, body.byteLength, name ?? null, body) as unknown as {
        id: number
      }

      this.#db.exec("COMMIT")
      return {
        championshipId,
        stored: true,
        sha256: digest,
        snapshot: {
          id: inserted.id,
          fetchedAt: when,
          sha256: digest,
          bytes: body.byteLength,
          ...(name === undefined ? {} : { name }),
        },
      }
    } catch (e) {
      this.#db.exec("ROLLBACK")
      throw e
    }
  }

  /** The history for a championship, or undefined when it has none. */
  async read(championshipId: string): Promise<ChampionshipIndex | undefined> {
    const head = this.#db
      .prepare("SELECT first_seen, last_checked FROM championship WHERE id = ?")
      .get(championshipId) as unknown as { first_seen: string; last_checked: string } | undefined
    if (!head) return undefined

    const rows = this.#db
      .prepare(
        // Chronological, for the same reason: `status` reads the championship's
        // current name off the last entry, and in commit order that can be an
        // older fetch's name.
        `SELECT id, fetched_at, sha256, bytes, name FROM snapshot
         WHERE championship_id = ? ORDER BY fetched_at ASC, id ASC`,
      )
      .all(championshipId) as unknown as SnapshotRow[]

    return {
      championshipId,
      firstSeen: head.first_seen,
      lastCheckedAt: head.last_checked,
      snapshots: rows.map(toSnapshot),
    }
  }

  /** Every championship in the archive, by id, for a stable listing. */
  async list(): Promise<string[]> {
    const rows = this.#db
      .prepare("SELECT id FROM championship ORDER BY id ASC")
      .all() as unknown as { id: string }[]
    return rows.map((r) => r.id)
  }

  /** A stored body, verbatim, by snapshot id. */
  async readSnapshot(championshipId: string, snapshotId: number): Promise<Buffer> {
    const row = this.#db
      .prepare("SELECT body FROM snapshot WHERE championship_id = ? AND id = ?")
      .get(championshipId, snapshotId) as unknown as { body: Uint8Array } | undefined
    if (!row) {
      throw new Error(`No snapshot ${snapshotId} for championship ${championshipId}.`)
    }
    return Buffer.from(row.body)
  }

  close(): void {
    this.#db.close()
  }
}

interface SnapshotRow {
  id: number
  fetched_at: string
  sha256: string
  bytes: number
  name: string | null
}

function toSnapshot(r: SnapshotRow): Snapshot {
  return {
    id: r.id,
    fetchedAt: r.fetched_at,
    sha256: r.sha256,
    bytes: r.bytes,
    ...(r.name === null ? {} : { name: r.name }),
  }
}
