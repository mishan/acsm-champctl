import { describe, expect, it } from "vitest"

import { AcsmSession } from "../src/acsm/session.js"
import {
  DEFAULT_TTL_MS,
  newSessionId,
  sameSessionId,
  SESSION_COOKIE,
  SessionStore,
  sessionCookieAttributes,
} from "../src/web/sessions.js"

/** A logged-in-looking session, without a network. */
function acsm(): AcsmSession {
  const s = new AcsmSession({
    baseUrl: "https://acsm.example",
    fetch: async () => new Response("", { status: 200 }),
    // Nothing here is a server, and a test that quietly waits out a rate-limit
    // window looks like a hang rather than a failure.
    rateLimit: false,
  })
  s.jar.set("_acsm_data", "secret-cookie-value")
  return s
}

describe("session ids", () => {
  it("are long, random and URL-safe", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newSessionId()))
    expect(ids.size).toBe(200)
    for (const id of ids) {
      // 32 bytes base64url.
      expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/)
    }
  })

  it("compares correctly whatever the lengths", () => {
    // timingSafeEqual throws outright on differing lengths, so the shape of
    // this function is entirely about not needing an early return for that.
    // The timing property itself isn't asserted here — a wall-clock assertion
    // would be flaky and would prove very little on a JIT.
    const a = newSessionId()
    expect(sameSessionId(a, a)).toBe(true)
    expect(sameSessionId(a, newSessionId())).toBe(false)
    expect(sameSessionId(a, "short")).toBe(false)
    expect(sameSessionId(a, "")).toBe(false)
    expect(sameSessionId("", "")).toBe(true)
    expect(sameSessionId(a, "b".repeat(a.length))).toBe(false)
    expect(sameSessionId(a, "b".repeat(10_000))).toBe(false)
  })

  it("distinguishes ids that differ only in the last character", () => {
    // A digest comparison must not collapse near-misses.
    const a = `${"A".repeat(42)}b`
    const b = `${"A".repeat(42)}c`
    expect(sameSessionId(a, b)).toBe(false)
  })

  it("handles non-ASCII without throwing on a byte-length mismatch", () => {
    // "é" is two UTF-8 bytes but one JS character, which is exactly the case
    // that trips a length check done on the string rather than the buffer.
    expect(sameSessionId("é", "e")).toBe(false)
    expect(sameSessionId("é", "é")).toBe(true)
  })
})

describe("session store", () => {
  const clock = (start: number) => {
    let t = start
    return { now: () => t, advance: (ms: number) => (t += ms) }
  }

  it("hands back a handle, never the jar", () => {
    const store = new SessionStore()
    const id = store.create("admin", acsm())

    const info = store.info(id)
    expect(info).toMatchObject({ username: "admin" })
    // The browser-facing view has no way to reach an ACSM cookie.
    expect(JSON.stringify(info)).not.toContain("secret-cookie-value")
  })

  it("expires a session on read, not only on sweep", () => {
    // Otherwise a session outlives its TTL simply because nothing swept.
    const c = clock(1_000)
    const store = new SessionStore({ ttlMs: 60_000, now: c.now })
    const id = store.create("admin", acsm())

    c.advance(59_999)
    expect(store.get(id)).toBeDefined()
    c.advance(2)
    expect(store.get(id)).toBeUndefined()
  })

  it("clears the ACSM cookies when a session ends", () => {
    // Dropping the map entry alone leaves the jar to the GC with a live
    // cookie in it. "Log out" has to mean the credential is gone.
    const store = new SessionStore()
    const session = acsm()
    const id = store.create("admin", session)

    expect(session.jar.get("_acsm_data")).toBe("secret-cookie-value")
    expect(store.destroy(id)).toBe(true)
    expect(session.jar.get("_acsm_data")).toBeUndefined()
    expect(store.get(id)).toBeUndefined()
  })

  it("clears the jar when a session expires too, not just on logout", () => {
    const c = clock(0)
    const store = new SessionStore({ ttlMs: 1000, now: c.now })
    const session = acsm()
    const id = store.create("admin", session)

    c.advance(1001)
    expect(store.get(id)).toBeUndefined()
    expect(session.jar.get("_acsm_data")).toBeUndefined()
  })

  it("sweeps expired sessions and leaves live ones", () => {
    const c = clock(0)
    const store = new SessionStore({ ttlMs: 1000, now: c.now })
    store.create("old", acsm())
    c.advance(900)
    store.create("new", acsm())
    c.advance(200) // old is now 1100ms, new is 200ms

    expect(store.sweep()).toBe(1)
    expect(store.size).toBe(1)
  })

  it("refuses to accumulate sessions without bound", () => {
    // Each one holds a live ACSM cookie, so unbounded growth is a credential
    // leak with extra steps.
    const store = new SessionStore({ maxSessions: 2 })
    store.create("a", acsm())
    store.create("b", acsm())
    expect(() => store.create("c", acsm())).toThrow(/more than 2 sessions/)
  })

  it("makes room by sweeping before refusing", () => {
    const c = clock(0)
    const store = new SessionStore({ ttlMs: 1000, maxSessions: 2, now: c.now })
    store.create("a", acsm())
    store.create("b", acsm())
    c.advance(1001)
    expect(() => store.create("c", acsm())).not.toThrow()
    expect(store.size).toBe(1)
  })

  it("ends everything on clear, clearing each jar", () => {
    const store = new SessionStore()
    const sessions = [acsm(), acsm()]
    for (const s of sessions) store.create("admin", s)

    store.clear()
    expect(store.size).toBe(0)
    for (const s of sessions) expect(s.jar.get("_acsm_data")).toBeUndefined()
  })

  it("treats a missing or unknown id as no session", () => {
    const store = new SessionStore()
    expect(store.get(undefined)).toBeUndefined()
    expect(store.get("")).toBeUndefined()
    expect(store.get("not-a-real-id")).toBeUndefined()
    expect(store.destroy(undefined)).toBe(false)
  })
})

describe("the session cookie", () => {
  it("is httpOnly, Secure and SameSite=Lax", () => {
    // httpOnly so script can't read it; Secure because this forwards admin
    // credentials between hosts; Lax so a cross-site POST can't ride it.
    const attrs = sessionCookieAttributes()
    expect(attrs).toContain("HttpOnly")
    expect(attrs).toContain("Secure")
    expect(attrs).toContain("SameSite=Lax")
    expect(attrs).toContain(`Max-Age=${DEFAULT_TTL_MS / 1000}`)
    expect(SESSION_COOKIE).toBe("champctl_session")
  })

  it("drops only Secure when a localhost dev server asks it to", () => {
    // A browser will not store a `Secure` cookie from `http://localhost`, so
    // without this there is no way to develop against the real login flow. The
    // risk is that the escape hatch quietly takes the other protections with
    // it, which is what this pins: HttpOnly and SameSite are not negotiable.
    const attrs = sessionCookieAttributes(DEFAULT_TTL_MS, { secure: false })
    expect(attrs).not.toContain("Secure")
    expect(attrs).toContain("HttpOnly")
    expect(attrs).toContain("SameSite=Lax")
    expect(attrs).toContain("Path=/")
  })

  it("keeps Secure unless it was asked for explicitly", () => {
    // The direction this has to fail in is "refuses to work over plain HTTP",
    // never "quietly sends an admin session in the clear" — so anything that
    // isn't a deliberate `false` leaves the attribute on.
    expect(sessionCookieAttributes(DEFAULT_TTL_MS, {})).toContain("Secure")
    expect(sessionCookieAttributes(DEFAULT_TTL_MS, { secure: true })).toContain("Secure")
  })
})
