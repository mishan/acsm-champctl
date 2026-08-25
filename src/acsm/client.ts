/**
 * Read-only ACSM client (plan §3.1).
 *
 * Public Access is enabled, so none of this needs credentials — and this
 * module must never grow any. The write path is a separate client with a
 * separate lifetime for its cookie jar; keeping them apart is what guarantees
 * the bot and the archive can't write to a live championship.
 *
 * The interface exists so the on-host implementation (reading ACSM's own
 * filesystem) can be swapped in later as a config change (plan §9).
 */

import { walkChampionshipIds } from "./listing.js"
import { exportPath } from "./paths.js"
import type { AcsmHealthcheck, Championship, ChampionshipSummary } from "./types.js"
import { RateLimiter, type RateLimiterOptions } from "./rate-limit.js"

export interface AcsmReader {
  listChampionships(): Promise<ChampionshipSummary[]>
  /** The full export: config, entry list, results, laps and incidents. */
  exportChampionship(id: string): Promise<Championship>
  /**
   * The same export as the bytes the server sent, for the archive.
   *
   * Plan §8.1 stores raw JSON verbatim and treats everything derived from it as
   * a projection that can be rebuilt. Parsing and re-serialising would defeat
   * that: `JSON.stringify` reorders integer-like keys, drops the distinction
   * between `1` and `1.0`, and normalises whitespace and escapes. None of that
   * matters for reading a championship, and all of it matters for an archive
   * whose job is to still be trustworthy after the source is gone.
   *
   * A `Buffer` rather than a string, and that distinction is the whole point.
   * `Response.text()` is a WHATWG UTF-8 decode: it strips a leading BOM and
   * replaces every invalid byte sequence with U+FFFD. Returning a string and
   * re-encoding it downstream would store something the server never sent,
   * while `sha256` and `bytes` went on describing the re-encoding — so neither
   * could ever be checked against the source. Decoding happens on a copy, for
   * validation only.
   */
  exportChampionshipRaw(id: string): Promise<Buffer>
  standings(id: string): Promise<unknown>
  healthcheck(): Promise<AcsmHealthcheck>
}

export class AcsmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly url?: string,
  ) {
    super(message)
    this.name = "AcsmError"
  }
}

export interface HttpReaderOptions {
  baseUrl: string
  fetch?: typeof globalThis.fetch
  rateLimit?: RateLimiterOptions | false
  /** Per-request timeout. */
  timeoutMs?: number
  userAgent?: string
  /** Optional response cache; see `SqliteCache`. */
  cache?: ResponseCache
}

export interface ResponseCache {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  /**
   * Releases whatever the cache holds open. Optional: a cache backed by
   * nothing has nothing to release.
   *
   * The reader deliberately does not call this. A cache outlives any one
   * reader — that is what makes it a cache — so closing it belongs to whoever
   * opened it.
   */
  close?(): void | Promise<void>
}

export class HttpAcsmReader implements AcsmReader {
  readonly #baseUrl: string
  readonly #fetch: typeof globalThis.fetch
  readonly #limiter: RateLimiter | undefined
  readonly #timeoutMs: number
  readonly #userAgent: string
  readonly #cache: ResponseCache | undefined

