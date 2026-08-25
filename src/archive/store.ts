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

import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
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
  put(championshipId: string, body: Buffer, at: Date, name?: string): Promise<StoreResult>
  read(championshipId: string): Promise<ChampionshipIndex | undefined>
  list(): Promise<string[]>
}

/**
 * The digest of the stored bytes.
 *
 * Takes a `Buffer` and not a string on purpose: hashing a decoded-then-
 * re-encoded copy would describe something other than the file on disk, and
 * then `sha256` could never be checked against the source or the server.
 */
export function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex")
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
 * Whether a parsed index is usable, checking the fields `put` and the CLI
 * actually rely on rather than every field in the interface.
 *
 * Proportionate on purpose. A snapshot entry with a missing `name` is still a
 * usable history; one that isn't an object at all is not, because `put` reads
 * `sha256` off the last of them and `readSnapshot` reads `file`.
 */
function isChampionshipIndex(value: unknown): value is ChampionshipIndex {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return (
    typeof v["championshipId"] === "string" &&
    typeof v["firstSeen"] === "string" &&
    typeof v["lastCheckedAt"] === "string" &&
    Array.isArray(v["snapshots"]) &&
    v["snapshots"].every(
      (s) =>
        typeof s === "object" &&
        s !== null &&
        typeof (s as Record<string, unknown>)["file"] === "string" &&
        typeof (s as Record<string, unknown>)["sha256"] === "string",
    )
  )
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

  async put(championshipId: string, body: Buffer, at: Date, name?: string): Promise<StoreResult> {
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
      bytes: body.byteLength,
      ...(name === undefined ? {} : { name }),
    }

    // Body first. If the process dies between these two writes, the result is
    // an orphaned snapshot file: the index doesn't mention it, but no history
    // is lost and re-running stores it again. The other order gives an index
    // pointing at a file that isn't there.
    //
    // `wx` so a second write in the same millisecond fails loudly rather than
    // overwriting a body the index already lists. Reachable with an injected
    // clock, and with two runs overlapping.
    await writeFile(join(dir, snapshot.file), body, { flag: "wx" })
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

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      // Corrupt or half-written. Recoverable, so treat it as absent.
      return undefined
    }

    // Parsing is not enough, and casting the result was the bug. `{}` and
    // `null` are valid JSON, and both came back as a "ChampionshipIndex" that
    // `put` then tripped over — `existing.snapshots.at(-1)` on undefined.
    // `{"snapshots":"nope"}` was worse: it threw nothing, while the spread
    // produced a fresh index and silently dropped the history.
    //
    // "Recoverable means treat it as absent" is only true if the shape is
    // actually checked, so it is checked.
    return isChampionshipIndex(parsed) ? parsed : undefined
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
      return (
        entries
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
      )
    } catch (e) {
      if (isNotFound(e)) return []
      throw e
    }
  }

  /** Reads a stored snapshot back, verbatim — bytes, for the same reason `put` takes them. */
  async readSnapshot(championshipId: string, file: string): Promise<Buffer> {
    assertSafeChampionshipId(championshipId)
    // Same containment rule, but this one is a filename — a timestamp, not an
    // ID — so it gets its own wording rather than being reported as a bad
    // championship ID.
    assertSafePathSegment(file, "a snapshot filename")
    return readFile(join(this.#root, championshipId, file))
  }

  /**
   * Writes the index atomically: temp file, then rename.
   *
   * A plain `writeFile` truncates before it writes, so a crash mid-write leaves
   * a short file. `read` treats an unparseable index as "no index", and `put`
   * would then start a fresh one — silently discarding every snapshot recorded
   * so far and resetting `firstSeen`, while the bodies sat orphaned on disk.
   * The change history is the thing this module exists to keep, so losing it to
   * a torn write is the one failure worth spending a rename on.
   *
   * `rename` within a directory is atomic on POSIX: readers see the old index
   * or the new one, never a partial.
   *
   * The temp name is unique per write, not a fixed `index.json.tmp`. Two runs
   * overlapping on the same championship — a manual run during the cron window
   * — would otherwise write the same path concurrently, and each `rename` would
   * publish whatever the *other* process had most recently left there. A torn
   * write is what this method exists to prevent; doing it through a shared
   * scratch file would reintroduce the same loss by a different route.
   *
   * This does not make concurrent runs safe. `put` is still an unguarded
   * read-modify-write, so the later writer's index can still omit a snapshot
   * the earlier one added. It removes the case where the *bytes in flight*
   * belong to someone else, which is the one that can publish a half-written
   * or entirely unrelated index.
   */
  async #writeIndex(dir: string, index: ChampionshipIndex): Promise<void> {
    const target = join(dir, INDEX_FILE)
    const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(tmp, `${JSON.stringify(index, null, 2)}\n`, "utf8")
      await rename(tmp, target)
    } catch (e) {
      // Don't leave scratch files behind on a failed write; the archive root is
      // meant to be readable by eye.
      await rm(tmp, { force: true }).catch(() => undefined)
      throw e
    }
  }
}
