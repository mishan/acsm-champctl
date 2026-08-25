/**
 * Failed-login throttle.
 *
 * champctl's login endpoint forwards whatever it is given to a league's ACSM
 * and reports back whether it worked. Unthrottled, that is a credential-testing
 * oracle for the league's admin panel that also launders the attacker's address
 * — every attempt reaches ACSM from champctl's host, so the manager's own logs
 * show one busy client rather than whoever is guessing. ACSM's documented rate
 * limit doesn't help here; that governs the public read API, not `/login`.
 *
 * Deliberately small. It counts *failures* per address and refuses for a while
 * once there have been too many, and a success clears the count — so someone
 * mistyping their password three times pays nothing, and someone working
 * through a word list stops being able to ask.
 *
 * What it is not: a defence against a distributed attempt, which needs a real
 * account lockout in ACSM rather than a counter here. It is the speed bump that
 * makes the single-source version not worth running.
 */

export interface LoginThrottleOptions {
  /** Failures before an address is refused. Default 5. */
  maxFailures?: number
  /** Failures older than this stop counting. Default 15 minutes. */
  windowMs?: number
  /** How long a refusal lasts once triggered. Default 15 minutes. */
  cooldownMs?: number
  now?: () => number
  /** Refuse to track more addresses than this, so the map can't grow forever. */
  maxTracked?: number
}

interface Record_ {
  failures: number[]
  blockedUntil: number
}

export class LoginThrottle {
  readonly #byKey = new Map<string, Record_>()
  readonly #maxFailures: number
  readonly #windowMs: number
  readonly #cooldownMs: number
  readonly #now: () => number
  readonly #maxTracked: number

  constructor(options: LoginThrottleOptions = {}) {
    this.#maxFailures = options.maxFailures ?? 5
    this.#windowMs = options.windowMs ?? 15 * 60_000
    this.#cooldownMs = options.cooldownMs ?? 15 * 60_000
    this.#now = options.now ?? Date.now
    this.#maxTracked = options.maxTracked ?? 10_000
  }

  /**
   * Milliseconds until this address may try again, or 0 if it may now.
   *
   * Drops the record on the way out when there is nothing left to remember.
   * This is the hot path — it runs on every login attempt, where `fail` runs
   * only on the ones that fail — so leaving expired records for `fail`'s sweep
   * to collect meant the map filled up with addresses that had one bad
   * afternoon and never came back.
   */
  retryAfterMs(key: string): number {
    const rec = this.#byKey.get(key)
    if (!rec) return 0
    const now = this.#now()
    if (rec.blockedUntil > now) return rec.blockedUntil - now
    if (this.#expired(rec, now)) this.#byKey.delete(key)
    return 0
  }

  /**
   * Records a failure, and starts a cooldown once there have been enough.
   *
   * Failures outside the window are dropped as they are counted rather than on
   * a timer, so the window really does slide and an address is not penalised
   * for a bad afternoon last week.
   */
  fail(key: string): void {
    const now = this.#now()
    this.#sweep(now)

    const rec = this.#byKey.get(key) ?? { failures: [], blockedUntil: 0 }
    if (!this.#byKey.has(key)) {
      // Full: stop tracking new addresses rather than evict, since evicting is
      // exactly what an attacker would arrange by cycling source addresses.
      // The existing entries stay honest, and the sweep above keeps the map
      // turning over.
      if (this.#byKey.size >= this.#maxTracked) return
      this.#byKey.set(key, rec)
    }

    rec.failures = rec.failures.filter((t) => now - t < this.#windowMs)
    rec.failures.push(now)
    if (rec.failures.length >= this.#maxFailures) {
      rec.blockedUntil = now + this.#cooldownMs
      rec.failures = []
    }
  }

  /** A login that worked. Clears the address's history entirely. */
  succeed(key: string): void {
    this.#byKey.delete(key)
  }

  get size(): number {
    return this.#byKey.size
  }

  /**
   * Drops every record with nothing left to remember.
   *
   * Iterates the Map directly rather than a copy of it. Deleting the current
   * entry mid-iteration is defined behaviour, and this runs on every failed
   * login — which is to say, most often in exactly the situation the throttle
   * exists for, where copying the whole map per attempt is the wrong thing to
   * be spending.
   */
  #sweep(now: number): void {
    for (const [key, rec] of this.#byKey) {
      if (this.#expired(rec, now)) this.#byKey.delete(key)
    }
  }

  /** Nothing left to remember: not blocked, and no failure still in the window. */
  #expired(rec: Record_, now: number): boolean {
    return rec.blockedUntil <= now && rec.failures.every((t) => now - t >= this.#windowMs)
  }
}
