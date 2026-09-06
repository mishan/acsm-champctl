import { existsSync, readFileSync, readdirSync } from "node:fs"
import { mkdtemp, readdir } from "node:fs/promises"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { unzipSync, zipSync } from "fflate"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { parseArgs, UsageError } from "../src/cli/upload.js"
import { SqliteSubmissionQueue } from "../src/liveries/queue.js"
import {
  DEFAULT_TOKEN_TTL_MS,
  SqliteTokenStore,
  digestToken,
  secretsMatch,
  tokenFromPath,
  UploadTokenError,
  uploadUrl,
} from "../src/liveries/upload-token.js"
import { SqliteLiveryStore } from "../src/liveries/store.js"
import { carsetSlugFromPath, createUploadServer } from "../src/upload/server.js"

const CAR = "rss_formula_hybrid_2021"
const CHAMP = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
const MISHA = "111111111111111111"

const bytes = (s: string) => new TextEncoder().encode(s)
const skin = (extra: Record<string, Uint8Array> = {}) =>
  zipSync({ "livery.dds": bytes("dds"), "preview.jpg": bytes("jpg"), ...extra })

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

  it("only lets one of two simultaneous consumes through", async () => {
    // Both read an unused row; the UPDATE's own `used_at IS NULL` is what makes
    // exactly one of them win.
    const store = await SqliteTokenStore.open(":memory:")
    const minted = await store.mint(grant(), NOW)
    const results = [await store.consume(minted.token, NOW), await store.consume(minted.token, NOW)]
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    store.close()
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

describe("the upload endpoint", () => {
  let server: ReturnType<typeof createUploadServer>
  let tokens: SqliteTokenStore
  let queue: SqliteSubmissionQueue
  let base: string
  let clock = NOW

  beforeAll(async () => {
    tokens = await SqliteTokenStore.open(":memory:")
    queue = await SqliteSubmissionQueue.open(":memory:")
    server = createUploadServer({ tokens, queue, now: () => clock })
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()))
    tokens.close()
    queue.close()
  })

  const mint = async (over = {}) => (await tokens.mint({ ...grant(), ...over }, clock)).token

  it("shows an upload page for a live token", async () => {
    const token = await mint({ discordUserId: "300000000000000001" })
    const res = await fetch(`${base}/u/${token}`)
    const body = await res.text()

    expect(res.status).toBe(200)
    expect(body).toContain("Misha")
    expect(body).toContain(CAR)
    // The URL is a credential; nothing here should be cached or indexed.
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(res.headers.get("x-robots-tag")).toMatch(/noindex/)
  })

  it("does not spend the token when the page is fetched", async () => {
    const token = await mint({ discordUserId: "300000000000000002" })
    await fetch(`${base}/u/${token}`)
    await fetch(`${base}/u/${token}`)
    expect(await tokens.peek(token, clock)).toMatchObject({ ok: true })
  })

  it("accepts a livery and says what happens next", async () => {
    const token = await mint({ discordUserId: "300000000000000003", driverName: "Ann" })
    const res = await fetch(`${base}/u/${token}`, { method: "POST", body: skin() })
    const body = await res.text()

    expect(res.status).toBe(200)
    expect(body).toMatch(/2 files for Ann/)
    expect(body).toMatch(/practice that's running now keeps the old entry list/)
    expect((await queue.queued(CHAMP)).some((s) => s.driverName === "Ann")).toBe(true)
  })

  it("takes the driver and car from the token, not from the request", async () => {
    // The URL carries no "who", so a leaked link uploads for the person it was
    // minted for and nobody else.
    const token = await mint({ discordUserId: "300000000000000004", driverName: "Bob" })
    await fetch(`${base}/u/${token}?driverName=Someone&carModel=ford_transit`, {
      method: "POST",
      body: skin(),
    })
    const queued = (await queue.queued(CHAMP)).find((s) => s.discordUserId === "300000000000000004")
    expect(queued).toMatchObject({ driverName: "Bob", carModel: CAR })
  })

  it("spends the token on a successful upload", async () => {
    const token = await mint({ discordUserId: "300000000000000005", driverName: "Cat" })
    await fetch(`${base}/u/${token}`, { method: "POST", body: skin() })
    const res = await fetch(`${base}/u/${token}`, { method: "POST", body: skin() })
    expect(res.status).toBe(410)
    expect(await res.text()).toMatch(/already been used/)
  })

  it("gives the pack refusal in the driver's own terms", async () => {
    const token = await mint({ discordUserId: "300000000000000006", driverName: "Dee" })
    const res = await fetch(`${base}/u/${token}`, {
      method: "POST",
      body: skin({ "work.psd": bytes("x") }),
    })
    expect(res.status).toBe(400)
    expect(await res.text()).toMatch(/Photoshop source file/)
  })

  it("says the link is spent when it refuses a file", async () => {
    // Keeping it alive would turn one link into an unlimited upload endpoint
    // for as long as the driver kept sending things that failed validation.
    const token = await mint({ discordUserId: "300000000000000007", driverName: "Eve" })
    const res = await fetch(`${base}/u/${token}`, { method: "POST", body: bytes("not a zip") })
    expect(await res.text()).toMatch(/link is spent now/)
    expect(await tokens.peek(token, clock)).toMatchObject({ ok: false, reason: "used" })
  })

  it("explains an expired link and offers the way to get another", async () => {
    const token = await mint({ discordUserId: "300000000000000008" })
    const before = clock
    clock = later(DEFAULT_TOKEN_TTL_MS + 1000)
    const res = await fetch(`${base}/u/${token}`)
    clock = before

    expect(res.status).toBe(410)
    expect(await res.text()).toMatch(/\/livery upload-url/)
  })

  it("has no index and gives nothing away about other paths", async () => {
    for (const path of ["/", "/admin", "/u", "/championship/x/export"]) {
      const res = await fetch(`${base}${path}`)
      expect(res.status).toBe(404)
      expect(await res.text()).toBe("Not found.\n")
    }
  })

  it("refuses a token it has never seen without saying which part was wrong", async () => {
    const res = await fetch(`${base}/u/${"z".repeat(43)}`)
    expect(res.status).toBe(410)
    const body = await res.text()
    expect(body).toMatch(/champctl recognises/)
    // And the message goes through the escaper on the way, so a driver name
    // with a quote or an angle bracket in it cannot become markup.
    expect(body).toContain("isn&#39;t")
  })

  it("escapes the driver name into the page", async () => {
    const token = await mint({
      discordUserId: "300000000000000010",
      driverName: `<script>alert('x')</script>`,
    })
    const body = await fetch(`${base}/u/${token}`).then((r) => r.text())
    expect(body).not.toContain("<script>alert")
    expect(body).toContain("&lt;script&gt;")
  })

  it("refuses a method that isn't GET or POST", async () => {
    const token = await mint({ discordUserId: "300000000000000009" })
    const res = await fetch(`${base}/u/${token}`, { method: "DELETE" })
    expect(res.status).toBe(405)
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
describe("champctl-upload cannot write to ACSM", () => {
  const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src")
  const uploadDir = join(srcDir, "upload")

  const writePath = [
    "acsm/session.js",
    "acsm/write.js",
    "finalize/apply.js",
    "reorder/apply.js",
    "liveries/apply.js",
    "web/",
  ]

  const importsOf = (file: string): string[] =>
    [...readFileSync(file, "utf8").matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] as string)

  const entryPoints = () => [
    ...readdirSync(uploadDir)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => join(uploadDir, f)),
    join(srcDir, "cli", "upload.ts"),
  ]

  it("reaches nothing in the write path, however many hops away", () => {
    const offences: string[] = []
    const seen = new Set<string>()
    const walk = (file: string, trail: string[]): void => {
      if (seen.has(file)) return
      seen.add(file)
      for (const specifier of importsOf(file)) {
        if (writePath.some((w) => specifier.includes(w))) {
          offences.push([...trail, basename(file), specifier].join(" → "))
          continue
        }
        if (!specifier.startsWith(".")) continue
        const next = resolve(dirname(file), specifier.replace(/\.js$/, ".ts"))
        if (existsSync(next)) walk(next, [...trail, basename(file)])
      }
    }
    for (const file of entryPoints()) walk(file, [])
    expect(offences).toEqual([])
  })

  it("holds no Discord token either", () => {
    // It is the third process following the rule: whatever faces something
    // untrusted has nothing worth stealing.
    const seen = new Set<string>()
    const walk = (file: string): void => {
      if (seen.has(file)) return
      seen.add(file)
      for (const specifier of importsOf(file)) {
        expect(specifier).not.toMatch(/discord/)
        if (!specifier.startsWith(".")) continue
        const next = resolve(dirname(file), specifier.replace(/\.js$/, ".ts"))
        if (existsSync(next)) walk(next)
      }
    }
    for (const file of entryPoints()) walk(file)
    expect(seen.size).toBeGreaterThan(entryPoints().length)
  })
})

describe("the champctl-upload CLI", () => {
  it("has no way to be given ACSM credentials", () => {
    expect(() => parseArgs(["--username", "admin"])).toThrow(UsageError)
    expect(() => parseArgs(["--push"])).toThrow(/takes no credentials/)
  })

  it("has no way to be given a Discord token", () => {
    expect(() => parseArgs(["--token", "hunter2"])).toThrow(UsageError)
  })

  it("defaults to localhost, so TLS is somebody else's job and not skipped", () => {
    expect(parseArgs([])).toMatchObject({ host: "127.0.0.1", port: 8477, autoApply: false })
  })

  it("refuses a port that isn't one", () => {
    expect(() => parseArgs(["--port", "banana"])).toThrow(/must be a port number/)
    expect(() => parseArgs(["--port", "70000"])).toThrow(/must be a port number/)
  })
})

/**
 * The other half of the feature (docs/discord-livery-upload.md §6).
 *
 * A livery on the server does nothing for the twenty-nine people who cannot see
 * it, and the carset is every livery at once — so it is, by construction,
 * larger than any single upload. If one driver's zip was too big for Discord
 * the pack certainly is, which is why it cannot be posted in a channel and has
 * to come from here.
 */
describe("downloading the carset", () => {
  let server: ReturnType<typeof createUploadServer>
  let tokens: SqliteTokenStore
  let queue: SqliteSubmissionQueue
  let store: SqliteLiveryStore
  let base: string
  let cacheDir: string
  let slug: string

  const skinFiles = (body: string) => [
    { name: "livery.dds", bytes: bytes(body) },
    { name: "preview.jpg", bytes: bytes("jpg") },
  ]

  beforeAll(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "champctl-carset-cache-"))
    tokens = await SqliteTokenStore.open(":memory:")
    queue = await SqliteSubmissionQueue.open(":memory:")
    store = await SqliteLiveryStore.open(":memory:")
    await store.record(
      CHAMP,
      [
        {
          carModel: CAR,
          driverName: "Misha",
          skinFolder: "Misha",
          files: skinFiles("misha-pixels"),
          totalBytes: 15,
        },
      ],
      NOW,
      "discord",
    )
    slug = await store.carsetLink(CHAMP, NOW)

    server = createUploadServer({ tokens, queue, store, cacheDir, now: () => NOW })
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()))
    store.close()
    tokens.close()
    queue.close()
  })

  it("hands back a zip laid out for Content Manager", async () => {
    const res = await fetch(`${base}/c/${slug}`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("application/zip")

    const entries = unzipSync(new Uint8Array(await res.arrayBuffer()))
    expect(Object.keys(entries)).toContain(`content/cars/${CAR}/skins/Misha/livery.dds`)
  })

  it("names the file so two months' carsets are tellable apart", async () => {
    const res = await fetch(`${base}/c/${slug}`)
    expect(res.headers.get("content-disposition")).toMatch(
      /attachment; filename="carset-[0-9a-f]{8}\.zip"/,
    )
  })

  it("answers a revalidation with 304 and no body", async () => {
    // The whole grid re-checks this before a race night and usually nothing has
    // changed. The digest is over the manifest rather than the archive, so a
    // rebuild does not invalidate everyone's copy.
    const first = await fetch(`${base}/c/${slug}`)
    const etag = first.headers.get("etag") as string
    await first.arrayBuffer()

    const again = await fetch(`${base}/c/${slug}`, { headers: { "if-none-match": etag } })
    expect(again.status).toBe(304)
    expect((await again.arrayBuffer()).byteLength).toBe(0)
  })

  it("changes the tag when somebody's livery lands", async () => {
    const before = (await fetch(`${base}/c/${slug}`)).headers.get("etag")
    await store.record(
      CHAMP,
      [
        {
          carModel: CAR,
          driverName: "postaL",
          skinFolder: "postaL",
          files: skinFiles("postal-pixels"),
          totalBytes: 16,
        },
      ],
      NOW,
      "discord",
    )
    expect((await fetch(`${base}/c/${slug}`)).headers.get("etag")).not.toBe(before)
  })

  it("keeps the link stable as the carset changes, so a pin still works", async () => {
    expect(await store.carsetLink(CHAMP, NOW)).toBe(slug)
  })

  it("caches the built archive on disk rather than in the heap", async () => {
    // A thirty-driver carset is a few hundred megabytes. One in memory per
    // request is how a small box dies on the evening everyone downloads.
    await fetch(`${base}/c/${slug}`).then((r) => r.arrayBuffer())
    expect((await readdir(cacheDir)).some((f) => f.endsWith(".zip"))).toBe(true)
  })

  it("answers HEAD with the size and no body", async () => {
    const res = await fetch(`${base}/c/${slug}`, { method: "HEAD" })
    expect(res.status).toBe(200)
    expect(Number(res.headers.get("content-length"))).toBeGreaterThan(0)
  })

  it("is not indexable", async () => {
    expect((await fetch(`${base}/c/${slug}`)).headers.get("x-robots-tag")).toMatch(/noindex/)
  })

  it("gives nothing away for a slug it doesn't know", async () => {
    const res = await fetch(`${base}/c/${"z".repeat(22)}`)
    expect(res.status).toBe(404)
    expect(await res.text()).toBe("Not found.\n")
  })

  it("refuses to be uploaded to", async () => {
    const res = await fetch(`${base}/c/${slug}`, { method: "POST", body: bytes("x") })
    expect(res.status).toBe(405)
  })

  it("says plainly when a championship has no liveries yet", async () => {
    const empty = await store.carsetLink("11111111-1111-1111-1111-111111111111", NOW)
    const res = await fetch(`${base}/c/${empty}`)
    expect(res.status).toBe(404)
    expect(await res.text()).toMatch(/no carset to download/)
  })
})

describe("carsetSlugFromPath", () => {
  it("reads a slug, with or without a trailing filename", () => {
    expect(carsetSlugFromPath("/c/AbC-123_xyz9876543210")).toBe("AbC-123_xyz9876543210")
    expect(carsetSlugFromPath("/c/AbC-123_xyz9876543210/carset.zip")).toBe("AbC-123_xyz9876543210")
  })

  it("ignores anything else", () => {
    for (const p of ["/c/", "/c/short", "/c/../etc/passwd", "/", "/u/abc"]) {
      expect(carsetSlugFromPath(p)).toBeUndefined()
    }
  })
})
