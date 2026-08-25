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

import type { Championship, ChampionshipSummary } from "./types.js"
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
   */
  exportChampionshipRaw(id: string): Promise<string>
  standings(id: string): Promise<unknown>
  healthcheck(): Promise<unknown>
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
  /** Optional response cache; see `FileCache`. */
  cache?: ResponseCache
}

export interface ResponseCache {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
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

  async listChampionships(): Promise<ChampionshipSummary[]> {
    const body = await this.#getJson<unknown>("/api/championships/list.json")
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

  async exportChampionship(id: string): Promise<Championship> {
    // Export works while logged out, which is what makes the whole read side
    // credential-free (plan §3.1).
    return this.#getJson<Championship>(exportPath(id))
  }

  async exportChampionshipRaw(id: string): Promise<string> {
    return this.#getText(exportPath(id))
  }

  async standings(id: string): Promise<unknown> {
    return this.#getJson(`/championship/${encodeURIComponent(id)}/standings.json`)
  }

  async healthcheck(): Promise<unknown> {
    return this.#getJson("/healthcheck.json")
  }

  async #getJson<T>(path: string): Promise<T> {
    // #getText has already proved this parses, so this cannot throw.
    return JSON.parse(await this.#getText(path)) as T
  }

  /**
   * Fetches a JSON endpoint and returns the response body unchanged.
   *
   * It is still validated as JSON — a login redirect answers 200 with HTML, so
   * the check below is what turns "Public Access got switched off" into a
   * sentence rather than a stored HTML page — but what comes back is the text,
   * not a re-serialisation of it. See `exportChampionshipRaw`.
   */
  async #getText(path: string): Promise<string> {
    const url = `${this.#baseUrl}${path}`

    // Cache reads fail open. A truncated or corrupt entry is a cache miss, not
    // an error — otherwise one bad write leaves the CLI permanently broken for
    // that URL with no obvious way out.
    const cached = await this.#cache?.get(url)
    if (cached !== undefined) {
      try {
        JSON.parse(cached)
        return cached
      } catch {
        // Fall through and refetch.
      }
    }

    await this.#limiter?.acquire()

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    let text: string
    try {
      const res = await this.#fetch(url, {
        headers: { Accept: "application/json", "User-Agent": this.#userAgent },
        redirect: "follow",
        signal: controller.signal,
      })
      if (!res.ok) {
        throw new AcsmError(`${res.status} ${res.statusText} from ${path}`, res.status, url)
      }
      text = await res.text()
    } catch (e) {
      if (e instanceof AcsmError) throw e
      throw new AcsmError(`Request to ${path} failed: ${asMessage(e)}`, undefined, url)
    } finally {
      clearTimeout(timer)
    }

    // A login redirect returns 200 with HTML, so a parse failure here usually
    // means Public Access got switched off rather than a malformed body.
    try {
      JSON.parse(text)
    } catch {
      const hint = text.trimStart().startsWith("<")
        ? " (got HTML — is Public Access still enabled?)"
        : ""
      throw new AcsmError(`Response from ${path} was not JSON${hint}`, undefined, url)
    }

    await this.#cache?.set(url, text)
    return text
  }
}

/** Path to a championship's export. */
function exportPath(id: string): string {
  return `/championship/${encodeURIComponent(id)}/export`
}

function asMessage(e: unknown): string {
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
  async exportChampionshipRaw(id: string): Promise<string> {
    return JSON.stringify(await this.exportChampionship(id))
  }

  async standings(): Promise<unknown> {
    throw new AcsmError("Standings are not available from a static reader")
  }

  async healthcheck(): Promise<unknown> {
    return { ok: true }
  }
}
