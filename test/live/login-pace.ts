/**
 * Waiting your turn at ACSM's login limiter.
 *
 * ACSM allows about five requests per twenty seconds on `/login` and answers
 * 429 past that. Measured on 2.4.15, it is the *only* route with a limiter:
 * eight rapid `GET /championships` and eight `GET /healthcheck.json` all
 * answered 200, while the sixth `POST /login` in a second answered 429. So
 * this is not a general politeness budget — champctl's own rate limiter is off
 * against a throwaway harness on purpose — it is one endpoint, and every login
 * the live suite makes has to fit through it.
 *
 * There are a lot of them. Each CLI write command constructs a fresh session
 * and logs in, `web.live.test.ts` signs in through `/api/login` for most of
 * its tests because that round trip is what it exists to prove, and each file
 * takes a session of its own in `beforeAll`. champctl's limiter cannot help:
 * the thing being limited is a session that has never seen the others.
 *
 * **The window lives in a file, and that is the fix.** `cli.live.test.ts` had
 * this logic in module scope, which paced that one file and nothing else —
 * vitest gives each test file its own module registry, so the counter reset
 * four times a run and each file began believing it had the whole budget. What
 * that looked like was three of the four files failing in `beforeAll`, on the
 * login every test after it depends on, with the file that happened to run
 * first passing. A file under the temp directory is shared across those
 * processes, and also across a live run started shortly after a browser-suite
 * run, which is the same 429 from the person's point of view.
 *
 * Paced rather than retried, so a 429 champctl provokes some other way still
 * surfaces as one.
 */

import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const WINDOW_MS = 20_000

/**
 * Four per window against a limit of five, deliberately.
 *
 * The spare slot is for a login this pacer cannot see: someone signing in to
 * the harness in a browser, or a stray script. Spending the budget exactly
 * makes the suite fail whenever anything else touches `/login` at the wrong
 * moment, which is a flake that reads as a champctl bug.
 */
const PER_WINDOW = 4

/** Enough that a wait which computes to nothing still makes progress. */
const MIN_SLEEP_MS = 250

export interface PaceOptions {
  /** Where the window is kept. Defaults to a path derived from the base URL. */
  statePath?: string
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/**
 * One file per manager, so two harnesses on one machine don't share a budget.
 *
 * Hashed rather than used directly: a base URL contains characters a filename
 * cannot, and the readable part is the fixed prefix.
 */
export function paceStatePath(baseUrl: string): string {
  const key = createHash("sha256").update(baseUrl).digest("hex").slice(0, 16)
  return join(tmpdir(), `champctl-login-pace-${key}.json`)
}

/** Resolves when it is this caller's turn to log in, having claimed a slot. */
export async function paceLogin(options: PaceOptions = {}): Promise<void> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
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
    await sleep(Math.max(WINDOW_MS - (at - stamps[0]!) + 250, MIN_SLEEP_MS))
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
 */
async function read(path: string): Promise<number[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((n): n is number => typeof n === "number" && Number.isFinite(n))
  } catch {
    return []
  }
}

async function write(path: string, stamps: readonly number[]): Promise<void> {
  try {
    await writeFile(path, JSON.stringify(stamps), "utf8")
  } catch {
    // Losing the window costs a 429 and a re-run; failing here costs the suite.
  }
}
