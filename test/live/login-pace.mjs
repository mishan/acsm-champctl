/**
 * Waiting your turn at ACSM's login limiter, in every process that logs in.
 *
 * 2.4.x allows five requests per twenty seconds on `/login` and answers 429
 * past that. Measured on 2.4.15, it is the *only* route with a limiter: eight
 * rapid `GET /championships` and eight `GET /healthcheck.json` all answered
 * 200, while the sixth `POST /login` in a second answered 429. The public
 * 1.7.9 build has no limiter at all — eight rapid logins, all 302, and no
 * `X-Ratelimit-*` headers — so nothing here does anything against it.
 *
 * The suites make a lot of logins. Each CLI write command constructs a fresh
 * session and logs in, `web.live.test.ts` signs in through `/api/login`
 * because that round trip is what it exists to prove, the browser suite signs
 * in through a real form three times, and every file takes a session of its
 * own. champctl's own limiter cannot help: the thing being limited is a
 * session that has never seen the others.
 *
 * **Plain JavaScript, and that is deliberate.** The browser suite's logins go
 * through a `champctl-serve` subprocess, which this reaches by way of
 * `NODE_OPTIONS=--import` — and node resolves that before tsx registers a
 * TypeScript loader, so a `.ts` preload fails with `ERR_UNKNOWN_FILE_EXTENSION`
 * before anything starts. `login-pace.d.mts` gives the TypeScript callers their
 * types.
 *
 * **The window lives in a file**, because the processes that have to share it
 * are separate ones: vitest gives each test file its own, Playwright's workers
 * are their own again, and the server under test is a third. Module state paced
 * one file and reset for the next — which is what was failing, as three of four
 * live files dying in `beforeAll` on a limiter the fourth had spent.
 */

import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const WINDOW_MS = 20_000

/**
 * Four per window against a limit of five, deliberately.
 *
 * The spare slot is for a login this pacer cannot see: `npm run
 * harness:provision` immediately before a run, someone signed in to the
 * harness in a browser, a previous run killed mid-flight. Spending the budget
 * exactly makes a suite fail whenever anything else touches `/login` at the
 * wrong moment, which is a flake that reads as a champctl bug.
 */
const PER_WINDOW = 4

/** Enough that a wait which computes to nothing still makes progress. */
const MIN_SLEEP_MS = 250

/** One pre-emptive wait, then at most two goes at waiting out a 429. */
const MAX_ATTEMPTS = 3

/**
 * One file per manager, so two harnesses on one machine don't share a budget.
 *
 * Hashed rather than used directly: a base URL contains characters a filename
 * cannot, and the readable part is the fixed prefix.
 *
 * @param {string} baseUrl
 * @returns {string}
 */
export function paceStatePath(baseUrl) {
  const key = createHash("sha256").update(baseUrl).digest("hex").slice(0, 16)
  return join(tmpdir(), `champctl-login-pace-${key}.json`)
}

/**
 * Resolves when it is this caller's turn to log in, having claimed a slot.
 *
 * @param {{ statePath?: string, now?: () => number, sleep?: (ms: number) => Promise<void> }} [options]
 * @returns {Promise<void>}
 */
export async function paceLogin(options = {}) {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const path = options.statePath ?? paceStatePath(process.env["CHAMPCTL_LIVE_URL"] ?? "")

  let stamps = await read(path)
  for (;;) {
    // Re-read the clock and re-check after every sleep, rather than sleeping
    // once and assuming a slot came free. That assumption is what makes an
    // early wake-up a fifth login inside the window instead of a second wait.
    const at = now()
    stamps = stamps.filter((s) => at - s < WINDOW_MS)
    if (stamps.length < PER_WINDOW) break
    // A little past the expiry, not exactly at it: this clock and ACSM's agree
    // to within a few milliseconds at best, and arriving one tick early spends
    // the whole wait and gets a 429 anyway.
    //
    // Floored, so the loop always moves forward. Without that, a wait that
    // computes to zero — which an early wake-up on the previous pass produces
    // exactly — spins as fast as the event loop allows, which is the same hang
    // `RateLimiter` refuses a limit of zero to avoid.
    await sleep(Math.max(WINDOW_MS - (at - stamps[0]) + 250, MIN_SLEEP_MS))
  }

  stamps.push(now())
  await write(path, stamps)
}

