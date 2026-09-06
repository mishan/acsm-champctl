import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import {
  DEFAULT_TOKEN_TTL_MS,
  SqliteTokenStore,
  digestToken,
  secretsMatch,
  tokenFromPath,
  UploadTokenError,
  uploadUrl,
} from "../src/liveries/upload-token.js"

const CAR = "rss_formula_hybrid_2021"
const CHAMP = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
const MISHA = "111111111111111111"

const grant = () => ({
  discordUserId: MISHA,
  discordHandle: "misha",
  championshipId: CHAMP,
  driverName: "Misha",
  carModel: CAR,
})

const NOW = new Date("2026-09-02T20:00:00.000Z")
const later = (ms: number) => new Date(NOW.getTime() + ms)

describe("upload tokens", () => {
  it("mints something long enough to be unguessable", async () => {
    const store = await SqliteTokenStore.open(":memory:")
    const minted = await store.mint(grant(), NOW)
    // 256 bits, base64url. A counter or a UUID would tell uploads apart and
    // neither is a credential.
    expect(minted.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    store.close()
  })

  it("mints a different token every time", async () => {
    const store = await SqliteTokenStore.open(":memory:")
    const a = await store.mint(grant(), NOW)
    const b = await store.mint({ ...grant(), discordUserId: "2" }, NOW)
    expect(a.token).not.toBe(b.token)
    store.close()
  })

  it("stores the digest, not the token", async () => {
    // The queue database already holds driver names and Discord ids; it should
    // not also be a drawer of live credentials.
    const store = await SqliteTokenStore.open(":memory:")
    const minted = await store.mint(grant(), NOW)
    expect(await store.peek(digestToken(minted.token), NOW)).toMatchObject({ ok: false })
    expect(await store.peek(minted.token, NOW)).toMatchObject({ ok: true })
    store.close()
  })

  it("carries the grant it was minted with", async () => {
    const store = await SqliteTokenStore.open(":memory:")
    const minted = await store.mint(grant(), NOW)
    const looked = await store.peek(minted.token, NOW)
    expect(looked).toMatchObject({ ok: true, grant: { driverName: "Misha", carModel: CAR } })
    store.close()
  })

  /**
   * Discord unfurls links, so its crawler fetches the URL within a second of
   * it being sent. A token that burned on GET would be dead before the driver
   * clicked it — every time, and reading as a broken bot rather than a broken
   * design.
   */
  it("survives being looked at", async () => {
    const store = await SqliteTokenStore.open(":memory:")
    const minted = await store.mint(grant(), NOW)
    await store.peek(minted.token, NOW)
    await store.peek(minted.token, NOW)
    expect(await store.consume(minted.token, NOW)).toMatchObject({ ok: true })
    store.close()
  })

  it("works exactly once", async () => {
    const store = await SqliteTokenStore.open(":memory:")
    const minted = await store.mint(grant(), NOW)
    expect(await store.consume(minted.token, NOW)).toMatchObject({ ok: true })
    expect(await store.consume(minted.token, NOW)).toMatchObject({ ok: false, reason: "used" })
    store.close()
  })

  it("refuses a second process holding the same link", async () => {
    // Two connections to one file, which is the shape that matters: the upload
    // server is one process and a driver with the link open twice is two
    // requests through it.
    //
    // What this does NOT pin is the interleaved case — the UPDATE's own
    // `used_at IS NULL` clause, which is what makes exactly one of two
    // simultaneous consumes win. node:sqlite is synchronous, so nothing inside
    // one Node process can interleave two of them, and the test that used to
    // claim this awaited them one after the other and was a duplicate of "works
    // exactly once" above.
    const dir = await mkdtemp(join(tmpdir(), "champctl-token-"))
    const path = join(dir, "liveries.db")
    const a = await SqliteTokenStore.open(path)
    const b = await SqliteTokenStore.open(path)
    const minted = await a.mint(grant(), NOW)

    const results = await Promise.all([b.consume(minted.token, NOW), a.consume(minted.token, NOW)])

    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.find((r) => !r.ok)).toMatchObject({ reason: "used" })
    a.close()
    b.close()
    await rm(dir, { recursive: true, force: true })
  })

  it("expires", async () => {
    const store = await SqliteTokenStore.open(":memory:")
    const minted = await store.mint(grant(), NOW, 60_000)
    expect(await store.peek(minted.token, later(59_000))).toMatchObject({ ok: true })
    expect(await store.peek(minted.token, later(61_000))).toMatchObject({
      ok: false,
      reason: "expired",
    })
    store.close()
  })

  it("refuses a token it has never seen", async () => {
    const store = await SqliteTokenStore.open(":memory:")
    expect(await store.peek("nope", NOW)).toMatchObject({ ok: false, reason: "unknown" })
    store.close()
  })

  it("invalidates the previous link when a driver asks again", async () => {
    // A driver who asks twice should not leave a spare in their history.
    const store = await SqliteTokenStore.open(":memory:")
    const first = await store.mint(grant(), NOW)
    await store.mint(grant(), NOW)
    expect(await store.peek(first.token, NOW)).toMatchObject({ ok: false, reason: "unknown" })
    store.close()
  })

  it("does not invalidate another driver's link", async () => {
    const store = await SqliteTokenStore.open(":memory:")
    const theirs = await store.mint({ ...grant(), discordUserId: "222222222222222222" }, NOW)
    await store.mint(grant(), NOW)
    expect(await store.peek(theirs.token, NOW)).toMatchObject({ ok: true })
    store.close()
  })

  it("keeps a spent token so 'already used' has an answer", async () => {
    const store = await SqliteTokenStore.open(":memory:")
    const minted = await store.mint(grant(), NOW)
    await store.consume(minted.token, NOW)
    await store.mint(grant(), NOW)
    expect(await store.peek(minted.token, NOW)).toMatchObject({ ok: false, reason: "used" })
    store.close()
  })

  it("prunes what expired long ago", async () => {
    const store = await SqliteTokenStore.open(":memory:")
    await store.mint(grant(), NOW, 60_000)
    expect(await store.forgetExpiredBefore(later(DEFAULT_TOKEN_TTL_MS))).toBe(1)
    store.close()
  })
})

