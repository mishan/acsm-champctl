/**
 * Every livery champctl has put on a championship's cars, kept for the life of
 * the championship (docs/discord-livery-upload.md §6).
 *
 * The reason this exists is the carset. A livery on the server is only half the
 * job: everyone else on the grid needs the files too, or they see the default
 * skin where a car should be. Leagues solve that today by somebody maintaining
 * an archive by hand, which is the job the Discord upload flow exists to
 * delete — so champctl has to keep the bytes it applied and be able to hand
 * them back as one installable pack.
 *
 * Three decisions shape the schema.
 *
 * **The recording point is the apply, not the bot.** Every route in — an
 * operator's `--zip`, the drain, whatever comes later — goes through
 * `applyLiveries`, so that is where the write hangs off. Recording only Discord
 * submissions would produce a carset that is wrong the first week somebody
 * uploads a livery by hand: on the server, missing from the pack, and the
 * driver who installed the pack still cannot see that car. An almost-complete
 * carset is worse than none, because nobody knows which car is the missing one.
 *
 * **One row per driver and car, replaced on re-upload.** This is what bounds
 * the disk. A driver iterating on a livery through a season would otherwise
 * leave a season's worth of dead copies, none of which is carset material —
 * the superseded bytes have no reader once the newer ones are on the server.
 *
 * **Files are stored as files, and the digest describes the content rather
 * than the packaging.** Storing the submitted zip would mean the hash changed
 * when a driver re-zipped the same artwork, which would look like a new carset
 * to everyone holding the old one. It would also have made the pack build
 * depend on how each submission happened to be wrapped. Hashing a sorted
 * manifest of `name` and per-file digest is stable against both, and against
 * the zip-timestamp trap that makes archive bytes depend on the builder's
 * timezone.
 */

import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { restrictToOwner } from "../sqlite.js"
import type { Livery, SkinFile } from "./pack.js"

/** Where a livery came in by. Recorded for the audit trail, not branched on. */
export type LiverySource = "zip" | "discord" | "unknown"

/** A livery in the store, without its bytes. */
export interface StoredLivery {
  championshipId: string
  carModel: string
  driverName: string
  skinFolder: string
  /** Digest of the file manifest — see `liveryDigest`. */
  digest: string
  bytes: number
  fileCount: number
  source: LiverySource
  /** First time this driver and car had any livery recorded. */
  firstAppliedAt: string
  /** Last time champctl applied this one. Moves even when nothing changed. */
  appliedAt: string
}

/** A livery in the store, with the files needed to build the carset. */
export interface StoredLiveryWithFiles extends StoredLivery {
  files: SkinFile[]
}

export interface RecordResult {
  /** Liveries whose content differed from what was already recorded. */
  stored: number
  /** Liveries already recorded byte-for-byte. `appliedAt` still moved. */
  unchanged: number
}

export interface LiveryRecorder {
  record(
    championshipId: string,
    liveries: readonly Livery[],
    at: Date,
    source: LiverySource,
  ): Promise<RecordResult>
}

function digestOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/**
 * A livery's identity, as content rather than as a file.
 *
 * Sorted by name so the order files came out of a zip in cannot change the
 * answer, and built from per-file digests rather than from concatenated bodies
 * so that two files cannot be rearranged into the same input — `ab` + `c` and
 * `a` + `bc` are different manifests here and would not be if the bytes were
 * simply run together.
 *
 * The name is in the digest as well as the body: renaming `livery.dds` to
 * `livery2.dds` is a different skin as far as the game is concerned, and a
 * carset that did not notice would leave everyone holding a stale one.
 */
export function liveryDigest(files: readonly SkinFile[]): string {
  const hash = createHash("sha256")
  for (const file of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    hash.update(`${file.name}\u0000${digestOf(file.bytes)}\n`)
  }
  return hash.digest("hex")
}