/**
 * Whatever is on disk, or nothing.
 *
 * A missing file is the first run; an unreadable or malformed one is a pacer
 * that has lost track of the window, and starting the window over is the same
 * risk as the process that wrote it having exited twenty seconds ago. Neither
 * is worth failing a test suite over.
 *
 * @param {string} path
 * @returns {Promise<number[]>}
 */
async function read(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((n) => typeof n === "number" && Number.isFinite(n))
  } catch {
    return []
  }
}

/**
 * @param {string} path
 * @param {readonly number[]} stamps
 * @returns {Promise<void>}
 */
async function write(path, stamps) {
  try {
    await writeFile(path, JSON.stringify(stamps), "utf8")
  } catch {
    // Losing the window costs a 429 and a re-run; failing here costs the suite.
  }
}

/**
 * Pace every login this process makes, by wrapping `fetch`.
 *
 * Wrapping rather than adding a call at each site, because the sites are not
 * all reachable: `cli.live.test.ts` calls `main()` in process and the login
 * happens several layers down inside a CLI, the browser suite's happen inside
 * a `champctl-serve` subprocess, `harness.ts` logs in directly. One wrapper
 * covers all of them, and it counts the request ACSM actually limits rather
 * than a proxy for it — the pacer this replaces ran before every CLI
 * invocation, including `gridmom` and `champctl-archive`, which are
 * credential-free and never log in at all.
 *
 * Only ever installed by a test suite. `src/` is untouched, and champctl still
 * fails a 429 outright and says to wait twenty seconds, which is right for a
 * person at a terminal and wrong for a suite that knows how many logins it is
 * about to make.
 *
 * Pacing alone is not enough, so a 429 is waited out and retried. The pacer can
 * only count its own logins, and one from anywhere else spends the slot it was
 * holding in reserve — `npm run harness:provision` runs immediately before the
 * browser suite in CI and does exactly that. ACSM says when the window
 * reopens, so the wait is read rather than guessed.
 */
function install() {
  const real = globalThis.fetch
  // Idempotent: the browser suite imports this *and* passes it to the server
  // subprocess through NODE_OPTIONS, which node applies twice — once in tsx's
  // parent and once in its child.
  if (real.__champctlPaced) return

  /** @type {typeof globalThis.fetch} */
  const paced = async (input, init) => {
    if (!isLogin(input, init)) return real(input, init)

    // Re-sending is safe here and would not be in general: `AcsmSession` posts
    // a login as a URL-encoded string, so the body survives being sent twice.
    // A `Request` with a streamed body would not, which is why this narrow
    // case is the only one that retries.
    for (let attempt = 1; ; attempt++) {
      await paceLogin()
      const res = await real(input, init)
      if (res.status !== 429 || attempt >= MAX_ATTEMPTS) return res
      await sleepUntilWindowReopens(res)
    }
  }

  paced.__champctlPaced = true
  globalThis.fetch = paced
}

/**
 * @param {Parameters<typeof globalThis.fetch>[0]} input
 * @param {RequestInit} [init]
 * @returns {boolean}
 */
function isLogin(input, init) {
  const request = typeof input === "object" && "url" in input ? input : undefined
  const method = init?.method ?? request?.method ?? "GET"
  if (method.toUpperCase() !== "POST") return false

  const raw = request ? request.url : String(input)
  try {
    // ACSM's login route. champctl's own `/api/login` is not it: that one
    // reaches ACSM's, and pacing both would spend two slots for one login.
    return new URL(raw).pathname.replace(/\/$/, "") === "/login"
  } catch {
    return false
  }
}

/**
 * ACSM's `X-Ratelimit-Reset` is unix seconds, and the window is 20s wide.
 * Bounded, so a header that says something absurd cannot hang a suite instead
 * of failing it.
 *
 * @param {Response} res
 * @returns {Promise<void>}
 */
async function sleepUntilWindowReopens(res) {
  const reset = Number(res.headers.get("x-ratelimit-reset"))
  const until = Number.isFinite(reset) && reset > 0 ? reset * 1000 - Date.now() : WINDOW_MS
  const wait = Math.min(Math.max(until + 250, MIN_SLEEP_MS), 25_000)
  await new Promise((r) => setTimeout(r, wait))
}

install()
