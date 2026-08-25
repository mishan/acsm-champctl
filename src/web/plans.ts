/**
 * Server-side store for finalize plans.
 *
 * A browser previews a change and then pushes it, which is two HTTP requests
 * where the CLI has one process. What sits between them is not a convenience
 * cache — three separate properties depend on the plan never leaving this
 * process.
 *
 * **The entry-list guard only means something if the plan is held.**
 * `planFinalize` fingerprints the entry list as rendered, and `applyFinalize`
 * re-fetches the form and compares. That guard exists because ACSM's event form
 * replaces the whole entry list, so a sign-up approved while a preview is open
 * would be silently deleted by the save (plan §5.3). If the browser handed back
 * a format and the server re-planned at push time, the fingerprint would be
 * taken one round trip before it was compared, and the check would be comparing
 * a form against itself. The window has to span the human's thinking time, or
 * it isn't the window that matters.
 *
 * **Apply takes a plan id and nothing else.** Not a format, not a quali time.
 * So what gets posted is exactly what was previewed and approved, and a client
 * cannot push a change no one ever saw. A re-plan-on-apply design has to trust
 * the body twice and can only hope the second read matches the first.
 *
 * **A plan holds the parsed event form**, which is every entrant's name, Steam
 * GUID, car and pit box. That does not belong in a browser, and `planView` is
 * what decides the much smaller thing that does.
 *
 * Memory only, same as `SessionStore` and for the same reason: a plan is a
 * live ACSM read tied to one person's credentials, and it should stop existing
 * when the process does.
 */

import { randomBytes } from "node:crypto"

import { sameSessionId } from "./sessions.js"

/**
 * Shorter than a session's hour.
 *
 * Not a safety boundary — the fingerprint check is what stops a stale plan
 * eating an entrant, and it works however old the plan is. This is about the
 * preview going stale in ways the guard doesn't cover: gridmom findings, the
 * "before" side of the diff, and whether the round has since been run. Fifteen
 * minutes is longer than the flow this is built for ("under a minute, from a
 * Discord poll result") and short enough that a tab left open overnight asks
 * for a fresh look rather than pushing yesterday's opinion.
 */
export const DEFAULT_PLAN_TTL_MS = 15 * 60 * 1000

export interface StoredPlan<T> {
  id: string
  /** The session that created it. Only that session may apply it. */
  sessionId: string
  plan: T
  createdAt: number
  expiresAt: number
  /**
   * True between `acquire` and its matching `release` or `destroy`.
   *
   * A plan is a licence to POST an event form once. `get` only reads, so two
   * requests could both read the same plan before either finished writing —
   * see `acquire`.
   */
  inFlight: boolean
}

/**
 * The outcome of trying to take a plan for applying.
 *
 * A discriminated result rather than `undefined`, because the caller has to
 * tell three cases apart and they mean different things to a person: the plan
 * is gone, someone else is already pushing it, or here it is.
 */
export type PlanAcquisition<T> =
  | { kind: "acquired"; plan: T }
  | { kind: "not-found" }
  | { kind: "in-flight" }

export interface PlanStoreOptions {
  /**
   * What these are, for the message when the store fills up.
   *
   * Diagnosing "refusing to hold more than 2000" means knowing *which* store
   * ran out, and with two of them the noun is the one thing the message cannot
   * supply for itself — the store is generic and has never seen what `T` is.
   *
   * That is also why the message says nothing about what a plan *holds*. A
   * finalize plan holds a parsed event form; a new-championship plan holds an
   * emitted championship. One sentence describing both would be wrong about
   * one of them, so it describes neither and names them instead.
   */
  label?: string
  ttlMs?: number
  now?: () => number
  maxPlans?: number
}

/** 32 bytes of CSPRNG, base64url — the same reasoning as a session id. */
export function newPlanId(): string {
  return randomBytes(32).toString("base64url")
}

/**
 * A single-use, session-owned lease over something computed and then confirmed.
 *
 * Generic over what is held because there are two of these and they want
 * identical guarantees for different reasons. A finalize plan is a licence to
 * POST one event form; a new-championship plan is a licence to import one
 * championship, where spending it twice leaves a league two of them to tell
 * apart and delete by hand. The
 * TTL, the ownership check and the in-flight flag are the same argument in both
 * cases, and a second copy of them is a second place for the argument to be
 * got wrong.
 */
export class PlanStore<T> {
  readonly #byId = new Map<string, StoredPlan<T>>()
  readonly #ttlMs: number
  readonly #now: () => number
  readonly #max: number
  readonly #label: string

  constructor(options: PlanStoreOptions = {}) {
    this.#label = options.label ?? "plans"
    this.#ttlMs = options.ttlMs ?? DEFAULT_PLAN_TTL_MS
    this.#now = options.now ?? Date.now
    this.#max = options.maxPlans ?? 2000
  }

  get size(): number {
    return this.#byId.size
  }