/**
 * `STRICT` for the same reason the archive uses it: a column that says INTEGER
 * should hold an integer, rather than SQLite accepting anything anywhere and
 * the bad write being found months later on read.
 *
 * The unique index is the retention policy, expressed where it cannot be
 * forgotten. There is no way to accumulate two liveries for one driver and car
 * in one championship, so nothing has to remember to prune.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS livery (
  id                INTEGER PRIMARY KEY,
  championship_id   TEXT NOT NULL,
  car_model         TEXT NOT NULL,
  driver_name       TEXT NOT NULL,
  skin_folder       TEXT NOT NULL,
  digest            TEXT NOT NULL,
  bytes             INTEGER NOT NULL,
  file_count        INTEGER NOT NULL,
  source            TEXT NOT NULL,
  first_applied_at  TEXT NOT NULL,
  applied_at        TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS livery_current
  ON livery (championship_id, car_model, driver_name);

CREATE TABLE IF NOT EXISTS livery_file (
  livery_id  INTEGER NOT NULL REFERENCES livery(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  body       BLOB NOT NULL,
  PRIMARY KEY (livery_id, name)
) STRICT;
`

interface LiveryRow {
  id: number
  championship_id: string
  car_model: string
  driver_name: string
  skin_folder: string
  digest: string
  bytes: number
  file_count: number
  source: string
  first_applied_at: string
  applied_at: string
}

interface FileRow {
  livery_id: number
  name: string
  body: Uint8Array
}

/** Anything not written by this version of champctl reads back as `unknown`. */
function sourceOf(value: string): LiverySource {
  return value === "zip" || value === "discord" ? value : "unknown"
}

function toStored(row: LiveryRow): StoredLivery {
  return {
    championshipId: row.championship_id,
    carModel: row.car_model,
    driverName: row.driver_name,
    skinFolder: row.skin_folder,
    digest: row.digest,
    bytes: row.bytes,
    fileCount: row.file_count,
    source: sourceOf(row.source),
    firstAppliedAt: row.first_applied_at,
    appliedAt: row.applied_at,
  }
}

export interface OpenOptions {
  /** How long a writer waits for another writer's lock. Default 5s. */
  busyTimeoutMs?: number
}

export class SqliteLiveryStore implements LiveryRecorder {
  readonly #db: DatabaseSync

  private constructor(db: DatabaseSync) {
    this.#db = db
  }

  static async open(path: string, options: OpenOptions = {}): Promise<SqliteLiveryStore> {
    // 0700 on a directory champctl creates, matching the archive: this holds
    // driver names and the artwork drivers submitted, and the default under a
    // 0022 umask is readable by every other account on a league VPS. An
    // existing directory is the operator's to set.
    if (path !== ":memory:") await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(path)

    db.exec("PRAGMA journal_mode = WAL")
    db.exec(`PRAGMA busy_timeout = ${Number(options.busyTimeoutMs ?? 5000)}`)
    // Not optional here. Replacing a livery deletes its row and relies on the
    // cascade to take the files with it; without this pragma SQLite ignores the
    // foreign key and the old files stay, orphaned, in every carset built after.
    db.exec("PRAGMA foreign_keys = ON")
    db.exec(SCHEMA)
    if (path !== ":memory:") await restrictToOwner(path)
    return new SqliteLiveryStore(db)
  }

