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
 * "This path isn't there", as distinct from "this path can't be read".
 *
 * ENOENT only, deliberately. ENOTDIR looks similar — you get it when a path
 * component is a regular file — but it means the archive layout is wrong
 * rather than merely empty, and that has to surface. `put` calls `mkdir`
 * before `read`, so a genuinely-absent directory is already handled by then.
 */
function isNotFound(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === "ENOENT"
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

/**
 * Whether `value` is usable as one path segment inside the archive.
 *
 * `index.json` is excluded because it would collide with the per-championship
 * index file.
 *
 * The `..` test is defence in depth and nothing more: the pattern already
 * forbids `/` and `\`, so a value that passes it cannot traverse, and "." and
 * ".." alone fail its first character class. It is here so that widening the
 * pattern later — to allow a separator, say — can't quietly reintroduce
 * traversal. The price is refusing a harmless name like "a..b", which no
 * championship ID or snapshot filename looks like.
 */
export function isSafePathSegment(value: string): boolean {
  return SAFE_PATH_SEGMENT.test(value) && value !== INDEX_FILE && !value.includes("..")
}

/** Throws unless `value` is usable as one path segment inside the archive. */
export function assertSafePathSegment(value: string, what: string): void {
  if (!isSafePathSegment(value)) throw new UnsafeArchivePath(value, what)
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

  /**
   * The index for a championship, or undefined when there isn't a usable one.
   *
   * Exactly two things mean "no index": the file isn't there yet, and the file
   * is there but doesn't parse. Both are recoverable — the caller writes a
   * fresh snapshot and the archive is none the worse.
   *
   * Everything else is rethrown. A permission error, a directory where the
   * index should be, a failing disk: those are operational problems, and
   * swallowing them makes a broken archive indistinguishable from an empty
   * one. The ingest would then report "archived" every night while writing
   * nothing — the worst outcome available to a tool whose whole job is not
   * losing data.
   */
  async read(championshipId: string): Promise<ChampionshipIndex | undefined> {
    assertSafeChampionshipId(championshipId)

    let text: string
    try {
      text = await readFile(join(this.#root, championshipId, INDEX_FILE), "utf8")
    } catch (e) {
      if (isNotFound(e)) return undefined
      throw e
    }

    try {
      return JSON.parse(text) as ChampionshipIndex
    } catch {
      // Corrupt or half-written. Recoverable, so treat it as absent.
      return undefined
    }
  }

  /**
   * Championship directories present, filtered to names this store would
   * accept — so every result is safe to pass straight to `read`.
   *
   * An archive that doesn't exist yet is empty, which is the normal state on a
   * first run. An archive that exists and can't be read is a problem, and says
   * so — see `read` above for why the distinction matters.
   */
  async list(): Promise<string[]> {
    try {
      const entries = await readdir(this.#root, { withFileTypes: true })
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        // Only names that are safe to hand straight back to `read`. Anything
        // else under the archive root is not ours: `lost+found`, a `.tmp` left
        // by an interrupted copy, an editor's scratch directory. Returning
        // those made `status` throw UnsafeArchivePath on a directory nobody
        // ever claimed was a championship — the guard firing on the wrong
        // target, and the whole command unusable because of it.
        //
        // Filtering rather than refusing, because this is the one place an
        // unrecognised name is expected rather than suspicious: the archive
        // root is an ordinary directory someone may keep other things in.
        .filter(isSafePathSegment)
        .sort()
    } catch (e) {
      if (isNotFound(e)) return []
      throw e
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
