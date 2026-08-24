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

import { AcsmSession } from "../../src/acsm/session.js"
import type { Championship } from "../../src/acsm/types.js"

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "host.docker.internal"])

export interface LiveConfig {
  baseUrl: string
  username: string
  password: string
}

export function liveConfig(): LiveConfig | undefined {
  const baseUrl = process.env["CHAMPCTL_LIVE_URL"]
  const password = process.env["CHAMPCTL_LIVE_PASSWORD"]
  if (!baseUrl || !password) return undefined

  const host = new URL(baseUrl).hostname
  if (!LOCAL_HOSTS.has(host) && process.env["CHAMPCTL_I_KNOW_THIS_ISNT_LOCAL"] !== "yes") {
    throw new Error(
      `Refusing to run live tests against ${host}: it doesn't look like a test container. ` +
        `These tests create and delete championships.`,
    )
  }

  return {
    baseUrl,
    username: process.env["CHAMPCTL_LIVE_USERNAME"] ?? "admin",
    password,
  }
}

/** `describe.skipIf(!live)` reads badly; this reads as what it means. */
export const LIVE = liveConfig() !== undefined

export const SKIP_REASON =
  "set CHAMPCTL_LIVE_URL and CHAMPCTL_LIVE_PASSWORD to run against docker/"

export async function liveSession(): Promise<AcsmSession> {
  const config = liveConfig()
  if (!config) throw new Error(SKIP_REASON)
  const session = new AcsmSession({ baseUrl: config.baseUrl })
  await session.login({ username: config.username, password: config.password })
  return session
}

export async function loadFixture(relativePath: string): Promise<Championship> {
  return JSON.parse(await readFile(resolve(process.cwd(), relativePath), "utf8")) as Championship
}

export const SEED = "fixtures/synthetic/recon-seed.json"
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