  /**
   * Records what was applied.
   *
   * One `BEGIN IMMEDIATE` for the whole set, so a carset built while a drain is
   * running sees either all of that drain's liveries or none of them — never a
   * grid where half the cars updated. Immediate rather than deferred because
   * this is a read-modify-write: it reads each existing digest before deciding
   * whether to replace, and a deferred transaction would not hold the write
   * lock across that gap.
   */
  async record(
    championshipId: string,
    liveries: readonly Livery[],
    at: Date,
    source: LiverySource,
  ): Promise<RecordResult> {
    const when = at.toISOString()
    const result: RecordResult = { stored: 0, unchanged: 0 }

    this.#db.exec("BEGIN IMMEDIATE")
    try {
      for (const livery of liveries) {
        const digest = liveryDigest(livery.files)
        const existing = this.#db
          .prepare(
            `SELECT id, digest FROM livery
             WHERE championship_id = ? AND car_model = ? AND driver_name = ?`,
          )
          .get(championshipId, livery.carModel, livery.driverName) as unknown as
          | { id: number; digest: string }
          | undefined

        if (existing?.digest === digest) {
          // Same artwork, applied again. The row stays as it is apart from the
          // timestamp: rewriting identical bytes would change nothing a reader
          // can see and would drop `first_applied_at`, which is the only record
          // of when this driver's livery actually arrived.
          this.#db
            .prepare("UPDATE livery SET applied_at = ?, source = ? WHERE id = ?")
            .run(when, source, existing.id)
          result.unchanged += 1
          continue
        }

        // `first_applied_at` survives a replacement. A driver who has had a
        // livery since March still has, even after changing it in September;
        // resetting it would make the store unable to answer when they first
        // turned up, which is the question the archive gets asked.
        const firstAppliedAt = existing
          ? ((
              this.#db
                .prepare("SELECT first_applied_at FROM livery WHERE id = ?")
                .get(existing.id) as { first_applied_at: string } | undefined
            )?.first_applied_at ?? when)
          : when

        if (existing) this.#db.prepare("DELETE FROM livery WHERE id = ?").run(existing.id)

        const inserted = this.#db
          .prepare(
            `INSERT INTO livery (
               championship_id, car_model, driver_name, skin_folder,
               digest, bytes, file_count, source, first_applied_at, applied_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            championshipId,
            livery.carModel,
            livery.driverName,
            livery.skinFolder,
            digest,
            livery.totalBytes,
            livery.files.length,
            source,
            firstAppliedAt,
            when,
          )

        const liveryId = Number(inserted.lastInsertRowid)
        const insertFile = this.#db.prepare(
          "INSERT INTO livery_file (livery_id, name, bytes, body) VALUES (?, ?, ?, ?)",
        )
        for (const file of livery.files) {
          insertFile.run(liveryId, file.name, file.bytes.length, Buffer.from(file.bytes))
        }
        result.stored += 1
      }

      this.#db.exec("COMMIT")
    } catch (e) {
      this.#db.exec("ROLLBACK")
      throw e
    }

    return result
  }

  /**
   * What is on this championship's cars, without the bytes.
   *
   * Ordered by car then driver, which is the order the carset lays them out —
   * so a listing and the pack it describes read the same way round.
   */
  async list(championshipId: string): Promise<StoredLivery[]> {
    const rows = this.#db
      .prepare(
        `SELECT * FROM livery WHERE championship_id = ?
         ORDER BY car_model, driver_name`,
      )
      .all(championshipId) as unknown as LiveryRow[]
    return rows.map(toStored)
  }

  /**
   * The same, with the files, for building the carset.
   *
   * One query for the files rather than one per livery: thirty drivers is
   * thirty round trips otherwise, and the whole point of the pack is that it is
   * cheap enough to rebuild rather than cache by hand.
   */
  async read(championshipId: string): Promise<StoredLiveryWithFiles[]> {
    const rows = this.#db
      .prepare(
        `SELECT * FROM livery WHERE championship_id = ?
         ORDER BY car_model, driver_name`,
      )
      .all(championshipId) as unknown as LiveryRow[]
    if (rows.length === 0) return []

    const files = this.#db
      .prepare(
        `SELECT f.livery_id, f.name, f.body FROM livery_file f
         JOIN livery l ON l.id = f.livery_id
         WHERE l.championship_id = ?
         ORDER BY f.livery_id, f.name`,
      )
      .all(championshipId) as unknown as FileRow[]

    const byLivery = new Map<number, SkinFile[]>()
    for (const file of files) {
      const list = byLivery.get(file.livery_id) ?? []
      list.push({ name: file.name, bytes: new Uint8Array(file.body) })
      byLivery.set(file.livery_id, list)
    }

    return rows.map((row) => ({ ...toStored(row), files: byLivery.get(row.id) ?? [] }))
  }

  /**
   * Drops a championship's liveries.
   *
   * Retention is deliberate rather than automatic. A championship ending is not
   * a reason to delete the carset the same evening — drivers keep racing the
   * cars, and somebody always wants last season's grid back. This is here so
   * that when a league does decide, there is one call rather than a hand-written
   * DELETE against a live database.
   */
  async forget(championshipId: string): Promise<number> {
    const before = this.#db
      .prepare("SELECT count(*) AS n FROM livery WHERE championship_id = ?")
      .get(championshipId) as unknown as { n: number }
    this.#db.prepare("DELETE FROM livery WHERE championship_id = ?").run(championshipId)
    return before.n
  }

  close(): void {
    this.#db.close()
  }
}
