/**
 * Authenticated ACSM session — the write side.
 *
 * Kept deliberately separate from `AcsmReader`. The reader can never write and
 * holds no credentials; this can write and holds a cookie jar. The bot and the
 * archive import only the reader, which is what makes "the bot never has write
 * credentials" a property of the code rather than a promise.
 *
 * Credentials live in memory for the lifetime of the object and are never
 * written to disk (plan §3.3). Login is a plain form POST — there is no CSRF
 * token — but re-verify that after any ACSM upgrade, because a version that
 * adds one would break every write silently.
 */

import {
  checkEntryListShape,
  parseForm,
  toBody,
  type FormField,
  type ParsedForm,
  type ParseFormOptions,
} from "./form.js"

export class AcsmAuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = "AcsmAuthError"
  }
}

export class AcsmWriteError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly url?: string,
  ) {
    super(message)
    this.name = "AcsmWriteError"
  }
}

/**
 * Minimal cookie jar. ACSM needs exactly two cookies — `_acsm_data` (the signed
 * session) and `current-server` (the selected server index) — so this handles
 * name/value pairs per host and ignores paths, domains and expiry. That is
 * enough for a single-origin client and small enough to audit.
 */
export class CookieJar {
  readonly #cookies = new Map<string, string>()

  storeFromResponse(res: { headers: Headers }): void {
    const setCookie = readSetCookie(res.headers)
    for (const line of setCookie) {
      const pair = line.split(";", 1)[0] ?? ""
      const eq = pair.indexOf("=")
      if (eq <= 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      // An expiry in the past is a delete; treat an empty value the same way.
      if (value === "" || /(^|;)\s*max-age=0(;|$)/i.test(line)) this.#cookies.delete(name)
      else this.#cookies.set(name, value)
    }
  }

  header(): string | undefined {
    if (this.#cookies.size === 0) return undefined
    return [...this.#cookies].map(([k, v]) => `${k}=${v}`).join("; ")
  }

  get(name: string): string | undefined {
    return this.#cookies.get(name)
  }

  set(name: string, value: string): void {
    this.#cookies.set(name, value)
  }

  get names(): string[] {
    return [...this.#cookies.keys()]
  }

  clear(): void {
    this.#cookies.clear()
  }
}

function readSetCookie(headers: Headers): string[] {
  // Node's undici exposes getSetCookie(); fall back for other runtimes.
  const withGetter = headers as Headers & { getSetCookie?: () => string[] }
  if (typeof withGetter.getSetCookie === "function") return withGetter.getSetCookie()
  const single = headers.get("set-cookie")
  return single ? [single] : []
}

export interface AcsmSessionOptions {
  baseUrl: string
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  userAgent?: string
  /** Server index for the `current-server` cookie. Defaults to 0. */
  serverIndex?: number
}

export interface LoginCredentials {
  username: string
  password: string
}

export class AcsmSession {
  readonly #baseUrl: string
  readonly #fetch: typeof globalThis.fetch
  readonly #timeoutMs: number
  readonly #userAgent: string
  readonly jar = new CookieJar()
  #loggedInAs: string | undefined

  constructor(options: AcsmSessionOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "")
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.#timeoutMs = options.timeoutMs ?? 30_000
    this.#userAgent = options.userAgent ?? "acsm-champctl/0.1"
    this.jar.set("current-server", String(options.serverIndex ?? 0))
  }

  get baseUrl(): string {
    return this.#baseUrl
  }

  get username(): string | undefined {
    return this.#loggedInAs
  }

  get isLoggedIn(): boolean {
    return this.jar.get("_acsm_data") !== undefined
  }

  url(path: string): string {
    return path.startsWith("http") ? path : `${this.#baseUrl}${path}`
  }

  /**
   * POST /login with Username, Password, RememberMe. No CSRF token.
   *
   * ACSM answers a bad password with 200 and the login page again rather than
   * a 401, so success is judged by the session cookie appearing.
   */
  async login(credentials: LoginCredentials): Promise<void> {
    const body = new URLSearchParams({
      Username: credentials.username,
      Password: credentials.password,
      RememberMe: "on",
    })

    const res = await this.#request("/login", {
      method: "POST",
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    })

    if (!this.isLoggedIn) {
      const hint =
        res.status === 200
          ? " — ACSM returned the login page again, which usually means bad credentials"
          : ""
      throw new AcsmAuthError(`Login as ${credentials.username} failed${hint}`, res.status)
    }
    this.#loggedInAs = credentials.username

    // A first login, or one after an admin password reset, lands on the
    // change-password page and no write will work until it's dealt with.
    const location = res.headers.get("location") ?? ""
    if (location.includes("new-password")) {
      throw new AcsmAuthError(
        `${credentials.username} must set a new password in ACSM before champctl can use this account`,
      )
    }
  }

  async logout(): Promise<void> {
    try {
      await this.#request("/logout", { method: "GET", redirect: "manual" })
    } finally {
      this.jar.clear()
      this.#loggedInAs = undefined
    }
  }

  async getText(path: string): Promise<string> {
    const res = await this.#request(path, { method: "GET" })
    if (!res.ok) {
      throw new AcsmWriteError(`${res.status} ${res.statusText} from ${path}`, res.status, path)
    }
    const text = await res.text()
    this.#assertNotLoginPage(text, path)
    return text
  }

  async getJson<T>(path: string): Promise<T> {
    const text = await this.getText(path)
    try {
      return JSON.parse(text) as T
    } catch {
      throw new AcsmWriteError(`Response from ${path} was not JSON`, undefined, path)
    }
  }

  /** Fetches a page and parses one of its forms. */
  async getForm(path: string, options: ParseFormOptions = {}): Promise<ParsedForm> {
    const html = await this.getText(path)
    return parseForm(html, { ...options, pageUrl: this.url(path) })
  }

  /**
   * Submits form fields back, preserving repeated-key order.
   *
   * Refuses to send a payload whose `EntryList.*` arrays are ragged. ACSM
   * indexes them in parallel, so a short array panics the server and a long one
   * silently reassigns entrant data (docs/acsm-write-path.md §1). This is the
   * guard that stops champctl destroying an entry list while appearing to work.
   */
  async postForm(path: string, fields: readonly FormField[]): Promise<Response> {
    const problems = checkEntryListShape(fields)
    if (problems.length > 0) {
      const detail = problems
        .map((p) => `${p.key} has ${p.count}, expected ${p.expected}`)
        .join("; ")
      throw new AcsmWriteError(
        `Refusing to POST ${path}: the entry list arrays don't line up (${detail})`,
        undefined,
        path,
      )
    }

    const res = await this.#request(path, {
      method: "POST",
      body: toBody(fields),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    })

