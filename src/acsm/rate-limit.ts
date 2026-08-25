/**
 * Sliding-window rate limiter.
 *
 * ACSM's documented limit is 5 requests per 20 seconds and the docs recommend
 * staying under twice a minute (plan §3.1). We default to the documented limit
 * and let callers dial it down; nothing in this tool needs to go fast.
 */

export interface RateLimiterOptions {
  /** Requests allowed per window. */
  limit?: number
  /** Window length in milliseconds. */
  windowMs?: number
  /** Injectable for tests. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export const ACSM_RATE_LIMIT = { limit: 5, windowMs: 20_000 } as const

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export class RateLimiter {
  readonly #limit: number
  readonly #windowMs: number
  readonly #now: () => number
  readonly #sleep: (ms: number) => Promise<void>
  #timestamps: number[] = []
  /** Serialises acquisition so concurrent callers can't both slip through. */
  #queue: Promise<void> = Promise.resolve()

  constructor(options: RateLimiterOptions = {}) {
    this.#limit = options.limit ?? ACSM_RATE_LIMIT.limit
    this.#windowMs = options.windowMs ?? ACSM_RATE_LIMIT.windowMs

    // A limit of zero is not "block everything", it is a hang: the wait loop
    // reads `#timestamps[0]` to decide how long to sleep, and with nothing
    // ever admitted that is undefined, so the sleep is NaN and the loop spins
    // as fast as the event loop allows. Whatever a caller meant by 0, they did
    // not mean that — and a limiter is exactly the thing nobody watches while
    // it works.
    if (!Number.isInteger(this.#limit) || this.#limit < 1) {
      throw new RangeError(
        `A rate limit must be a whole number of requests per window, at least 1; got ` +
          `${String(options.limit)}. Pass rateLimit: false to a reader to turn limiting off.`,
      )
    }
    if (!Number.isFinite(this.#windowMs) || this.#windowMs <= 0) {
      throw new RangeError(`A rate-limit window must be a positive number of milliseconds`)
    }
    this.#now = options.now ?? (() => Date.now())
    this.#sleep = options.sleep ?? defaultSleep
  }

  /** Resolves when it is safe to make one more request. */
  acquire(): Promise<void> {
    const next = this.#queue.then(() => this.#waitForSlot())
    // Keep the chain alive even if a caller's work rejects later.
    this.#queue = next.catch(() => undefined)
    return next
  }

  async #waitForSlot(): Promise<void> {
    for (;;) {
      const now = this.#now()
      this.#timestamps = this.#timestamps.filter((t) => now - t < this.#windowMs)
      if (this.#timestamps.length < this.#limit) {
        this.#timestamps.push(now)
        return
      }
      const oldest = this.#timestamps[0]!
      await this.#sleep(Math.max(1, this.#windowMs - (now - oldest)))
    }
  }
}
