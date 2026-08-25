/**
 * Server-side session store for the web UI (plan §3.3).
 *
 * The shape of this is a security decision, not a convenience one:
 *
 * > Backend performs the login, keeps the resulting cookie jar **server-side
 * > only** with a 1–2 hour TTL, and hands the browser a random session ID.
 * > Nothing is persisted to disk.
 *
 * So the browser never holds ACSM credentials or an ACSM cookie — only an
 * opaque handle to a jar it cannot read. And because the store is memory only,
 * a restart logs everyone out, which is the correct trade: an admin password
 * that survives a redeploy on disk is a worse problem than logging in again.
 *
 * Permissions are whatever ACSM says they are. There is no role model here on
 * purpose — if the person can't write championships in ACSM, the write fails
 * in ACSM, and champctl has not invented an authorization system that could
 * disagree with it.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

import type { AcsmSession } from "../acsm/session.js"

/** 1–2 hours per plan §3.3; the low end, since re-login is one form. */
export const DEFAULT_TTL_MS = 60 * 60 * 1000

/**
 * 32 bytes from a CSPRNG, base64url. The ID is the only thing standing between
 * an attacker and someone's ACSM admin rights, so it is full-entropy random
 * rather than anything derived, sequential, or guessable.
 */
export function newSessionId(): string {
  return randomBytes(32).toString("base64url")
}

export interface StoredSession {
  id: string
  username: string
  acsm: AcsmSession
  createdAt: number
  expiresAt: number
}

/** What a caller may safely see. Deliberately excludes the cookie jar. */
export interface SessionInfo {
  username: string
  createdAt: number
  expiresAt: number
}

export interface SessionStoreOptions {
  ttlMs?: number
  now?: () => number
  /** Refuse to hold more than this many at once. */
  maxSessions?: number
}

export class SessionStore {
  readonly #byId = new Map<string, StoredSession>()
  readonly #ttlMs: number
  readonly #now: () => number
  readonly #max: number

  constructor(options: SessionStoreOptions = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.#now = options.now ?? Date.now
    this.#max = options.maxSessions ?? 1000
  }

  get size(): number {
    return this.#byId.size
  }

  /**
   * Stores a logged-in ACSM session and returns its handle.
   *
   * Sweeps first, so a long-running process doesn't accumulate expired jars
   * holding live cookies — the point of a TTL is that the credential stops
   * existing, and it can't do that while a reference survives.
   */
  create(username: string, acsm: AcsmSession): string {
    this.sweep()
    if (this.#byId.size >= this.#max) {
      throw new Error(
        `Refusing to hold more than ${this.#max} sessions at once. Something is creating them ` +
          `without logging out, and each one holds a live ACSM cookie.`,
      )
    }

    const now = this.#now()
    const id = newSessionId()
    this.#byId.set(id, {
      id,
      username,
      acsm,
      createdAt: now,
      expiresAt: now + this.#ttlMs,
    })
    return id
  }

  /**
   * The session for an ID, or undefined.
   *
   * Expiry is enforced here rather than only by the sweep, so a session is
   * never usable past its TTL just because nothing has swept recently.
   */
  get(id: string | undefined): StoredSession | undefined {
    if (!id) return undefined
    const found = this.#byId.get(id)
    if (!found) return undefined
    if (this.#now() >= found.expiresAt) {
      this.destroy(id)
      return undefined
    }
    return found
  }

  /** Metadata only — never hands out the cookie jar. */
  info(id: string | undefined): SessionInfo | undefined {
    const s = this.get(id)
    if (!s) return undefined
    return { username: s.username, createdAt: s.createdAt, expiresAt: s.expiresAt }
  }

  /**
   * Ends a session and clears its ACSM cookies.
   *
   * Dropping the map entry alone would leave the jar to the garbage collector
   * with the cookie still in it. Clearing is what makes "log out" mean the
   * credential is gone.
   */
  destroy(id: string | undefined): boolean {
    if (!id) return false
    const found = this.#byId.get(id)
    if (!found) return false
    this.#byId.delete(id)
    try {
      found.acsm.jar.clear()
    } catch {
      // A jar that won't clear must not stop the session being dropped.
    }
    return true
  }

  /** Drops everything expired. Safe to call on a timer. */
  sweep(): number {
    const now = this.#now()
    let dropped = 0
    for (const [id, s] of [...this.#byId]) {
      if (now >= s.expiresAt) {
        this.destroy(id)
        dropped++
      }
    }
    return dropped
  }

  /** Ends every session — for shutdown, so no jar outlives the process idly. */
  clear(): void {
    for (const id of [...this.#byId.keys()]) this.destroy(id)
  }
}

/**
 * Compares two session IDs so that the *comparison* reveals neither how much
 * of them matched nor whether their lengths differed.
 *
 * That is the whole claim, stated narrowly on purpose, because the obvious
 * looser version — "constant time" — would be false.
 *
 * `timingSafeEqual` alone can't manage even this much: it throws on differing
 * lengths, so the usual wrapper returns early, and an early return is
 * observably not constant time. Hashing both inputs first sidesteps that. The
 * digests are always 32 bytes, so exactly one comparison of one fixed size
 * happens whatever came in, and a hash reveals nothing about its input.
 *
 * **The function as a whole is not constant time.** SHA-256 is linear in its
 * input, so a ten-kilobyte argument takes measurably longer than a short one.
 * What that reveals is the length of the value the *caller* passed, which an
 * attacker passing it already knows. The stored ID's own length is fixed at 43
 * characters, structural, and visible to anyone holding a cookie, so there is
 * nothing left there to leak. Don't reach for this to compare secrets whose
 * length is itself sensitive — it would not hide that.
 *
 * The `Map` lookup in `SessionStore.get` is the normal path and is *not*
 * constant time either. Separate, deliberate judgement: these IDs are 256 bits
 * of CSPRNG output, so there is no prefix an attacker can walk toward one
 * character at a time.
 */
export function sameSessionId(a: string, b: string): boolean {
  const ah = createHash("sha256").update(a, "utf8").digest()
  const bh = createHash("sha256").update(b, "utf8").digest()
  return timingSafeEqual(ah, bh)
}

/**
 * Cookie attributes for the handle.
 *
 * `httpOnly` so script can't read it, `secure` because the plan requires HTTPS
 * (this forwards admin credentials between hosts), `sameSite=lax` so a
 * cross-site form post can't ride the session while ordinary navigation still
 * works.
 */
export const SESSION_COOKIE = "champctl_session"

export function sessionCookieAttributes(ttlMs: number = DEFAULT_TTL_MS): string {
  return `Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(ttlMs / 1000)}`
}