  constructor(options: HttpReaderOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "")
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.#limiter =
      options.rateLimit === false ? undefined : new RateLimiter(options.rateLimit ?? {})
    this.#timeoutMs = options.timeoutMs ?? 30_000
    this.#userAgent = options.userAgent ?? "acsm-champctl/0.1 (gridmom)"
    this.#cache = options.cache
  }

  /**
   * Every championship on the server.
   *
   * `/api/championships/list.json` is the documented endpoint (plan §3.1) and
   * it does not exist on 2.4.5 or 2.4.15 — measured, 404 even when logged in as
   * admin, while `/api/results/list.json` beside it answers 200. Since that is
   * the endpoint `champctl-archive` walks, the archive could not enumerate a
   * single championship on the version BATL runs, and nothing noticed because
   * no test had ever run a CLI against a real manager.
   *
   * So: try the endpoint, and fall back to scraping the championships page,
   * which Public Access serves without credentials. The scrape yields ids and
   * no names; callers already read this defensively.
   */
  async listChampionships(): Promise<ChampionshipSummary[]> {
    let body: unknown
    try {
      body = await this.#getJson<unknown>("/api/championships/list.json")
    } catch (e) {
      // Only a 404 falls back. Catching every AcsmError swallowed the one that
      // matters: with Public Access off the endpoint answers with login HTML,
      // #getJson raises "not JSON — is Public Access still enabled?", and the
      // scrape then reads another login page and finds no championships. The
      // archive would exit 0 having archived nothing, which is the failure it
      // exists to prevent, reported as success.
      if (e instanceof AcsmError && e.status === 404) return await this.#scrapeChampionships()
      throw e
    }
    if (Array.isArray(body)) return body as ChampionshipSummary[]
    // Some versions wrap the list; accept the common shapes rather than fail.
    if (body && typeof body === "object") {
      for (const key of ["championships", "Championships", "data"]) {
        const v = (body as Record<string, unknown>)[key]
        if (Array.isArray(v)) return v as ChampionshipSummary[]
      }
    }
    throw new AcsmError("Championship list was not an array")
  }

  /**
   * Championship ids off the HTML listing, for builds with no list endpoint.
   *
   * Ids only: the page shows names, but parsing them out of markup is the kind
   * of thing that breaks silently on a template change, and every caller reads
   * the name defensively already because the JSON shape varies too.
   */
  async #scrapeChampionships(): Promise<ChampionshipSummary[]> {
    const ids = await walkChampionshipIds(async (path) =>
      (await this.#request(path)).toString("utf8"),
    )
    return ids.map((ID) => ({ ID }) as ChampionshipSummary)
  }

  async exportChampionship(id: string): Promise<Championship> {
    // Export works while logged out, which is what makes the whole read side
    // credential-free (plan §3.1).
    return this.#getJson<Championship>(exportPath(id))
  }

  async exportChampionshipRaw(id: string): Promise<Buffer> {
    // Deliberately not cached. The cache stores decoded strings, so a hit could
    // only hand back a re-encoding — the exact substitution this method exists
    // to avoid. The archive skips the cache anyway; this makes it structural.
    const bytes = await this.#request(exportPath(id))
    assertJson(bytes, exportPath(id), `${this.#baseUrl}${exportPath(id)}`)
    return bytes
  }

  async standings(id: string): Promise<unknown> {
    return this.#getJson(`/championship/${encodeURIComponent(id)}/standings.json`)
  }

  async healthcheck(): Promise<AcsmHealthcheck> {
    return this.#getJson<AcsmHealthcheck>("/healthcheck.json")
  }

  async #getJson<T>(path: string): Promise<T> {
    return (await this.#fetchJson(path)).parsed as T
  }

  /**
   * One request, returning the body as the bytes that arrived.
   *
   * Everything above this decides what to do with them: `#fetchJson` decodes
   * and caches, `exportChampionshipRaw` keeps them. Reading `arrayBuffer()`
   * rather than `text()` here is what makes the verbatim path possible at all —
   * by the time `text()` has run, a BOM and any invalid sequence are already
   * gone and cannot be recovered.
   */
  async #request(path: string): Promise<Buffer> {
    const url = `${this.#baseUrl}${path}`
    await this.#limiter?.acquire()

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    try {
      const res = await this.#fetch(url, {
        headers: { Accept: "application/json", "User-Agent": this.#userAgent },
        redirect: "follow",
        signal: controller.signal,
      })
      if (!res.ok) {
        throw new AcsmError(`${res.status} ${res.statusText} from ${path}`, res.status, url)
      }
      return Buffer.from(await res.arrayBuffer())
    } catch (e) {
      if (e instanceof AcsmError) throw e
      throw new AcsmError(`Request to ${path} failed: ${asMessage(e)}`, undefined, url)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Fetches a JSON endpoint and returns both the decoded text and the parsed
   * value, from a single parse.
   *
   * Parsing is also the validation step — a login redirect answers 200 with
   * HTML, and that check is what turns "Public Access got switched off" into a
   * sentence rather than a stored HTML page.
   */
  async #fetchJson(path: string): Promise<{ text: string; parsed: unknown }> {
    const url = `${this.#baseUrl}${path}`

    // Cache reads fail open. A truncated or corrupt entry is a cache miss, not
    // an error — otherwise one bad write leaves the CLI permanently broken for
    // that URL with no obvious way out.
    const cached = await this.#cache?.get(url)
    if (cached !== undefined) {
      try {
        return { text: cached, parsed: JSON.parse(cached) }
      } catch {
        // Fall through and refetch.
      }
    }

    const bytes = await this.#request(path)
    const text = decodeForParsing(bytes)
    const parsed = assertJson(bytes, path, url)

    await this.#cache?.set(url, text)
    return { text, parsed }
  }
}

