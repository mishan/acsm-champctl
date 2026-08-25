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
 * One safe path segment: no separator, no traversal, no leading dot.
 *
 * Championship IDs arrive off the wire and become directory names, so this is
 * a containment check — it exists to keep a hostile or malformed value from
 * writing outside the archive root, and that is the whole of its contract.
 *
 * Deliberately **not** a UUID check, even though UUIDs are what ACSM issues
 * today. Two reasons.
 *
 * The security property doesn't need it. `../../etc`, `/etc/passwd` and `a/b`
 * are already refused by the pattern below; a UUID check would reject strictly
 * more, none of which is more dangerous.
 *
 * And the cost of over-strictness runs the wrong way here. This is an archive
 * whose entire justification is that history gets lost if it isn't captured
 * (plan §8.1). If a future ACSM issues an ID in some other shape, a
 * UUID-strict check would refuse to store that championship at all — turning
 * an unrecognised ID into exactly the data loss the archive exists to prevent.
 * Failing closed is right when the risk is corrupting data, as with
 * `checkEntryListShape`; it is wrong when the risk is not keeping it.
 *
 * The same rule covers snapshot filenames, which are timestamps rather than
 * UUIDs — another reason a UUID check would be wrong here.
 */
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export class UnsafeArchivePath extends Error {
  constructor(
    readonly value: string,
    what: string,
  ) {
    super(
      `Refusing to use ${JSON.stringify(value)} as ${what} in the archive: it is not a single ` +
        `path segment, so it could escape the archive directory or overwrite its metadata.`,
    )
    this.name = "UnsafeArchivePath"
  }
}

/** Throws unless `value` is usable as one path segment inside the archive. */
export function assertSafePathSegment(value: string, what: string): void {
  // `index.json` would collide with the per-championship index file.
  //
  // The `..` test is defence in depth and nothing more: the pattern already
  // forbids `/` and `\`, so a value that passes it cannot traverse, and "."
  // and ".." alone fail its first character class. It is here so that widening
  // the pattern later — to allow a separator, say — can't quietly reintroduce
  // traversal. The price is refusing a harmless name like "a..b", which no
  // championship ID or snapshot filename looks like.
  if (!SAFE_PATH_SEGMENT.test(value) || value === INDEX_FILE || value.includes("..")) {
    throw new UnsafeArchivePath(value, what)
  }
}

export function assertSafeChampionshipId(id: string): void {
  assertSafePathSegment(id, "a championship directory name")
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
    // Same containment rule, but this one is a filename — a timestamp, not an
    // ID — so it gets its own wording rather than being reported as a bad
    // championship ID.
    assertSafePathSegment(file, "a snapshot filename")
    return readFile(join(this.#root, championshipId, file), "utf8")
  }

  async #writeIndex(dir: string, index: ChampionshipIndex): Promise<void> {
    await writeFile(join(dir, INDEX_FILE), `${JSON.stringify(index, null, 2)}\n`, "utf8")
  }
}
