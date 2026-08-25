/**
 * Gate for the live suite.
 *
 * These tests need a running ACSM and they create and delete championships, so
 * they are opt-in via CHAMPCTL_LIVE_URL and refuse anything that doesn't look
 * like a throwaway container. Without the env var they skip, which keeps
 * `npm test` green on a machine with no Docker.
 */

import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { assertDisposable } from "../../src/acsm/disposable.js"
import { AcsmSession } from "../../src/acsm/session.js"
import type { Championship } from "../../src/acsm/types.js"
import { events } from "../../src/acsm/view.js"
import { readFormat, type RaceFormat } from "../../src/finalize/format.js"

export interface LiveConfig {
  baseUrl: string
  username: string
  password: string
}

export function liveConfig(): LiveConfig | undefined {
  const rawBaseUrl = process.env["CHAMPCTL_LIVE_URL"]
  const password = process.env["CHAMPCTL_LIVE_PASSWORD"]
  if (!rawBaseUrl || !password) return undefined

  // Trimmed for the same reason the recon loader trims: a .env with CRLF
  // endings leaves a carriage return on every value when sourced, and on the
  // URL that fails to parse during discovery — so the whole suite errors out
  // while the harness is sitting there working. Neither the URL nor the
  // username can legitimately contain surrounding whitespace. The password is
  // left alone; only the user can say whether that whitespace is real, and
  // login() explains it if authentication fails.
  const baseUrl = rawBaseUrl.trim()
  const username = (process.env["CHAMPCTL_LIVE_USERNAME"] ?? "admin").trim()

  assertDisposable(baseUrl, "live tests")

  return { baseUrl, username, password }
}

/** `describe.skipIf(!live)` reads badly; this reads as what it means. */
export const LIVE = liveConfig() !== undefined

export const SKIP_REASON = "set CHAMPCTL_LIVE_URL and CHAMPCTL_LIVE_PASSWORD to run against docker/"

export async function liveSession(): Promise<AcsmSession> {
  const config = liveConfig()
  if (!config) throw new Error(SKIP_REASON)
  // No rate limiting. The 5-per-20s default exists to be polite to a league's
  // production manager (plan §3.1); against a throwaway container it only
  // throttles the suite. It is not a small effect — the write path is several
  // requests per test, so at 4 seconds each the 21 tests here took over ten
  // minutes and could not finish inside a CI step. `assertDisposable` above
  // has already established this is a disposable host.
  const session = new AcsmSession({ baseUrl: config.baseUrl, rateLimit: false })
  await session.login({ username: config.username, password: config.password })
  return session
}

export async function loadFixture(relativePath: string): Promise<Championship> {
  return JSON.parse(await readFile(resolve(process.cwd(), relativePath), "utf8")) as Championship
}

export const SEED = "fixtures/synthetic/recon-seed.json"

/**
 * Refuses a plan that has nothing to do.
 *
 * Every test in this suite seeds from the same fixture, so "ask for 12 laps"
 * is a different request depending on what the fixture already races — and
 * when it matches, the plan is a no-op, `applyFinalize` returns early, and the
 * write under test never happens. Nothing fails: the assertions that follow
 * are typically of the form "the entry list is untouched" or "the other
 * sessions survived", and a write that never ran satisfies all of them.
 *
 * That is the worst shape a test can take, because it reports success for the
 * absence of the thing it exists to check. This turns it into a failure that
 * names the cause, at the point where the plan was made rather than several
 * assertions later.
 *
 * `seedFormat` is the way to avoid needing this: derive the value from the
 * fixture instead of writing a literal that a future edit to the seed can
 * silently collide with.
 */
export function assertWouldChange(plan: { noop: boolean }, asked: string): void {
  if (!plan.noop) return
  throw new Error(
    `The plan for ${asked} has nothing to do, so the write it was meant to exercise never ` +
      `happens — and a test asserting that nothing else changed then passes for the wrong ` +
      `reason. The seed fixture already races that format. Pick a value it does not, ` +
      `ideally by deriving one from seedFormat() rather than writing a literal.`,
  )
}

/** The race format the seed fixture's first event already has. */
export async function seedFormat(): Promise<RaceFormat> {
  const champ = await loadFixture(SEED)
  const event = events(champ)[0]
  if (!event)
    throw new Error(`${SEED} has no first event, so there is nothing to read a format from`)
  return readFormat(event)
}

/**
 * A lap count the seed does not already race, so a plan for it always changes
 * something. Deliberately derived rather than chosen: a literal is only
 * correct until somebody edits the fixture.
 */
export async function lapsUnlikeSeed(): Promise<number> {
  const current = await seedFormat()
  const seeded = current.length.kind === "laps" ? current.length.laps : 0
  return seeded === 17 ? 23 : 17
}
export const SEED_DUPLICATE_PITBOXES = "fixtures/synthetic/recon-seed-duplicate-pitboxes.json"

/** Best-effort teardown; the definitive reset is `docker compose down -v`. */
export async function deleteChampionship(
  session: AcsmSession,
  championshipId: string,
): Promise<void> {
  try {
    await session.getText(`/championship/${championshipId}/delete`)
  } catch {
    // Leaving a stray test championship behind is untidy, not a test failure.
  }
}
