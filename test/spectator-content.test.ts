import { createServer, type IncomingHttpHeaders, type Server } from "node:http"
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { ContentFiles, type ContentFilesOptions } from "../src/spectator/content.js"

const SURFACES = "content/tracks/baku/data/surfaces.ini"
const ACD = "content/cars/ks_mazda_mx5_cup/data.acd"

interface Served {
  status: number
  body?: string
  etag?: string
  type?: string
}

let dir: string
let hand: string
let mirror: string
let http: Server
let base: string
let files: Record<string, Served>
let requests: { path: string; headers: IncomingHttpHeaders }[]
let clock: number
let opened: ContentFiles[]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "content-"))
  hand = join(dir, "hand")
  mirror = join(dir, "mirror")
  await mkdir(hand)
  files = {}
  requests = []
  opened = []
  clock = Date.parse("2026-11-26T00:00:00Z")
  http = createServer((req, res) => {
    requests.push({ path: req.url ?? "", headers: req.headers })
    const f = files[decodeURI(req.url ?? "")]
    if (!f) {
      res.writeHead(404).end("404 page not found")
      return
    }
    if (f.etag && req.headers["if-none-match"] === f.etag) {
      res.writeHead(304).end()
      return
    }
    res
      .writeHead(f.status, {
        "content-type": f.type ?? "text/plain",
        ...(f.etag ? { etag: f.etag } : {}),
      })
      .end(f.body ?? "")
  })
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${(http.address() as { port: number }).port}`
})
afterEach(async () => {
  for (const c of opened) await c.idle()
  await new Promise<void>((r) => http.close(() => r()))
  await rm(dir, { recursive: true, force: true })
})

const serve = (path: string, f: Served): void => {
  files[`/${path}`] = f
}
const text = (b: Uint8Array | undefined): string | undefined =>
  b === undefined ? undefined : Buffer.from(b).toString()
async function put(root: string, path: string, body: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), body)
}

async function open(o: Partial<ContentFilesOptions> = {}): Promise<ContentFiles> {
  const c = await ContentFiles.open({
    handRoot: hand,
    mirrorRoot: mirror,
    acsmBase: base,
    now: () => clock,
    ...o,
  })
  opened.push(c)
  return c
}

/** Reads, waits for anything that read queued, then reads again. */
async function readTwice(
  c: ContentFiles,
  path: string,
): Promise<[string | undefined, string | undefined]> {
  const first = text(await c.read(path))
  await c.idle()
  return [first, text(await c.read(path))]
}

describe("ContentFiles", () => {
  it("serves the mirror, then the hand copy, and fetches only what neither has", async () => {
    await put(hand, SURFACES, "hand")
    serve(SURFACES, { status: 200, body: "server" })
    const c = await open()
    expect(await readTwice(c, SURFACES)).toEqual(["hand", "hand"])
    expect(requests).toEqual([])

    await rm(join(hand, SURFACES))
    expect(await readTwice(c, SURFACES), "fetched behind the read").toEqual([undefined, "server"])
    expect(await readFile(join(mirror, SURFACES), "utf8")).toBe("server")

    await put(hand, SURFACES, "hand")
    expect(text(await c.read(SURFACES)), "the server's copy wins once mirrored").toBe("server")
    expect(requests).toHaveLength(1)
  })

  it("asks Server Manager with no-cache, each segment encoded", async () => {
    const path = "content/tracks/rt suzuka/data/surfaces.ini"
    serve(path, { status: 200, body: "s" })
    const c = await open()
    expect(await readTwice(c, path)).toEqual([undefined, "s"])
    expect(requests.map((r) => r.path)).toEqual(["/content/tracks/rt%20suzuka/data/surfaces.ini"])
    expect(requests[0]?.headers["cache-control"]).toBe("no-cache")
  })

  it.each([
    ["a system file", "system/data/surfaces.ini"],
    ["a path climbing out", "content/tracks/../../etc/passwd.ini"],
    ["a dot segment", "content/tracks/./baku/data/surfaces.ini"],
    ["an empty segment", "content/tracks//baku/surfaces.ini"],
    ["a directory", "content/cars/"],
    ["a name with no extension", "content/tracks/baku/data"],
    ["too shallow", "content/tracks/surfaces.ini"],
    ["outside cars and tracks", "content/weather/x/clouds.ini"],
    ["an odd character", "content/tracks/baku/data/surf%61ces.ini"],
    ["an absolute path", "/content/tracks/baku/data/surfaces.ini"],
  ])("never fetches %s", async (_, path) => {
    serve(path.replace(/^\//, ""), { status: 200, body: "x" })
    const c = await open()
    expect(await readTwice(c, path)).toEqual([undefined, undefined])
    expect(requests).toEqual([])
    expect(await readdir(mirror)).toEqual([".meta"])
  })

  it("fetches nothing without Server Manager's address", async () => {
    serve(SURFACES, { status: 200, body: "x" })
    const c = await ContentFiles.open({ handRoot: hand, mirrorRoot: mirror })
    expect(await readTwice(c, SURFACES)).toEqual([undefined, undefined])
    expect(requests).toEqual([])
  })

  it("keeps a 404 for a day, across a restart", async () => {
    let c = await open()
    expect(await readTwice(c, SURFACES)).toEqual([undefined, undefined])
    expect(requests).toHaveLength(1)
    c = await open()
    await readTwice(c, SURFACES)
    expect(requests).toHaveLength(1)
    clock += 24 * 3600_000
    serve(SURFACES, { status: 200, body: "late" })
    expect(await readTwice(c, SURFACES)).toEqual([undefined, "late"])
  })

  it("holds a path ten minutes after a failure that isn't a 404, across a restart", async () => {
    serve(SURFACES, { status: 503 })
    let c = await open()
    await readTwice(c, SURFACES)
    c = await open()
    await readTwice(c, SURFACES)
    expect(requests).toHaveLength(1)
    clock += 10 * 60_000
    serve(SURFACES, { status: 200, body: "back" })
    expect(await readTwice(c, SURFACES)).toEqual([undefined, "back"])
  })

  it("refuses a page in place of a file", async () => {
    serve(SURFACES, { status: 200, body: "<pre>", type: "text/html; charset=utf-8" })
    const c = await open()
    expect(await readTwice(c, SURFACES)).toEqual([undefined, undefined])
  })

  it("refuses a file over the size cap, and keeps nothing of it", async () => {
    serve(SURFACES, { status: 200, body: "x".repeat(100) })
    const c = await open({ maxBytes: 99 })
    expect(await readTwice(c, SURFACES)).toEqual([undefined, undefined])
    expect(await readdir(mirror)).toEqual([".meta"])
  })

  it("makes no more than its hourly budget of requests, across a restart", async () => {
    const paths = Array.from({ length: 5 }, (_, i) => `content/tracks/t${i}/data/surfaces.ini`)
    let c = await open({ perHour: 3 })
    for (const p of paths.slice(0, 2)) await readTwice(c, p)
    c = await open({ perHour: 3 })
    for (const p of paths.slice(2)) await readTwice(c, p)
    expect(requests).toHaveLength(3)
    const held = JSON.parse(await readFile(join(mirror, ".meta", `${paths[4]}.json`), "utf8"))
    expect(held.heldUntil, "held before the fetch is done").toBeGreaterThan(clock)
    clock += 3600_000
    await readTwice(c, paths[4] ?? "")
    expect(requests).toHaveLength(4)
  })

  it("doesn't follow a link left in the hand copy", async () => {
    await put(dir, "secret.ini", "secret")
    await mkdir(dirname(join(hand, SURFACES)), { recursive: true })
    await symlink(join(dir, "secret.ini"), join(hand, SURFACES))
    const c = await open()
    expect(text(await c.read(SURFACES))).toBeUndefined()
  })

  it("still keeps to its budget when its count of requests isn't a list", async () => {
    await put(mirror, ".meta/sent.json", "{}")
    const c = await open({ perHour: 1 })
    await readTwice(c, SURFACES)
    await readTwice(c, ACD)
    expect(requests).toHaveLength(1)
  })

  it("throws away a half-written file at start", async () => {
    await put(mirror, `${SURFACES}.tmp-123`, "half")
    await open()
    expect(await readdir(join(mirror, "content/tracks/baku/data"))).toEqual([])
  })

  it("reads the hand copy only, when the mirror can't be made", async () => {
    await writeFile(mirror, "a file where the folder goes")
    await put(hand, SURFACES, "hand")
    const said: string[] = []
    const c = await open({ log: (m) => said.push(m) })
    expect(text(await c.read(SURFACES))).toBe("hand")
    expect(await readTwice(c, ACD)).toEqual([undefined, undefined])
    expect(requests).toEqual([])
    expect(said.join("\n")).toMatch(/can't keep fetched files/)
  })

  describe("after a checksum mismatch", () => {
    it("replaces a hand copy with the server's, data.acd included", async () => {
      await put(hand, SURFACES, "old")
      await put(hand, ACD, "old")
      serve(SURFACES, { status: 200, body: "new" })
      serve(ACD, { status: 200, body: "new" })
      const c = await open()
      c.mismatched([SURFACES, ACD])
      await c.idle()
      expect(text(await c.read(SURFACES))).toBe("new")
      expect(text(await c.read(ACD))).toBe("new")
    })

    it("revalidates a mirrored copy by its ETag", async () => {
      serve(SURFACES, { status: 200, body: "s", etag: '"v1"' })
      const c = await open()
      await readTwice(c, SURFACES)
      c.joined()
      c.mismatched([SURFACES])
      await c.idle()
      expect(text(await c.read(SURFACES))).toBe("s")
      expect(requests.map((r) => r.headers["if-none-match"])).toEqual([undefined, '"v1"'])
    })

    it("stops asking once a fresh copy fails too, until a join holds", async () => {
      await put(hand, SURFACES, "old")
      serve(SURFACES, { status: 200, body: "new", etag: '"v1"' })
      const c = await open()
      c.mismatched([SURFACES])
      await c.idle()
      c.mismatched([SURFACES])
      await c.idle()
      expect(text(await c.read(SURFACES)), "still the server's copy").toBe("new")
      expect(requests).toHaveLength(1)
      c.joined()
      c.mismatched([SURFACES])
      await c.idle()
      expect(requests).toHaveLength(2)
    })

    it.each([
      ["a file it can't fetch", true, "system/data/surfaces.ini"],
      ["any file, with nowhere to fetch from", false, SURFACES],
    ])("keeps answering for %s", async (_, fetching, path) => {
      await put(hand, path, "hand")
      const c = await ContentFiles.open({
        handRoot: hand,
        mirrorRoot: mirror,
        ...(fetching ? { acsmBase: base } : {}),
      })
      c.mismatched([path])
      await c.idle()
      expect(text(await c.read(path))).toBe("hand")
    })

    it("goes back to the hand copy of a file Server Manager doesn't have", async () => {
      await put(hand, SURFACES, "hand")
      const c = await open()
      c.mismatched([SURFACES])
      await c.idle()
      expect(text(await c.read(SURFACES))).toBe("hand")
      c.mismatched([SURFACES])
      await c.idle()
      expect(text(await c.read(SURFACES)), "and doesn't doubt it again before a join holds").toBe(
        "hand",
      )
      expect(requests).toHaveLength(1)
    })
  })
})
