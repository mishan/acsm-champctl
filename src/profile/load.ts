import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, isAbsolute, resolve } from "node:path"

import type { LeagueProfile, Weekday } from "./types.js"

const here = dirname(fileURLToPath(import.meta.url))
/** Repo root, from `src/profile/` or `dist/profile/`. */
const repoRoot = resolve(here, "..", "..")

export function builtInProfilePath(id: string): string {
  return resolve(repoRoot, "profiles", `${id}.json`)
}

/**
 * Loads a profile by id (`batl`) or by path (`./my-league.json`).
 * Throws with a readable message rather than a JSON parse error.
 */
export async function loadProfile(idOrPath: string): Promise<LeagueProfile> {
  const looksLikePath =
    idOrPath.includes("/") || idOrPath.includes("\\") || idOrPath.endsWith(".json")
  const path = looksLikePath
    ? isAbsolute(idOrPath)
      ? idOrPath
      : resolve(process.cwd(), idOrPath)
    : builtInProfilePath(idOrPath)

  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch {
    throw new Error(`Could not read league profile at ${path}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error(`League profile at ${path} is not valid JSON: ${String(e)}`)
  }

  return validateProfile(parsed, path)
}

/** Structural validation. Enough to fail loudly on a typo, not a full schema. */
export function validateProfile(v: unknown, source = "<inline>"): LeagueProfile {
  const bad = (msg: string): never => {
    throw new Error(`League profile ${source} is invalid: ${msg}`)
  }
  if (typeof v !== "object" || v === null) return bad("expected an object")
  const p = v as Record<string, unknown>

  if (typeof p["id"] !== "string" || !p["id"]) bad("missing `id`")
  if (typeof p["name"] !== "string" || !p["name"]) bad("missing `name`")

  const s = p["schedule"]
  if (typeof s !== "object" || s === null) bad("missing `schedule`")
  const sched = s as Record<string, unknown>
  const weekday = sched["weekday"]
  if (typeof weekday !== "number" || weekday < 1 || weekday > 7) {
    bad("`schedule.weekday` must be 1..7 (Monday..Sunday)")
  }
  if (typeof sched["qualiStart"] !== "string" || !/^\d{2}:\d{2}$/.test(sched["qualiStart"])) {
    bad("`schedule.qualiStart` must be `HH:mm`")
  }
  if (typeof sched["timezone"] !== "string" || !sched["timezone"]) {
    bad("`schedule.timezone` must be an IANA zone name")
  }
  for (const k of ["practiceMinutes", "qualiMinutes"] as const) {
    if (typeof sched[k] !== "number" || sched[k] < 0) bad(`\`schedule.${k}\` must be >= 0`)
  }

  const el = p["entryList"]
  if (typeof el !== "object" || el === null) bad("missing `entryList`")
  const entry = el as Record<string, unknown>
  if (typeof entry["targetSlots"] !== "number" || entry["targetSlots"] < 0) {
    bad("`entryList.targetSlots` must be >= 0")
  }

  if (
    p["baseline"] !== undefined &&
    (typeof p["baseline"] !== "object" || p["baseline"] === null)
  ) {
    bad("`baseline` must be an object")
  }

  const profile = v as LeagueProfile
  // Narrow the weekday now that it is range-checked.
  profile.schedule.weekday = profile.schedule.weekday as Weekday
  profile.baseline ??= {}
  return profile
}