    // ACSM redirects on success and re-renders the page on failure.
    if (res.status >= 400) {
      throw new AcsmWriteError(`${res.status} ${res.statusText} from ${path}`, res.status, path)
    }
    return res
  }

  /**
   * `POST /championship/import` as multipart with a single file part.
   *
   * Never call this with an export whose ID already exists on the server:
   * ACSM preserves UUIDs exactly as sent, so re-importing overwrites the
   * championship the file came from (plan §5.4). `importChampionship` in
   * `write.ts` enforces that; this is the raw transport.
   */
  async postMultipart(
    path: string,
    fieldName: string,
    fileName: string,
    contents: string | Uint8Array,
    contentType = "application/json",
  ): Promise<Response> {
    const form = new FormData()
    const bytes = typeof contents === "string" ? new TextEncoder().encode(contents) : contents
    form.append(fieldName, new Blob([bytes], { type: contentType }), fileName)

    const res = await this.#request(path, { method: "POST", body: form, redirect: "manual" })
    if (res.status >= 400) {
      throw new AcsmWriteError(`${res.status} ${res.statusText} from ${path}`, res.status, path)
    }
    return res
  }

  async #request(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    try {
      const headers = new Headers(init.headers)
      headers.set("User-Agent", this.#userAgent)
      const cookie = this.jar.header()
      if (cookie) headers.set("Cookie", cookie)

      const res = await this.#fetch(this.url(path), { ...init, headers, signal: controller.signal })
      this.jar.storeFromResponse(res)
      return res
    } catch (e) {
      if (e instanceof AcsmAuthError || e instanceof AcsmWriteError) throw e
      const why = e instanceof Error && e.name === "AbortError" ? "timed out" : String(e)
      throw new AcsmWriteError(`Request to ${path} failed: ${why}`, undefined, path)
    } finally {
      clearTimeout(timer)
    }
  }

  /** A silently-expired session returns the login page with a 200. */
  #assertNotLoginPage(html: string, path: string): void {
    if (/name=["']Password["']/i.test(html) && /action=["']?\/?login/i.test(html)) {
      throw new AcsmAuthError(`Session expired: ${path} returned the login page`)
    }
  }
}
