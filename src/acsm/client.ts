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
    return this.#getJson<Championship>(`/championship/${encodeURIComponent(id)}/export`)
  }

  async standings(id: string): Promise<unknown> {
    return this.#getJson(`/championship/${encodeURIComponent(id)}/standings.json`)
  }

  async healthcheck(): Promise<unknown> {
    return this.#getJson("/healthcheck.json")
  }

  async #getJson<T>(path: string): Promise<T> {
    const url = `${this.#baseUrl}${path}`

    const cached = await this.#cache?.get(url)
    if (cached !== undefined) return JSON.parse(cached) as T

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
    let parsed: T
    try {
      parsed = JSON.parse(text) as T
    } catch {
      const hint = text.trimStart().startsWith("<")
        ? " (got HTML — is Public Access still enabled?)"
        : ""
      throw new AcsmError(`Response from ${path} was not JSON${hint}`, undefined, url)
    }

    await this.#cache?.set(url, text)
    return parsed
  }
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

  async standings(): Promise<unknown> {
    throw new AcsmError("Standings are not available from a static reader")
  }

  async healthcheck(): Promise<unknown> {
    return { ok: true }
  }
}