/**
 * Decodes a body for parsing, dropping a leading BOM.
 *
 * `Response.text()` did this for us and `Buffer.toString` does not, so without
 * it a BOM'd export would newly fail to parse. The BOM stays in the bytes the
 * archive stores — that is the point of the split.
 */
function decodeForParsing(bytes: Buffer): string {
  const text = bytes.toString("utf8")
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** Parses a body, or explains why it isn't JSON. Returns the parsed value. */
function assertJson(bytes: Buffer, path: string, url: string): unknown {
  const text = decodeForParsing(bytes)
  try {
    return JSON.parse(text)
  } catch {
    // A login redirect returns 200 with HTML, so a parse failure here usually
    // means Public Access got switched off rather than a malformed body.
    const hint = text.trimStart().startsWith("<")
      ? " (got HTML — is Public Access still enabled?)"
      : ""
    throw new AcsmError(`Response from ${path} was not JSON${hint}`, undefined, url)
  }
}

/**
 * An error as a sentence, naming an abort as what it actually was.
 *
 * `AbortError` is what a fetch timeout throws, and "The operation was aborted"
 * reads like something champctl chose to do. Exported because the archive had
 * its own copy without the abort case, so the one place most likely to time out
 * — a nightly run over every championship — was the one reporting it worst.
 */
export function asMessage(e: unknown): string {
  if (e instanceof Error) return e.name === "AbortError" ? "timed out" : e.message
  return String(e)
}

/** Reader backed by exports already on disk. Used by tests and `--file`. */
export class StaticAcsmReader implements AcsmReader {
  readonly #byId: Map<string, Championship>

  constructor(championships: Iterable<Championship>) {
    this.#byId = new Map()
    for (const c of championships) if (c.ID) this.#byId.set(c.ID, c)
  }

  async listChampionships(): Promise<ChampionshipSummary[]> {
    return [...this.#byId.values()].map((c) => {
      const s: ChampionshipSummary = {}
      if (c.ID !== undefined) s.ID = c.ID
      if (c.Name !== undefined) s.Name = c.Name
      return s
    })
  }

  async exportChampionship(id: string): Promise<Championship> {
    const c = this.#byId.get(id)
    if (!c) throw new AcsmError(`No championship ${id} in this reader`)
    return c
  }

  /**
   * Re-serialised, because this reader was handed objects and never saw a
   * response body. Fine for tests and `--file`; deliberately not what the
   * archive runs against, since "verbatim" is the whole point there.
   */
  async exportChampionshipRaw(id: string): Promise<Buffer> {
    return Buffer.from(JSON.stringify(await this.exportChampionship(id)), "utf8")
  }

  async standings(): Promise<unknown> {
    throw new AcsmError("Standings are not available from a static reader")
  }

  async healthcheck(): Promise<AcsmHealthcheck> {
    // No server to ask, so no version to report. `dialectFrom` treats an
    // unknown version as premium, which is the safe direction — see the note
    // on `familyOf`.
    //
    // Both spellings, because a caller reading either should see the same
    // answer from a static reader as from a real one. Answering only `OK`
    // would make `--file` mode differ from a live manager in a way that has
    // nothing to do with there being no server.
    return { OK: true, ok: true }
  }
}
