/**
 * The installed-content index, read once and held.
 *
 * `listContent` is by far the most expensive read champctl makes: `/cars` pages
 * at fifty and offers no way to ask for more — measured, `size`, `limit`,
 * `pageSize` and `perPage` are all ignored — so a stock install is four
 * requests plus `/tracks`, and a league running mod content is more. There is
 * no response cache behind it either, because that one holds decoded JSON and
 * these are HTML.
 *
 * **That cost is why this class exists, and getting it wrong was visible.**
 * Against a read budget of five per twenty seconds, a walk started when a
 * screen opened took every slot in the window, and the `/api/championships`
 * request the same screen makes queued behind it — so opening the create
 * screen hung the list of championships next to it. Three things follow, and
 * all three are about never making a person wait on this:
 *
 * - It is held for an hour. Content changes when an admin installs a car,
 *   which happens between seasons rather than between page loads.
 * - Once stale it is *still served*, and refreshed behind whoever asked.
 *   Waiting for the refresh would put the whole cost back on somebody once an
 *   hour at random.
 * - `warm()` starts the first read at boot, so the one load that genuinely has
 *   nothing to serve happens while nobody is looking at it.
 *
 * The other half of the fix is not here: `champctl-serve` gives this its own
 * reader with its own rate limiter, so a walk cannot take slots an interactive
 * read is waiting for.
 *
 * Held in memory, and optionally written through to a `store` so a restart
 * does not start from nothing — `champctl-serve` passes one backed by the
 * response cache's database. Without a store this is memory only, and every
 * boot re-reads; `warm()` is what keeps that off the first click either way.
 */

import type { InstalledContent } from "../acsm/content.js"

const DEFAULT_TTL_MS = 60 * 60 * 1000

/**
 * Somewhere to keep the index across restarts.
 *
 * An interface rather than a path, so the tests do not need a filesystem and
 * so an on-host deployment could keep it wherever it likes.
 */
export interface ContentStore<T = InstalledContent> {
  read(): Promise<{ at: number; value: T } | undefined>
  write(entry: { at: number; value: T }): Promise<void>
}

export interface ContentCacheOptions<T = InstalledContent> {
  /**
   * How to read it, when that can be decided up front.
   *
   * Optional because it cannot always be. The cars-and-tracks index reads
   * without credentials, so `champctl-serve` builds its loader at boot and
   * `warm()` runs it there. The layout index comes off an event edit form,
   * which ACSM only serves to a logged-in session — and this process holds no
   * credentials of its own, by design. That loader can only be built from the
   * session of whoever is asking, so it arrives at `get()` instead.
   */
  load?: () => Promise<T>
  /** Persists the index across restarts. Without one, every boot re-reads. */
  store?: ContentStore<T>
  ttlMs?: number
  now?: () => number
}

export class ContentCache<T = InstalledContent> {
  readonly #load: (() => Promise<T>) | undefined
  readonly #store: ContentStore<T> | undefined
  readonly #ttlMs: number
  readonly #now: () => number
  #held: { at: number; value: T } | undefined
  #inFlight: Promise<T> | undefined

  constructor(options: ContentCacheOptions<T> = {}) {
    this.#load = options.load
    this.#store = options.store
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.#now = options.now ?? Date.now
  }

  async get(load?: () => Promise<T>): Promise<T> {
    const held = this.#held
    if (held && this.#now() - held.at < this.#ttlMs) return held.value

    // Stale is served, and refreshed behind whoever asked.
    //
    // Waiting for the refresh would put the whole cost back on a person, once
    // an hour, at random — and an hour-old list of installed cars is wrong
    // only if somebody installed one in the last hour. The first load has
    // nothing to serve and does have to wait; `warm()` is how that stops
    // landing on a person.
    const refresh = this.#refresh(load)
    return held ? held.value : refresh
  }

  /**
   * Take whatever the last run left, then start a read behind it.
   *
   * Called at startup, and it is what makes a restart free. Without it every
   * restart re-walks `/cars` from nothing, which is minutes on a league with
   * mod content — and the person who restarted is usually the person about to
   * open the screen.
   *
   * Whatever was stored is served immediately even if it is old, because a
   * month-old list of installed cars is a far better answer than a spinner.
   * Failure is not fatal and not rethrown: a manager that is down when
   * champctl boots is one champctl should still start against, and the next
   * `get()` tries again.
   */
  async warm(): Promise<void> {
    try {
      const stored = await this.#store?.read()
      if (stored && !this.#held) this.#held = stored
    } catch {
      // A store that cannot be read is a slow start, not a failed one.
    }
    void this.#refresh().catch(() => undefined)
  }

  #refresh(load?: () => Promise<T>): Promise<T> {
    const read = load ?? this.#load
    if (!read) {
      // A cache with no way to fill itself, asked to fill itself. That is a
      // wiring mistake rather than anything a manager did, so it says so.
      return Promise.reject(
        new Error("This index has no loader: pass one to the constructor or to get()."),
      )
    }
    // One read for however many callers arrive while it is in flight. Two
    // people opening the screen at once is the ordinary case, and without this
    // it is two full walks of `/cars` — which is more requests than the
    // limiter allows in its window, so the second person waits out the first
    // one's rate limiting rather than on their own answer.
    this.#inFlight ??= read()
      .then(async (value) => {
        const entry = { at: this.#now(), value }
        this.#held = entry
        // Best effort, and after the value is already held: a store that
        // cannot be written costs the *next* restart its head start, and
        // failing the request over it would cost this one its answer.
        await this.#store?.write(entry).catch(() => undefined)
        return value
      })
      .finally(() => {
        this.#inFlight = undefined
      })

    return this.#inFlight
  }
}
