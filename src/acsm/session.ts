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

import { getSetCookies } from "undici"

import { RateLimiter, type RateLimiterOptions } from "./rate-limit.js"
import { AcsmError } from "./client.js"
import {
  checkEntryListShape,
  parseForm,
  stripUnpairedCheckboxes,
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

/**
 * A write ACSM refused, or one champctl refused to send.
 *
 * Extends `AcsmError` because that is what it is — a failure talking to ACSM —
 * and because every CLI already has a branch for `AcsmError` that reports it as
 * such. Extending plain `Error` meant those branches missed it and it fell
 * through to the catch-all, so a refused save was reported as "champctl itself
 * failed" rather than as ACSM saying no.
 */
export class AcsmWriteError extends AcsmError {
  constructor(message: string, status?: number, url?: string) {
    super(message, status, url)
    this.name = "AcsmWriteError"
  }
}

/**
 * Minimal cookie jar for a **single origin**.
 *
 * Stores whatever `Set-Cookie` pairs arrive, by name, and sends them all back.
 * It does not know or care which cookie is the session: ACSM names that
 * differently across versions — 2.4.5 calls it `_acsm_data`, older builds
 * don't — and assuming a name is what previously made a good login look like a
 * failure. champctl sets `current-server` itself; everything else comes from
 * the server.
 *
 * There is deliberately no host, path or domain handling. That is safe only
 * because `AcsmSession` refuses to request anything off its base origin,
 * including via a redirect — see `url()`. It is small enough to audit, which is
 * the point for something that holds admin credentials, and it is why a full
 * jar such as `tough-cookie` would be mostly dead weight here: domain matching
 * and the public-suffix list solve a problem this design does not have.
 *
 * *Parsing* is another matter, and is not ours. `Set-Cookie` has quoting rules,
 * two ways to express an expiry and a precedence between them, and a date
 * format of its own; a hand-rolled version of that got the Max-Age/Expires
 * precedence wrong on the first attempt. `undici.getSetCookies` is the parser
 * Node's own `fetch` uses, and it is already in the dependency tree via
 * cheerio.
 *
 * If champctl ever needs to talk to two managers at once, that's two sessions
 * with two jars, not a jar that learned about hosts.
 */
export class CookieJar {
  readonly #cookies = new Map<string, string>()

  storeFromResponse(res: { headers: Headers }): void {
    const raw = readSetCookieLines(res.headers)

    parseSetCookies(res.headers).forEach((cookie, i) => {
      // An expiry already past is a delete, and so is an empty value. Max-Age
      // wins over Expires where both appear (RFC 6265) — a cookie with a stale
      // Expires and a live Max-Age is being *kept*.
      //
      // The `negativeMaxAge` clause is a gap in the parser rather than in the
      // spec: RFC 6265 §5.2.2 says a delta-seconds of zero *or less* expires
      // the cookie immediately, and undici surfaces `Max-Age=0` but drops
      // `Max-Age=-1` entirely — measured. Without this the cookie would read
      // as having no expiry at all and be kept.
      const negativeMaxAge = /(^|;)\s*max-age\s*=\s*-\d+/i.test(raw[i] ?? "")
      const expired =
        negativeMaxAge ||
        (cookie.maxAge !== undefined
          ? cookie.maxAge <= 0
          : cookie.expires !== undefined && new Date(cookie.expires).getTime() <= Date.now())

      if (cookie.value === "" || expired) this.#cookies.delete(cookie.name)
      else this.#cookies.set(cookie.name, cookie.value)
    })
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

/**
 * `Set-Cookie` lines, parsed.
 *
 * The cast is the one wart. undici ships its own `Headers` type, structurally
 * close to but not identical with the global one Node's lib declares, and the
 * two don't unify. Confining that to a single function is better than either
 * threading undici's types through the session or losing the parser.
 */
function parseSetCookies(headers: Headers): ReturnType<typeof getSetCookies> {
  return getSetCookies(headers as unknown as Parameters<typeof getSetCookies>[0])
}

/** The unparsed lines, in the same order, for the one attribute undici drops. */
function readSetCookieLines(headers: Headers): string[] {
  const withGetter = headers as Headers & { getSetCookie?: () => string[] }
  if (typeof withGetter.getSetCookie === "function") return withGetter.getSetCookie()
  const single = headers.get("set-cookie")
  return single ? [single] : []
}

/** Enough for ACSM's own hops; a loop is a bug worth surfacing, not chasing. */
const MAX_REDIRECTS = 5

/**
 * The five status codes that actually mean "go here instead".
 *
 * Deliberately not `>= 300 && < 400`. That range also holds 304 Not Modified,
 * 305 Use Proxy and the unused 306 — and 304 is the dangerous one, because it
 * is a cache-validation response that a cache or reverse proxy may emit
 * carrying the stored `Location` and `Set-Cookie` headers of the response it
 * stands in for. Under the old test a 304 quoting `Location: /` was
 * indistinguishable from a successful login, so `login()` could hand back a
 * session that had never been authenticated.
 *
 * 303 is included because ACSM's own POST handlers use it; 307/308 because a
 * proxy in front may. Anything outside this set is not a redirect and must not
 * be followed or read for a `Location`.
 */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])

/** Exported so the write path judges "did ACSM redirect?" by the same rule. */
export function isRedirectStatus(status: number): boolean {
  return REDIRECT_STATUSES.has(status)
}

function isRedirect(res: Response): boolean {
  return isRedirectStatus(res.status)
}

function describeLoginFailure(status: number): string {
  if (status === 200) {
    return "ACSM re-rendered the login page, which is what it does for a wrong username or password"
  }
  if (status === 500) return "ACSM returned a server error; check its logs"
  if (status === 304) {
    return (
      "something answered the login POST with 304 Not Modified, which is a cache talking rather " +
      "than Server Manager — champctl sends no conditional-request headers. Look for a caching " +
      "proxy in front of it"
    )
  }
  return `unexpected HTTP ${status}`
}

/**
 * Points at the usual reason a password that looks right isn't.
 *
 * A `.env` saved with CRLF endings leaves a carriage return on the value when
 * sourced, and surrounding quotes survive if the file is read by something
 * that doesn't strip them. Both produce a password that looks correct in a
 * terminal and isn't.
 */
function describeCredentialShape(password: string): string {
  const notes: string[] = []
  if (/[\r\n]/.test(password)) {
    notes.push(
      "the password contains a line break — if docker/.env has Windows line endings, sourcing it leaves a carriage return on the value",
    )
  }
  if (password !== password.trim()) {
    notes.push("the password has leading or trailing whitespace")
  }
  if (/^(".*"|'.*')$/s.test(password)) {
    notes.push("the password is wrapped in quotes, which are being sent as part of it")
  }
  if (password === "") notes.push("the password is empty")
  return notes.length > 0 ? `. Also worth knowing: ${notes.join("; ")}` : ""
}

export interface AcsmSessionOptions {
  baseUrl: string
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  /**
   * Requests per window, or `false` for none.
   *
   * Defaults to ACSM's documented limit, same as the reader. The write path
   * had no limiter at all, which was fine against a throwaway container and
   * not against a league's production manager — and the write path is the one
   * that fetches a form, posts it, then fetches and posts a schedule, four
   * requests deep, for every round of a month.
   */
  rateLimit?: RateLimiterOptions | false
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
  readonly #serverIndex: string
  readonly #limiter: RateLimiter | undefined
  readonly jar = new CookieJar()
  #loggedInAs: string | undefined

  constructor(options: AcsmSessionOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "")
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.#timeoutMs = options.timeoutMs ?? 30_000
    this.#userAgent = options.userAgent ?? "acsm-champctl/0.1"
    this.#serverIndex = String(options.serverIndex ?? 0)
    this.#limiter =
      options.rateLimit === false ? undefined : new RateLimiter(options.rateLimit ?? {})
    this.jar.set("current-server", this.#serverIndex)
  }

  get baseUrl(): string {
    return this.#baseUrl
  }

  get username(): string | undefined {
    return this.#loggedInAs
  }

  get isLoggedIn(): boolean {
    // Not a cookie-name check: 2.4.5 calls its session `_acsm_data` and older
    // builds don't, so `login()` records this on a successful redirect instead.
    return this.#loggedInAs !== undefined
  }

  /**
   * Resolves a path against the base URL.
   *
   * Absolute URLs are allowed only when they land on the base origin. The jar
   * has no host scoping, so every request carries the session cookie — and a
   * request to another host would hand ACSM admin credentials to whoever runs
   * it. Cheap to enforce here, and it keeps the jar honest.
   */
  url(path: string): string {
    if (!/^https?:\/\//i.test(path)) return `${this.#baseUrl}${path}`

    let target: URL
    try {
      target = new URL(path)
    } catch {
      throw new AcsmWriteError(`Not a usable URL: ${path}`)
    }
    if (target.origin !== new URL(this.#baseUrl).origin) {
      throw new AcsmWriteError(
        `Refusing to request ${target.origin} from a session logged in to ` +
          `${new URL(this.#baseUrl).origin} — this session's cookies belong to that origin only.`,
      )
    }
    return target.toString()
  }

  /**
   * POST /login with Username and Password. No CSRF token.
   *
   * Success is judged by the redirect, not by a cookie name. ACSM's handler
   * (`accounts.go`) does exactly three things:
   *
   *   - success            -> 302 to "/"
   *   - needs new password -> 302 to "/accounts/new-password"
   *   - bad credentials    -> falls through and renders login.html with a 200
   *
   * An earlier version looked for a cookie called `_acsm_data`, which is what
   * 2.4.5 calls its session. Older builds name it differently, so a perfectly
   * good login was reported as a failure. The redirect is the part that hasn't
   * changed.
   *
   * `RememberMe` is sent because 2.4.5's form has it; 1.7.x's doesn't, and Go
   * ignores form fields it doesn't read.
   */
  async login(credentials: LoginCredentials): Promise<void> {
    const username = credentials.username
    const password = credentials.password

    // Drop any previous identity first. Re-logging in and failing must not
    // leave isLoggedIn true from the attempt before — a caller checking it
    // would go on to make writes with a session that is no longer valid.
    this.#loggedInAs = undefined
    this.jar.clear()
    this.jar.set("current-server", this.#serverIndex)

    const body = new URLSearchParams({
      Username: username,
      Password: password,
      RememberMe: "on",
    })

    const res = await this.#request("/login", {
      method: "POST",
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    })

    const location = res.headers.get("location") ?? ""

    // #loggedInAs is set only on the fully-successful path below. Every other
    // branch throws and leaves isLoggedIn false: a caller that catches an
    // AcsmAuthError and carries on must not find a session that looks usable
    // when it isn't.

    // A first login, or one after an admin password reset, lands here and no
    // write will work until it's dealt with in the browser.
    if (isRedirect(res) && location.includes("new-password")) {
      throw new AcsmAuthError(
        `${username} must set a new password in ACSM before champctl can use this account. ` +
          `Log in at ${this.#baseUrl} in a browser, set one, and put it in CHAMPCTL_LIVE_PASSWORD.`,
      )
    }

    // Specifically a redirect to "/", which is what accounts.go does on
    // success. Any other 3xx is somebody else talking — an auth proxy, a TLS
    // redirect, a captive portal — and treating those as a login would hand
    // the caller a session that isn't one.
    if (isRedirect(res) && this.#redirectsToRoot(location)) {
      if (this.jar.names.length <= 1) {
        // Only `current-server`, which we set ourselves. ACSM said yes but gave
        // us nothing to authenticate with, so the session is not usable.
        throw new AcsmAuthError(
          `ACSM accepted the login for ${username} but set no session cookie, so nothing else will work. ` +
            `Check that config.yml's http.session_key is set.`,
          res.status,
        )
      }
      this.#loggedInAs = username
      return
    }

    if (isRedirect(res)) {
      throw new AcsmAuthError(
        `Login as ${username} was redirected to ${location || "(no Location header)"} rather than "/". ` +
          `ACSM sends a successful login to "/", so something else answered — an auth proxy, ` +
          `or ${this.#baseUrl} isn't Server Manager.`,
        res.status,
      )
    }

    throw new AcsmAuthError(
      `Login as ${username} failed: ${describeLoginFailure(res.status)}${describeCredentialShape(password)}`,
      res.status,
    )
  }

  /**
   * True when a Location header points at this server's root.
   *
   * Accepts `/`, an absolute URL on our own origin with an empty path, and a
   * query string on either — Go writes a bare `/`, but a build behind a
   * configured `server_manager_base_URL` may write it out in full.
   */
  #redirectsToRoot(location: string): boolean {
    if (!location) return false
    try {
      const target = new URL(location, this.#baseUrl)
      if (target.origin !== new URL(this.#baseUrl).origin) return false
      return target.pathname === "/" || target.pathname === ""
    } catch {
      return false
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
    // Stripped before the check, so the arity check runs on what goes out.
    //
    // ACSM reads these two positionally but renders them unpaired, so a
    // browser omits the unchecked ones and whichever values remain land on the
    // wrong entrants (docs/acsm-write-path.md §4). form.ts has documented that
    // champctl omits them since it was written; nothing did, and every write
    // echoed back whatever the form had rendered. Absent means "false for
    // everyone" — the only reading that cannot silently apply one entrant's
    // setting to another.
    const sent = stripUnpairedCheckboxes(fields)

    const problems = checkEntryListShape(sent)
    if (problems.length > 0) {
      const detail = problems
        .map((p) => (p.count === 0 ? `${p.key} is missing` : `${p.key} has ${p.count}`))
        .join("; ")
      // Two different mistakes share this refusal, and they need different
      // advice: a ragged array is usually a mutation bug, a missing key is
      // usually a form champctl didn't parse as expected.
      const missing = problems.some((p) => p.count === 0)
      const hint = missing
        ? `A key champctl never saw is a parsing problem, not a mutation one — run ` +
          `\`npm run recon:forms\` against this manager and compare what the form ` +
          `renders with REQUIRED_ENTRY_LIST_FIELDS in form.ts.`
        : `If one of those keys is a form-level field rather than a per-entrant ` +
          `array, add it to NON_ARRAY_ENTRY_LIST_FIELDS in form.ts.`
      throw new AcsmWriteError(
        `Refusing to POST ${path}: the entry list arrays don't line up ` +
          `(${problems[0]!.expected} entrants; ${detail}). ACSM reads these as parallel ` +
          `arrays, so sending this would give entrants each other's data. ${hint}`,
        undefined,
        path,
      )
    }

    const res = await this.#request(path, {
      method: "POST",
      body: toBody(sent),
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

  /**
   * Every request goes out with `redirect: "manual"`.
   *
   * Letting fetch follow redirects would mean trusting it not to carry a
   * hand-set `Cookie` header across an origin boundary. Following them here
   * instead makes the same-origin rule ours to enforce, and it's four lines.
   *
   * Callers that pass `redirect: "manual"` want the 3xx itself — the login
   * POST and the form POSTs read the `Location` header.
   */
  async #request(path: string, init: RequestInit): Promise<Response> {
    const wantsRawRedirect = init.redirect === "manual"
    let res = await this.#fetchOnce(path, init)

    for (let hop = 0; !wantsRawRedirect && isRedirect(res) && hop < MAX_REDIRECTS; hop++) {
      const location = res.headers.get("location")
      if (!location) break
      // `this.url()` throws on an off-origin target, so an ACSM that redirects
      // somewhere else fails loudly rather than leaking the session cookie.
      const next = this.url(new URL(location, this.url(path)).toString())

      // 303 — and, by long convention, 301/302 on a POST — become a GET with
      // no body. 307 and 308 exist precisely to say "repeat what you sent",
      // and rewriting those to GET would turn a redirected write into a read
      // that silently did nothing.
      //
      // Not reachable today, and kept anyway: every POST in this class sets
      // `redirect: "manual"` because it reads the `Location` itself, so this
      // loop only ever sees GETs, where the distinction doesn't arise. It is
      // six lines against the day someone lets a write follow a redirect, and
      // the failure it prevents — a save that reports success and changes
      // nothing — is the kind you don't notice until race night.
      const keepsMethod = res.status === 307 || res.status === 308
      if (keepsMethod) {
        res = await this.#fetchOnce(next, init)
      } else {
        const headers = new Headers(init.headers)
        headers.delete("Content-Type")
        res = await this.#fetchOnce(next, { ...init, method: "GET", body: null, headers })
      }
    }

    return res
  }

  async #fetchOnce(path: string, init: RequestInit): Promise<Response> {
    // Resolve before opening the timer, so an off-origin URL fails loudly
    // rather than being reported as a request failure.
    const url = this.url(path)

    // Before the timeout starts, so time spent queueing behind the limiter
    // isn't counted against the request's own deadline.
    await this.#limiter?.acquire()

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    try {
      const headers = new Headers(init.headers)
      headers.set("User-Agent", this.#userAgent)
      const cookie = this.jar.header()
      if (cookie) headers.set("Cookie", cookie)

      const res = await this.#fetch(url, {
        ...init,
        headers,
        redirect: "manual",
        signal: controller.signal,
      })
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
