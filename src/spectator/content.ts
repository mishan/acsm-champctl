/**
 * The car and track files the recorder answers checksums from.
 *
 * The server names each file it checksums, and Server Manager serves its
 * install's content folder at `/content/`, so a file the hand-copied AC root
 * lacks can be fetched from Server Manager itself: a track installed there is
 * recordable with no second copy. Fetched files are kept in a mirror folder,
 * which wins over the hand copy because it is the server's own.
 *
 * Reads never wait on the network. The handshake gives up after 10 s of
 * quiet, so a miss queues a fetch and fails this join; the retry finds the
 * file. Every request is for a file the server named, and they're capped
 * per hour: Server Manager sits behind CrowdSec, and a burst of requests from
 * this address got it banned once.
 */

import { lstat, mkdir, open as openFile, readdir, readFile, rename, rm } from "node:fs/promises"
import { dirname, join, posix } from "node:path"

export interface ContentFilesOptions {
  /** The hand-copied AC root; read only. */
  handRoot: string
  /** Where fetched files are kept. */
  mirrorRoot: string
  /** Server Manager's address. Absent means nothing is fetched. */
  acsmBase?: string
  fetch?: typeof fetch
  now?: () => number
  log?: (message: string) => void
  perHour?: number
  maxBytes?: number
}

const HOUR = 3600_000
const MISSING_MS = 24 * HOUR
const HOLD_MS = 10 * 60_000
const TIMEOUT_MS = 20_000
const PER_HOUR = 30
const MAX_BYTES = 64 * 1024 * 1024
const SEGMENT = /^[A-Za-z0-9_. -]+$/
const META = ".meta"

interface Meta {
  etag?: string
  missingAt?: number
  /** Kept on disk, so a restart loop doesn't repeat a failing request. */
  heldUntil?: number
}

/** Where a track layout's racing line sits, under an AC root. */
export function racingLine(track: string, layout: string): string {
  return posix.join("content/tracks", track, layout, "ai/fast_lane.ai")
}

/**
 * Only files under a car or track, named segment by segment from a short
 * alphabet: `/content/` serves directory listings too, and a path that names
 * a folder would put a page in the mirror.
 */
export function fetchable(path: string): boolean {
  const parts = path.split("/")
  if (parts[0] !== "content" || (parts[1] !== "cars" && parts[1] !== "tracks")) return false
  if (parts.length < 4) return false
  if (!parts.every((p) => SEGMENT.test(p) && p !== "." && p !== "..")) return false
  return /\.[A-Za-z0-9]+$/.test(parts[parts.length - 1] ?? "")
}

export class ContentFiles {
  readonly #o: ContentFilesOptions
  readonly #now: () => number
  readonly #log: (message: string) => void
  /** Undefined when the mirror can't be written: hand copies only. */
  readonly #mirror: string | undefined
  /** Failed a checksum: neither copy is read until a fresh one comes. */
  readonly #stale = new Set<string>()
  /**
   * Fresh from the server since the last join that held: a mismatch on one of
   * these isn't the file's fault, so it isn't asked for again.
   */
  readonly #fresh = new Set<string>()
  readonly #queued = new Set<string>()
  #sent: number[]
  #chain: Promise<void> = Promise.resolve()

  private constructor(o: ContentFilesOptions, mirror: string | undefined, sent: number[]) {
    this.#o = o
    this.#now = o.now ?? Date.now
    this.#log = o.log ?? (() => {})
    this.#mirror = mirror
    this.#sent = sent
  }

  static async open(o: ContentFilesOptions): Promise<ContentFiles> {
    const log = o.log ?? (() => {})
    let mirror: string | undefined = o.mirrorRoot
    let sent: number[] = []
    try {
      await mkdir(join(o.mirrorRoot, META), { recursive: true })
      await removeTemporaries(o.mirrorRoot)
      sent = await readFile(join(o.mirrorRoot, META, "sent.json"), "utf8")
        .then((s) => JSON.parse(s) as unknown)
        .then((v) => (Array.isArray(v) ? v.filter((t) => typeof t === "number") : []))
        .catch(() => [])
    } catch (e) {
      log(
        `can't keep fetched files in ${o.mirrorRoot} (${e instanceof Error ? e.message : String(e)}); reading ${o.handRoot} only`,
      )
      mirror = undefined
    }
    if (!o.acsmBase)
      log("no Server Manager address, so missing car and track files won't be fetched")
    return new ContentFiles(o, mirror, sent)
  }

