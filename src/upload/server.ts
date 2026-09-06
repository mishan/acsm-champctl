/**
 * `champctl-upload`: the endpoint behind a one-time link
 * (docs/discord-livery-upload.md §3).
 *
 * **Its own process, and that is the point.** `champctl-serve` holds ACSM
 * credentials, and this endpoint is unauthenticated, internet-facing, and
 * accepts tens of megabytes from a stranger. Putting the two in one process
 * would put a write session behind a public upload form. So this has no ACSM
 * credentials and no Discord token, and writes to the same queue database as
 * everything else — the same argument as the bot, applied a third time, which
 * makes it a rule rather than a one-off: **every process that faces something
 * untrusted has nothing worth stealing.**
 *
 * `test/upload.test.ts` enforces that structurally, the way `test/bot.test.ts`
 * does for the bot.
 *
 * ## It serves the carset too
 *
 * Uploads were only half the problem. The carset is, by construction, larger
 * than any single livery in it — so if one driver's zip is too big for Discord,
 * the pack of everyone's certainly is, and "pin it in the channel" was never
 * going to work. The same process that takes the files hands them back.
 *
 * ## Raw bodies, not multipart
 *
 * The POST takes the zip as the request body. A multipart parser is a parser,
 * on the most exposed surface champctl has, for the sake of a form encoding
 * nothing here needs — the page below sends the bytes with `fetch`, and
 * `curl --data-binary @livery.zip` works identically. The one cost is that the
 * browser path needs JavaScript, which is stated on the page.
 */

import { createReadStream } from "node:fs"
import { mkdir, rename, stat, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pipeline } from "node:stream/promises"

import { acceptLivery } from "../liveries/accept.js"
import { buildCarset, carsetFilename, carsetZip } from "../liveries/carset.js"
import { DEFAULT_LIMITS, type PackLimits } from "../liveries/pack.js"
import type { SqliteSubmissionQueue } from "../liveries/queue.js"
import type { SqliteLiveryStore } from "../liveries/store.js"
import { type SqliteTokenStore, tokenFromPath } from "../liveries/upload-token.js"

export interface UploadServerOptions {
  tokens: SqliteTokenStore
  queue: SqliteSubmissionQueue
  /** Absent means carset downloads are not served. */
  store?: SqliteLiveryStore
  /** Where built carsets are kept. Defaults under the OS temp directory. */
  cacheDir?: string
  limits?: PackLimits
  autoApply?: boolean
  now?: () => Date
}

/** Pulls a carset slug out of `/c/<slug>`. */
export function carsetSlugFromPath(pathname: string): string | undefined {
  const match = /^\/c\/([A-Za-z0-9_-]{16,128})(?:\/[^/]*)?$/.exec(pathname)
  return match?.[1]
}

/** Text for a token that cannot be used, in the words a driver needs. */
function tokenProblem(reason: "unknown" | "expired" | "used"): string {
  switch (reason) {
    case "expired":
      return "That link has expired. Ask for a new one with /livery upload-url."
    case "used":
      // The likely reader here is someone who uploaded successfully and then hit
      // refresh, so it says the upload was fine rather than implying it wasn't.
      return "That link has already been used. If your upload went through, you're done — if you need to send another, ask for a new link with /livery upload-url."
    default:
      return "That link isn't one champctl recognises. Ask for a new one with /livery upload-url."
  }
}

