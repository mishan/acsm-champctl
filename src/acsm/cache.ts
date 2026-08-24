/**
 * On-disk response cache.
 *
 * Cache everything, and never poll on a timer tighter than the rate limit
 * (plan §3.1). A short TTL is right for the CLI — long enough that re-running
 * gridmom three times while fixing a pit box costs one request, short enough
 * that it still sees your fix.
 */

import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { ResponseCache } from "./client.js"

interface Envelope {
  url: string
  fetchedAt: number
  body: string
}

export interface FileCacheOptions {
  dir: string
  /** Entries older than this are ignored. Default 5 minutes. */
  ttlMs?: number
}

export class FileCache implements ResponseCache {
  readonly #dir: string
  readonly #ttlMs: number

  constructor(options: FileCacheOptions) {
    this.#dir = options.dir
    this.#ttlMs = options.ttlMs ?? 5 * 60_000
  }

  #pathFor(key: string): string {
    return join(this.#dir, `${createHash("sha256").update(key).digest("hex")}.json`)
  }

  async get(key: string): Promise<string | undefined> {
    try {
      const raw = await readFile(this.#pathFor(key), "utf8")
      const env = JSON.parse(raw) as Envelope
      if (Date.now() - env.fetchedAt > this.#ttlMs) return undefined
      return env.body
    } catch {
      // A missing or corrupt entry is a cache miss, never an error.
      return undefined
    }
  }

  async set(key: string, value: string): Promise<void> {
    try {
      await mkdir(this.#dir, { recursive: true })
      const env: Envelope = { url: key, fetchedAt: Date.now(), body: value }
      await writeFile(this.#pathFor(key), JSON.stringify(env), "utf8")
    } catch {
      // Caching is an optimisation; failing to write must not fail the request.
    }
  }
}

/** No-op cache, for when a caller explicitly wants fresh data. */
export const NO_CACHE: ResponseCache = {
  async get() {
    return undefined
  },
  async set() {
    /* no-op */
  },
}
