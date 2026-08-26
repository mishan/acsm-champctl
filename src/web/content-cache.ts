/**
 * The installed-content index, read once and held.
 *
 * `listContent` is the most expensive read champctl makes: `/cars` pages at
 * fifty, so a stock install is four requests plus `/tracks`, and there is no
 * response cache behind it because that one holds decoded JSON and these are
 * HTML. Against champctl's own read limiter — five per twenty seconds — a
 * screen that fetched this on every mount would spend twenty seconds waiting
 * for permission champctl gave itself, every time somebody opened it.
 *
 * So it is held for an hour. Content changes when an admin installs a car,
 * which is a thing that happens between seasons rather than between page
 * loads, and the cost of being an hour stale is that a car installed in the
 * last hour is missing from a dropdown until the service is restarted or the
 * hour is up. The cost of not caching is a screen that takes twenty seconds.
 *
 * In memory rather than on disk, unlike the response cache. This is a list of
 * folder names with nothing private in it, but it is also cheap to rebuild and
 * a restart is exactly when you would want it rebuilt.
 */

import type { InstalledContent } from "../acsm/content.js"

const DEFAULT_TTL_MS = 60 * 60 * 1000

export interface ContentCacheOptions {
  load: () => Promise<InstalledContent>
  ttlMs?: number
  now?: () => number
}

export class ContentCache {
  readonly #load: () => Promise<InstalledContent>
  readonly #ttlMs: number
  readonly #now: () => number
  #held: { at: number; value: InstalledContent } | undefined
  #inFlight: Promise<InstalledContent> | undefined

  constructor(options: ContentCacheOptions) {
    this.#load = options.load
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.#now = options.now ?? Date.now
  }

  async get(): Promise<InstalledContent> {
    const held = this.#held
    if (held && this.#now() - held.at < this.#ttlMs) return held.value

    // One read for however many callers arrive while it is in flight. Two
    // people opening the screen at once is the ordinary case, and without this
    // it is two full walks of `/cars` — which is more requests than the
    // limiter allows in its window, so the second person waits on the first
    // one's rate limiting rather than on their own answer.
    this.#inFlight ??= this.#load()
      .then((value) => {
        this.#held = { at: this.#now(), value }
        return value
      })
      .finally(() => {
        this.#inFlight = undefined
      })

    return this.#inFlight
  }
}
