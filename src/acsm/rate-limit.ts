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