  /** The file, from the mirror or the hand copy; a miss queues a fetch. */
  async read(path: string): Promise<Uint8Array | undefined> {
    if (!this.#stale.has(path)) {
      const got =
        (this.#mirror && (await readPlain(join(this.#mirror, path)))) ||
        (await readPlain(join(this.#o.handRoot, path)))
      if (got) return got
    }
    this.#queue(path)
    return undefined
  }

  /** The server kicked the car over these files' checksums. */
  mismatched(paths: readonly string[]): void {
    for (const path of paths) {
      // Doubting a copy nothing can replace would only stop every join.
      if (!this.#canFetch(path)) continue
      if (this.#fresh.has(path)) {
        this.#log(`${path} still fails the server's checksum, fresh from Server Manager`)
        continue
      }
      this.#stale.add(path)
      this.#queue(path)
    }
  }

  /** A join held: what failed before may be asked for again. */
  joined(): void {
    this.#fresh.clear()
  }

  /** Resolves once every queued fetch is done. */
  idle(): Promise<void> {
    return this.#chain
  }

  #canFetch(path: string): boolean {
    return this.#o.acsmBase !== undefined && this.#mirror !== undefined && fetchable(path)
  }

  #queue(path: string): void {
    if (!this.#canFetch(path)) return
    if (this.#queued.has(path)) return
    this.#queued.add(path)
    this.#chain = this.#chain
      .then(() => this.#fetch(path, this.#mirror as string, this.#o.acsmBase as string))
      .catch((e) => this.#hold(path, e instanceof Error ? e.message : String(e)))
      .catch((e) => this.#log(`couldn't note a failed fetch of ${path}: ${String(e)}`))
      .finally(() => this.#queued.delete(path))
  }

  async #fetch(path: string, mirror: string, base: string): Promise<void> {
    const metaPath = join(mirror, META, `${path}.json`)
    const meta: Meta = await readFile(metaPath, "utf8")
      .then((s) => JSON.parse(s) as Meta)
      .catch(() => ({}))
    if (meta.missingAt !== undefined && this.#now() - meta.missingAt < MISSING_MS) {
      this.#settle(path)
      return
    }
    if ((meta.heldUntil ?? 0) > this.#now()) return
    if (!(await this.#spend(mirror))) {
      await this.#hold(path, `the ${this.#o.perHour ?? PER_HOUR} requests an hour are spent`)
      return
    }
    const mirrored = await readPlain(join(mirror, path))
    const url = new URL(`/${path}`, base)
    const res = await (this.#o.fetch ?? fetch)(url, {
      headers: {
        // Cloudflare in front of Server Manager could otherwise answer with
        // the copy from before a mod update.
        "Cache-Control": "no-cache",
        ...(meta.etag && mirrored ? { "If-None-Match": meta.etag } : {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (res.status === 304 && mirrored) {
      this.#settle(path)
      return
    }
    if (res.status === 404) {
      await writeMeta(metaPath, { missingAt: this.#now() })
      this.#log(`Server Manager has no ${path}`)
      // Nothing better to answer with than the copy we have, if any.
      this.#settle(path)
      return
    }
    if (res.status !== 200) throw new Error(`${res.status} from Server Manager`)
    if (res.headers.get("content-type")?.startsWith("text/html")) {
      throw new Error("Server Manager sent a page, not the file")
    }
    const bytes = await readCapped(res, this.#o.maxBytes ?? MAX_BYTES)
    const target = join(mirror, path)
    await mkdir(dirname(target), { recursive: true })
    await writeAtomic(target, bytes)
    const etag = res.headers.get("etag")
    await writeMeta(metaPath, etag ? { etag } : {})
    this.#log(`fetched ${path} from Server Manager (${bytes.length} bytes)`)
    this.#settle(path)
  }

  /** Server Manager has answered for this file: a later mismatch isn't its copy's fault. */
  #settle(path: string): void {
    this.#stale.delete(path)
    this.#fresh.add(path)
  }

  async #hold(path: string, why: string): Promise<void> {
    this.#log(`couldn't fetch ${path} from Server Manager: ${why}; trying again in 10 minutes`)
    const metaPath = join(this.#mirror as string, META, `${path}.json`)
    // Kept with the ETag, so the retry can still be a cheap revalidation.
    const meta: Meta = await readFile(metaPath, "utf8")
      .then((s) => JSON.parse(s) as Meta)
      .catch(() => ({}))
    await writeMeta(metaPath, { ...meta, heldUntil: this.#now() + HOLD_MS })
  }

  /** Kept on disk, so a restart loop can't reset it. */
  async #spend(mirror: string): Promise<boolean> {
    const now = this.#now()
    this.#sent = this.#sent.filter((t) => now - t < HOUR)
    if (this.#sent.length >= (this.#o.perHour ?? PER_HOUR)) return false
    this.#sent.push(now)
    // Renamed into place: a crash mid-write would otherwise reset the count.
    await writeAtomic(join(mirror, META, "sent.json"), JSON.stringify(this.#sent))
    return true
  }
}

/** A regular file's bytes, or undefined; a link left in place of the file isn't followed. */
async function readPlain(path: string): Promise<Uint8Array | undefined> {
  const s = await lstat(path).catch(() => undefined)
  if (!s?.isFile()) return undefined
  return readFile(path).catch(() => undefined)
}

async function readCapped(res: Response, max: number): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of res.body ?? []) {
    size += chunk.length
    if (size > max) throw new Error(`the file is over the ${max}-byte cap`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function writeMeta(path: string, meta: Meta): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeAtomic(path, JSON.stringify(meta))
}

async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`
  const fh = await openFile(tmp, "w")
  try {
    await fh.writeFile(data)
    await fh.sync()
  } finally {
    await fh.close()
  }
  await rename(tmp, path)
}

async function removeTemporaries(dir: string): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile() && /\.tmp-\d+$/.test(e.name)) await rm(join(e.parentPath, e.name))
  }
}
