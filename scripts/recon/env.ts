/**
 * Shared setup for the recon scripts.
 *
 * Every one of these talks to a *throwaway* ACSM. There is a guard below that
 * refuses to run against anything that isn't obviously local unless you say so
 * out loud, because these scripts write to the server they point at: each run
 * imports a new championship, and `seedChampionship` reads an existing one to
 * copy.
 *
 * They do NOT clean up after themselves. Each run leaves its imported
 * championship behind and prints how to remove it, because the usual reason to
 * run recon is to go and look at what it made. `npm run harness:reset` is the
 * blunt way to clear them out.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { assertDisposable as assertDisposableHost } from "../../src/acsm/disposable.js"
import { AcsmSession } from "../../src/acsm/session.js"
import type { Championship } from "../../src/acsm/types.js"
import { exportAsReimportableCopy, listChampionshipIds } from "../../src/acsm/write.js"

export interface ReconEnv {
  baseUrl: string
  username: string
  password: string
}

export function readEnv(): ReconEnv {
  const rawBaseUrl = process.env["CHAMPCTL_LIVE_URL"]
  const rawUsername = process.env["CHAMPCTL_LIVE_USERNAME"] ?? "admin"
  const password = process.env["CHAMPCTL_LIVE_PASSWORD"]

  if (!rawBaseUrl) {
    throw new Error(
      "CHAMPCTL_LIVE_URL is not set. Start the harness with `npm run harness:up`, then `set -a && . docker/.env && set +a`.",
    )
  }
  if (!password) {
    throw new Error("CHAMPCTL_LIVE_PASSWORD is not set. See docker/.env.example.")
  }

  // A .env with CRLF endings leaves a carriage return on every value when
  // sourced. On the URL that's a confusing connection error; on the password
  // it's an authentication failure that looks like a wrong password. Trim the
  // URL and username silently — neither can legitimately contain whitespace —
  // and leave the password alone, since only the user can say whether the
  // whitespace is real. `login()` explains it if authentication then fails.
  const baseUrl = rawBaseUrl.trim()
  const username = rawUsername.trim()

  if (/[\r\n]/.test(password)) {
    process.stderr.write(
      "champctl: CHAMPCTL_LIVE_PASSWORD contains a line break. If docker/.env has Windows\n" +
        "          line endings, sourcing it leaves a carriage return on the value and the\n" +
        "          login will fail. Fix with: sed -i 's/\\r$//' docker/.env\n\n",
    )
  }

  assertDisposable(baseUrl)
  return { baseUrl, username, password }
}

/**
 * These scripts write to and delete from the manager they point at. Pointing
 * one at a league's production server would be the worst thing this repo can
 * do, so anything outside a private network needs the explicit override.
 */
export function assertDisposable(baseUrl: string): void {
  assertDisposableHost(baseUrl, "recon")
}

export async function connect(): Promise<AcsmSession> {
  const env = readEnv()
  const session = new AcsmSession({ baseUrl: env.baseUrl })
  await session.login({ username: env.username, password: env.password })
  return session
}

export const RECON_DIR = resolve(process.cwd(), "fixtures/recon")

/** Writes a recon artefact, creating the directory as needed. */
export async function writeArtefact(relativePath: string, data: unknown): Promise<string> {
  const path = resolve(RECON_DIR, relativePath)
  await mkdir(dirname(path), { recursive: true })
  const body = typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`
  await writeFile(path, body, "utf8")
  return path
}

export function log(message: string): void {
  process.stdout.write(`${message}\n`)
}

/**
 * A base URL with the host removed, for writing into a committed artefact.
 *
 * The scheme and port are the parts worth keeping — they say whether the
 * capture came from the premium service or the oss profile. The host is
 * somebody's LAN address or internal hostname, and these files are public.
 */
export function redactBaseUrl(baseUrl: string): string {
  try {
    const u = new URL(baseUrl)
    return `${u.protocol}//<redacted>${u.port ? `:${u.port}` : ""}`
  } catch {
    return "<redacted>"
  }
}

/**
 * A championship to experiment on.
 *
 * Prefers copying one that already exists on the server. A hand-built fixture
 * is a guess at *this version's* Go struct, and `ImportChampionship` is a
 * single `json.Unmarshal` — one type mismatch and the whole import fails, with
 * ACSM reporting only "Check your JSON formatting". An export is by definition
 * the right shape for the build that produced it.
 *
 * ACSM ships example championships, so there is usually something to copy. The
 * synthetic fixture stays as a fallback for a genuinely empty server.
 */
export async function seedChampionship(
  session: AcsmSession,
  fallbackFixture: string,
  name: string,
  options: { keepSignUpsEnabled?: boolean } = {},
): Promise<{ championship: Championship; source: string }> {
  const existing = await listChampionshipIds(session)

  for (const id of existing) {
    try {
      const copy = await exportAsReimportableCopy(session, id, name, options)
      return { championship: copy, source: `copy of championship ${id} on this server` }
    } catch (e) {
      log(`  (couldn't copy ${id}: ${e instanceof Error ? e.message : String(e)})`)
    }
  }

  log("  No existing championship to copy; falling back to the synthetic fixture.")
  log("  If the import is rejected, that fixture doesn't match this version's schema —")
  log("  create any championship in the UI and re-run, which is a better test anyway.")
  const raw = await readFile(resolve(process.cwd(), fallbackFixture), "utf8")
  return { championship: JSON.parse(raw) as Championship, source: fallbackFixture }
}

/** Runs a recon main(), reporting failures without a stack wall. */
export async function runRecon(name: string, main: () => Promise<void>): Promise<void> {
  try {
    await main()
  } catch (e) {
    process.stderr.write(`${name} failed: ${e instanceof Error ? e.message : String(e)}\n`)
    process.exitCode = 1
  }
}