function page(title: string, body: string): string {
  // Deliberately plain. This is served to a driver on a phone from a box the
  // league runs; a build step and a stylesheet are things to go wrong between
  // them and a working upload.
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${title}</title>
<style>
 body{font:16px/1.5 system-ui,sans-serif;margin:0 auto;padding:2rem 1.25rem;max-width:34rem}
 h1{font-size:1.25rem} .muted{color:#666} .bad{color:#a00} button{font:inherit;padding:.5rem 1rem}
 input[type=file]{display:block;margin:1rem 0}
</style></head><body>${body}</body></html>`
}

function uploadPage(
  driverName: string,
  carModel: string,
  expiresAt: Date,
  maxBytes: number,
): string {
  return page(
    "Upload a livery",
    `<h1>Livery for ${escapeHtml(driverName)}</h1>
<p class="muted">${escapeHtml(carModel)} — link valid until ${expiresAt.toISOString().slice(11, 16)} UTC, and works once.</p>
<p>Send the same zip you'd send in Discord: the skin's files, up to ${(maxBytes / (1024 * 1024)).toFixed(0)} MB.</p>
<input type="file" id="f" accept=".zip,application/zip">
<button id="go">Upload</button>
<p id="out" role="status"></p>
<p class="muted">Needs JavaScript. Without it: <code>curl --data-binary @livery.zip &lt;this URL&gt;</code></p>
<script>
const out = document.getElementById("out"), go = document.getElementById("go");
go.onclick = async () => {
  const file = document.getElementById("f").files[0];
  if (!file) { out.textContent = "Pick a zip first."; return; }
  go.disabled = true; out.textContent = "Uploading…";
  try {
    const res = await fetch(location.pathname, { method: "POST", body: file });
    out.textContent = await res.text();
    if (!res.ok) go.disabled = false;
  } catch (e) { out.textContent = "Upload failed: " + e.message; go.disabled = false; }
};
</script>`,
  )
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  )
}

/**
 * Reads the body, giving up as soon as it is too big.
 *
 * Counted as it arrives rather than after: a caller that buffered first would
 * hold whatever a stranger chose to send before deciding it was too much, which
 * is the one thing a size limit exists to prevent.
 */
async function readBody(req: IncomingMessage, maxBytes: number): Promise<Uint8Array | "too-big"> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > maxBytes) {
      req.destroy()
      return "too-big"
    }
    chunks.push(buf)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

/**
 * Builds the carset, or reuses the copy on disk.
 *
 * Cached to a file rather than to memory, and keyed on the content digest. A
 * thirty-driver carset is a few hundred megabytes; holding one in the heap per
 * request is how a league's VPS gets an OOM on the evening everyone downloads
 * at once, and rebuilding it per request is worse. The digest is already stable
 * against rebuilds — it hashes the manifest, not the archive — so a cached file
 * stays valid until a livery actually changes.
 *
 * Written to a temporary name and renamed, so two requests arriving during the
 * first build cannot serve each other a half-written zip.
 */
async function cachedCarset(
  store: SqliteLiveryStore,
  championshipId: string,
  cacheDir: string,
): Promise<{ path: string; digest: string; filename: string; bytes: number } | undefined> {
  const carset = buildCarset(championshipId, await store.read(championshipId))
  if (carset.skins.length === 0) return undefined

  await mkdir(cacheDir, { recursive: true, mode: 0o700 })
  const path = join(cacheDir, `${carset.digest}.zip`)
  const filename = carsetFilename(carset)

  try {
    const existing = await stat(path)
    return { path, digest: carset.digest, filename, bytes: existing.size }
  } catch {
    // Not built yet, which is the common case exactly once per change.
  }

  const partial = `${path}.${process.pid}.partial`
  await writeFile(partial, carsetZip(carset))
  await rename(partial, path)
  return { path, digest: carset.digest, filename, bytes: (await stat(path)).size }
}

export function uploadRequestHandler(
  options: UploadServerOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const limits = options.limits ?? DEFAULT_LIMITS
  const now = options.now ?? (() => new Date())

  const send = (res: ServerResponse, status: number, type: string, body: string) => {
    res.writeHead(status, {
      "content-type": type,
      // Nothing here should be cached or indexed: the URL is a credential.
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow",
    })
    res.end(body)
  }

  const cacheDir = options.cacheDir ?? join(tmpdir(), "champctl-carsets")

  /**
   * Hands the whole grid's liveries back as one archive.
   *
   * The link is stable and shared — everyone on the grid needs this file, so a
   * token each would leave a driver who joined last week with nothing to click
   * when somebody pastes theirs. What it is *not* is guessable, which is the
   * only access control here and about right for a list of driver names that
   * are already in the public entry list.
   */
  const serveCarset = async (
    req: IncomingMessage,
    res: ServerResponse,
    slug: string,
  ): Promise<void> => {
    if (!options.store) {
      send(res, 404, "text/plain; charset=utf-8", "Not found.\n")
      return
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(res, 405, "text/plain; charset=utf-8", "Carsets are downloads.\n")
      return
    }

    const championshipId = await options.store.championshipForSlug(slug)
    if (!championshipId) {
      send(res, 404, "text/plain; charset=utf-8", "Not found.\n")
      return
    }

    const built = await cachedCarset(options.store, championshipId, cacheDir)
    if (!built) {
      send(
        res,
        404,
        "text/plain; charset=utf-8",
        "No liveries have been applied to this championship yet, so there's no carset to " +
          "download.\n",
      )
      return
    }

    // The digest is over the manifest rather than the archive, so a rebuild
    // does not invalidate everyone's copy — which matters when the whole grid
    // re-checks this before a race night and nothing has changed.
    const etag = `"${built.digest}"`
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { etag, "cache-control": "no-cache" })
      res.end()
      return
    }

    res.writeHead(200, {
      "content-type": "application/zip",
      "content-length": String(built.bytes),
      // `no-cache` rather than `no-store`: revalidate every time, but let a
      // driver keep the bytes so an unchanged carset costs one request.
      "cache-control": "no-cache",
      etag,
      "content-disposition": `attachment; filename="${built.filename}"`,
      "x-robots-tag": "noindex, nofollow",
    })
    if (req.method === "HEAD") {
      res.end()
      return
    }
    // Streamed, not read into a buffer. This is the largest thing champctl
    // serves and the only one where that distinction decides whether a small
    // box survives the grid downloading at once.
    await pipeline(createReadStream(built.path), res)
  }

  return async (req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname
    const token = tokenFromPath(pathname)

    const carsetSlug = carsetSlugFromPath(pathname)
    if (carsetSlug) {
      await serveCarset(req, res, carsetSlug)
      return
    }

    if (!token) {
      // No index, no listing, no hint that anything else is here.
      send(res, 404, "text/plain; charset=utf-8", "Not found.\n")
      return
    }

    if (req.method === "GET" || req.method === "HEAD") {
      // Peek, never consume. Discord's unfurler gets here within a second of
      // the link being sent; a token that burned on GET would be dead before
      // the driver clicked it, every time.
      const looked = await options.tokens.peek(token, now())
      if (!looked.ok) {
        send(
          res,
          410,
          "text/html; charset=utf-8",
          page(
            "Link expired",
            `<h1>Can't use that link</h1><p class="bad">${escapeHtml(tokenProblem(looked.reason))}</p>`,
          ),
        )
        return
      }
      send(
        res,
        200,
        "text/html; charset=utf-8",
        uploadPage(
          looked.grant.driverName,
          looked.grant.carModel,
          looked.expiresAt,
          limits.maxTotalBytes,
        ),
      )
      return
    }

    if (req.method !== "POST") {
      send(res, 405, "text/plain; charset=utf-8", "Send the zip with POST.\n")
      return
    }

    const body = await readBody(req, limits.maxTotalBytes)
    if (body === "too-big") {
      // Refused before the token is spent, so the driver can shrink the file and
      // use the same link rather than going back to Discord for another.
      send(
        res,
        413,
        "text/plain; charset=utf-8",
        `That's larger than ${(limits.maxTotalBytes / (1024 * 1024)).toFixed(0)} MB, which is more than a livery should be. The link still works — try again with a smaller zip.\n`,
      )
      return
    }

    const consumed = await options.tokens.consume(token, now())
    if (!consumed.ok) {
      send(res, 410, "text/plain; charset=utf-8", `${tokenProblem(consumed.reason)}\n`)
      return
    }

    const grant = consumed.grant
    const accepted = await acceptLivery({
      driverName: grant.driverName,
      carModel: grant.carModel,
      championshipId: grant.championshipId,
      discordUserId: grant.discordUserId,
      ...(grant.discordHandle ? { discordHandle: grant.discordHandle } : {}),
      body,
      queue: options.queue,
      now: now(),
      limits,
      autoApply: options.autoApply ?? false,
    })

    // A refused zip spends the token, which is the honest trade: keeping it
    // alive would turn one link into an unlimited upload endpoint for as long
    // as the driver kept sending things that failed validation. The message
    // says to ask for another.
    send(
      res,
      accepted.ok ? 200 : 400,
      "text/plain; charset=utf-8",
      accepted.ok
        ? `${accepted.reply}\n`
        : `${accepted.reply}\n\nThat link is spent now — ask for another with /livery upload-url once you've fixed it.\n`,
    )
  }
}

export function createUploadServer(options: UploadServerOptions): Server {
  const handler = uploadRequestHandler(options)
  return createServer((req, res) => {
    handler(req, res).catch(() => {
      // Nothing from the exception reaches the response. A stack trace on a
      // public endpoint is free reconnaissance, and the driver cannot act on it.
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" })
      res.end("Something went wrong here rather than with your file. Tell an admin.\n")
    })
  })
}