  /**
   * Stores a plan against the session that produced it.
   *
   * Sweeps first. Previewing is cheap and people re-preview on every keystroke
   * they change, so without this a busy afternoon accumulates a parsed entry
   * list per edit — each one holding driver names and Steam GUIDs long after
   * anyone could act on it.
   */
  create(sessionId: string, plan: T): string {
    this.sweep()
    if (this.#byId.size >= this.#max) {
      throw new Error(
        `Refusing to hold more than ${this.#max} ${this.#label} at once. Something is previewing ` +
          `without ever confirming, and each one is held in memory until it is spent or expires.`,
      )
    }

    const now = this.#now()
    const id = newPlanId()
    this.#byId.set(id, {
      id,
      sessionId,
      plan,
      createdAt: now,
      expiresAt: now + this.#ttlMs,
      inFlight: false,
    })
    return id
  }

  /**
   * The plan for an id, if this session owns it and it hasn't expired.
   *
   * Ownership is checked rather than assumed. A plan is the product of one
   * person's authenticated read, and applying it posts a form fetched with
   * *their* cookies — so another session holding the id must not be able to
   * spend it. Compared with `sameSessionId` for the same reason session lookup
   * is: the comparison should not report how much of the value matched.
   */
  get(id: string | undefined, sessionId: string): T | undefined {
    return this.#owned(id, sessionId)?.plan
  }

  /**
   * Takes a plan for applying, and marks it as in flight.
   *
   * `get` is a read and reserves nothing, so two `/apply` requests for the same
   * plan could both pass it before either had written anything: both would go
   * on to POST the same event form, and the plan was only destroyed afterwards.
   * On a full-form replace that is two writes racing over one entry list, from
   * a double-click or a retried request.
   *
   * The check and the set here happen with no `await` between them, which is
   * what makes this atomic on a single-threaded runtime — the next request
   * cannot be dispatched in the gap. That is a real guarantee rather than a
   * hopeful one, and it is the reason this is a synchronous method.
   *
   * Every acquisition must be ended: `destroy` when the plan is spent or can
   * never succeed, `release` when the refusal is one the person can act on and
   * retry — an unacknowledged warning being the normal case.
   */
  acquire(id: string | undefined, sessionId: string): PlanAcquisition<T> {
    const found = this.#owned(id, sessionId)
    if (!found) return { kind: "not-found" }
    if (found.inFlight) return { kind: "in-flight" }
    found.inFlight = true
    return { kind: "acquired", plan: found.plan }
  }

  /**
   * Ends an acquisition without spending the plan, so it can be applied again.
   *
   * For refusals the person can do something about — ticking the acknowledge
   * box being the one that matters. Making them rebuild the preview to
   * acknowledge a warning would be a reason to stop reading warnings.
   */
  release(id: string | undefined, sessionId: string): void {
    const found = this.#owned(id, sessionId)
    if (found) found.inFlight = false
  }

  /**
   * Drops a plan once it has been spent.
   *
   * Applying twice would re-post a format that is already applied, which is
   * harmless in itself and misleading in every log it appears in. Dropping it
   * makes the second attempt a plain "that plan is gone, take another look".
   */
  destroy(id: string | undefined, sessionId: string): boolean {
    const found = this.#owned(id, sessionId)
    if (!found) return false
    return this.#byId.delete(found.id)
  }

  /** Ends every plan a session owns. Called on logout. */
  dropForSession(sessionId: string): number {
    let dropped = 0
    for (const [id, p] of [...this.#byId]) {
      if (sameSessionId(p.sessionId, sessionId)) {
        this.#byId.delete(id)
        dropped++
      }
    }
    return dropped
  }

  sweep(): number {
    const now = this.#now()
    let dropped = 0
    for (const [id, p] of [...this.#byId]) {
      if (now >= p.expiresAt) {
        this.#byId.delete(id)
        dropped++
      }
    }
    return dropped
  }

  clear(): void {
    this.#byId.clear()
  }

  /**
   * The stored plan for an id, if this session owns it.
   *
   * Every method that reads or changes a plan's state goes through here.
   * `release` and `destroy` used to look the plan up without checking, which
   * made them the two ways a leaked or mixed-up id could reach across
   * sessions — clearing another person's in-flight flag mid-apply, or dropping
   * a preview they were still reading. Neither is reachable through the
   * handlers as written, which is exactly why it needed to be enforced here
   * rather than left to each caller to remember.
   */
  #owned(id: string | undefined, sessionId: string): StoredPlan<T> | undefined {
    const found = this.#lookup(id)
    if (!found) return undefined
    if (!sameSessionId(found.sessionId, sessionId)) return undefined
    return found
  }

  #lookup(id: string | undefined): StoredPlan<T> | undefined {
    if (!id) return undefined
    const found = this.#byId.get(id)
    if (!found) return undefined
    // Enforced on read as well as by the sweep, so a plan is never usable past
    // its TTL just because nothing has swept recently.
    if (this.#now() >= found.expiresAt) {
      this.#byId.delete(id)
      return undefined
    }
    return found
  }
}
