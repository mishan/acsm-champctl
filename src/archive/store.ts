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
 * still exactly what ACSM produced.
 *
 * **Snapshots are deduplicated by content.** A nightly run over a finished
 * season would otherwise write an identical copy of every championship every
 * night forever. Instead a snapshot is written only when the body differs from
 * the last one stored, and `lastCheckedAt` records that the run happened. The
 * file list then doubles as a change history: one entry per time a
 * championship actually changed.
 */

import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

/** One stored copy of an export. */
export interface Snapshot {
  /** When this body was first seen. Also names the file. */
  fetchedAt: string
  file: string
  sha256: string
  bytes: number
  /** The championship's name at the time, for reading the index by eye. */
  name?: string
}

/** Per-championship metadata, written alongside its snapshots. */
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
  put(championshipId: string, body: string, at: Date, name?: string): Promise<StoreResult>
  read(championshipId: string): Promise<ChampionshipIndex | undefined>
  list(): Promise<string[]>
}

export function sha256(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex")
}

/**
 * A championship ID comes off the wire, and it is about to become a path
 * segment. `../../..` or an absolute path would put an attacker-chosen file
 * anywhere the process can write, so IDs are checked against what ACSM
 * actually issues — UUIDs — rather than escaped and hoped for.
 *
 * Deliberately a whitelist. Being handed an ID shape we don't recognise should
 * stop the run and get looked at, not get sanitised into something plausible.
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export class UnsafeChampionshipId extends Error {
  constructor(readonly championshipId: string) {
    super(
      `Refusing to use ${JSON.stringify(championshipId)} as an archive directory name. ` +
        `Championship IDs are expected to be UUIDs; this one could escape the archive ` +
        `directory or overwrite its metadata.`,
    )
    this.name = "UnsafeChampionshipId"
  }
}

export function assertSafeChampionshipId(id: string): void {
  // "index" would collide with the per-championship index file, and "." / ".."
  // are caught by the pattern's first character class.
  if (!SAFE_ID.test(id) || id === INDEX_FILE || id.includes("..")) {
    throw new UnsafeChampionshipId(id)
  }
}

const INDEX_FILE = "index.json"

/**
 * Colons are legal in a POSIX filename and illegal on Windows, and an archive
 * that can't be copied to a Windows machine is a worse archive. Kept sortable,
 * so a plain directory listing is in chronological order.
 */
export function snapshotFileName(at: Date): string {
  return `${at.toISOString().replace(/[:.]/g, "-")}.json`
}

export class FileArchiveStore implements ArchiveStore {
  readonly #root: string

  constructor(root: string) {
    this.#root = root
  }

  async put(
    championshipId: string,
    body: string,
    at: Date,
    name?: string,
  ): Promise<StoreResult> {
    assertSafeChampionshipId(championshipId)
    const dir = join(this.#root, championshipId)
    await mkdir(dir, { recursive: true })

    const digest = sha256(body)
    const existing = await this.read(championshipId)
    const previous = existing?.snapshots.at(-1)
    const when = at.toISOString()

    // Unchanged: record that we looked, write no new copy.
    if (existing && previous && previous.sha256 === digest) {
      await this.#writeIndex(dir, { ...existing, lastCheckedAt: when })
      return { championshipId, stored: false, sha256: digest, snapshot: previous }
    }

    const snapshot: Snapshot = {
      fetchedAt: when,
      file: snapshotFileName(at),
      sha256: digest,
      bytes: Buffer.byteLength(body, "utf8"),
      ...(name === undefined ? {} : { name }),
    }

    // Body first. If the process dies between these two writes, the result is
    // an orphaned snapshot file, which is recoverable by rehashing. The other
    // order gives an index pointing at a file that isn't there.
    await writeFile(join(dir, snapshot.file), body, "utf8")
    await this.#writeIndex(dir, {
      championshipId,
      firstSeen: existing?.firstSeen ?? when,
      lastCheckedAt: when,
      snapshots: [...(existing?.snapshots ?? []), snapshot],
    })

    return { championshipId, stored: true, sha256: digest, snapshot }
  }

  async read(championshipId: string): Promise<ChampionshipIndex | undefined> {
    assertSafeChampionshipId(championshipId)
    try {
      const text = await readFile(join(this.#root, championshipId, INDEX_FILE), "utf8")
      return JSON.parse(text) as ChampionshipIndex
    } catch {
      // No index yet, or an unreadable one. Either way this championship has
      // nothing to compare against, so the caller stores a fresh snapshot.
      return undefined
    }
  }

  async list(): Promise<string[]> {
    try {
      const entries = await readdir(this.#root, { withFileTypes: true })
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
    } catch {
      return []
    }
  }

  /** Reads a stored snapshot back, verbatim. */
  async readSnapshot(championshipId: string, file: string): Promise<string> {
    assertSafeChampionshipId(championshipId)
    assertSafeChampionshipId(file)
    return readFile(join(this.#root, championshipId, file), "utf8")
  }

  async #writeIndex(dir: string, index: ChampionshipIndex): Promise<void> {
    await writeFile(join(dir, INDEX_FILE), `${JSON.stringify(index, null, 2)}\n`, "utf8")
  }
}