describe("uploadUrl", () => {
  it("builds a link under /u/", () => {
    expect(uploadUrl("https://liveries.example.com", "abc123")).toBe(
      "https://liveries.example.com/u/abc123",
    )
  })

  it("keeps a path prefix, for a league behind a reverse proxy", () => {
    expect(uploadUrl("https://example.com/champctl", "abc")).toBe(
      "https://example.com/champctl/u/abc",
    )
  })

  /**
   * Refuses rather than downgrading. The token travels in the URL, so plain
   * HTTP puts a bearer credential in every proxy log on the way — and a league
   * that has misconfigured this should learn from a failed command, not from a
   * link that worked.
   */
  it("refuses to put a token on plain http", () => {
    expect(() => uploadUrl("http://liveries.example.com", "abc")).toThrow(UploadTokenError)
    expect(() => uploadUrl("http://liveries.example.com", "abc")).toThrow(/has to be https/)
  })

  it("allows http on localhost, for development", () => {
    expect(uploadUrl("http://localhost:8477", "abc")).toBe("http://localhost:8477/u/abc")
    expect(uploadUrl("http://127.0.0.1:8477", "abc")).toBe("http://127.0.0.1:8477/u/abc")
  })
})

describe("tokenFromPath", () => {
  it("reads the token out of the path", () => {
    expect(tokenFromPath("/u/AbC-123_xyz9876543210")).toBe("AbC-123_xyz9876543210")
  })

  it("ignores anything else, so there is no index to find", () => {
    for (const path of ["/", "/u/", "/u/short", "/admin", "/u/../etc/passwd", "/u/a/b"]) {
      expect(tokenFromPath(path)).toBeUndefined()
    }
  })
})

describe("secretsMatch", () => {
  it("compares equal secrets", () => {
    expect(secretsMatch("abcdef", "abcdef")).toBe(true)
  })

  it("rejects different ones without throwing on a length mismatch", () => {
    expect(secretsMatch("abcdef", "abcdeg")).toBe(false)
    expect(secretsMatch("abc", "abcdef")).toBe(false)
  })
})

/**
 * The same rule as the bot, for the same reason.
 *
 * This process is unauthenticated, internet-facing, and takes tens of megabytes
 * from a stranger. `champctl-serve` holds a login, which is exactly why this is
 * not part of it — and "these are separate" is a promise kept by everyone
 * remembering it unless something checks.
 */
