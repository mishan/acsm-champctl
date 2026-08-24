/**
 * Shared setup for the recon scripts.
 *
 * Every one of these talks to a *throwaway* ACSM. There is a guard below that
 * refuses to run against anything that isn't obviously local unless you say so
 * out loud, because the scripts create and delete championships.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { AcsmSession } from "../../src/acsm/session.js"

export interface ReconEnv {
  baseUrl: string
  username: string
  password: string
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "host.docker.internal"])

export function readEnv(): ReconEnv {
  const baseUrl = process.env["CHAMPCTL_LIVE_URL"]
  const username = process.env["CHAMPCTL_LIVE_USERNAME"] ?? "admin"
  const password = process.env["CHAMPCTL_LIVE_PASSWORD"]

  if (!baseUrl) {
    throw new Error(
      "CHAMPCTL_LIVE_URL is not set. Start the harness with `docker compose up -d` in docker/, then source docker/.env.",
    )
  }
  if (!password) {
    throw new Error("CHAMPCTL_LIVE_PASSWORD is not set. See docker/.env.example.")
  }

  assertDisposable(baseUrl)
  return { baseUrl, username, password }
}

/**
 * These scripts write to and delete from the manager they point at. Pointing
 * one at a league's production server would be the worst thing this repo can
 * do, so a non-local host requires CHAMPCTL_I_KNOW_THIS_ISNT_LOCAL=yes.
 */
export function assertDisposable(baseUrl: string): void {
  const host = new URL(baseUrl).hostname
  if (LOCAL_HOSTS.has(host)) return
  if (process.env["CHAMPCTL_I_KNOW_THIS_ISNT_LOCAL"] === "yes") return
  throw new Error(
    `Refusing to run recon against ${host}: it doesn't look like a local test container. ` +
      `These scripts create and delete championships. If you really mean it, set ` +
      `CHAMPCTL_I_KNOW_THIS_ISNT_LOCAL=yes.`,
  )
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

/** Runs a recon main(), reporting failures without a stack wall. */
export async function runRecon(name: string, main: () => Promise<void>): Promise<void> {
  try {
    await main()
  } catch (e) {
    process.stderr.write(`${name} failed: ${e instanceof Error ? e.message : String(e)}\n`)
    process.exitCode = 1
  }
}
