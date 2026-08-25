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

/** One stored copy of an export. */
export interface Snapshot {
  /** When this body was first seen. Identifies the snapshot. */
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
  championship_id TEXT NOT NULL REFERENCES championship(id) ON DELETE CASCADE,
  fetched_at      TEXT NOT NULL,
  sha256          TEXT NOT NULL,
  bytes           INTEGER NOT NULL,
  name            TEXT,
  body            BLOB NOT NULL,
  PRIMARY KEY (championship_id, fetched_at)
) STRICT;
`

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
  static async open(path: string): Promise<SqliteArchiveStore> {
    if (path !== ":memory:") await mkdir(dirname(path), { recursive: true })
    const db = new DatabaseSync(path)

    // WAL so `status` reading doesn't block `run` writing, and a busy timeout
    // so two writers queue rather than one failing outright — a nightly job
    // overlapping a manual run should be slow, not fatal.
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA busy_timeout = 5000")
    db.exec("PRAGMA foreign_keys = ON")
    db.exec(SCHEMA)
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
          `INSERT INTO championship (id, first_seen, last_checked) VALUES (?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET last_checked = excluded.last_checked`,
        )
        .run(championshipId, when, when)

      const previous = this.#db
        .prepare(
          `SELECT fetched_at, sha256, bytes, name FROM snapshot
           WHERE championship_id = ? ORDER BY fetched_at DESC LIMIT 1`,
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

      this.#db
        .prepare(
          `INSERT INTO snapshot (championship_id, fetched_at, sha256, bytes, name, body)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(championshipId, when, digest, body.byteLength, name ?? null, body)

      this.#db.exec("COMMIT")
      return {
        championshipId,
        stored: true,
        sha256: digest,
        snapshot: {
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
        `SELECT fetched_at, sha256, bytes, name FROM snapshot
         WHERE championship_id = ? ORDER BY fetched_at ASC`,
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

  /** A stored body, verbatim. `fetchedAt` identifies the snapshot. */
  async readSnapshot(championshipId: string, fetchedAt: string): Promise<Buffer> {
    const row = this.#db
      .prepare("SELECT body FROM snapshot WHERE championship_id = ? AND fetched_at = ?")
      .get(championshipId, fetchedAt) as unknown as { body: Uint8Array } | undefined
    if (!row) {
      throw new Error(`No snapshot for championship ${championshipId} at ${fetchedAt}.`)
    }
    return Buffer.from(row.body)
  }

  close(): void {
    this.#db.close()
  }
}

interface SnapshotRow {
  fetched_at: string
  sha256: string
  bytes: number
  name: string | null
}

function toSnapshot(r: SnapshotRow): Snapshot {
  return {
    fetchedAt: r.fetched_at,
    sha256: r.sha256,
    bytes: r.bytes,
    ...(r.name === null ? {} : { name: r.name }),
  }
}
