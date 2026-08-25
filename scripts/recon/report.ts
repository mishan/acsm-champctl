/**
 * Pure reporting helpers for the recon scripts.
 *
 * Separated from the scripts so they can be tested. Both of these produced
 * plausible-looking but wrong output at some point — a sentinel that read as a
 * shared pit box, and a list that re-reported fields the caller had just
 * explained — and neither failure would stop a run or look obviously wrong in
 * the log. That is exactly the kind of thing worth pinning down.
 */

import { basename, isAbsolute, relative } from "node:path"

import { NON_ARRAY_ENTRY_LIST_FIELDS } from "../../src/acsm/form.js"
import type { Championship } from "../../src/acsm/types.js"
import { events, slots } from "../../src/acsm/view.js"

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

const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const STEAM_GUID = /\b7656119\d{10}\b/g

/**
 * True for a 1.x Server Manager, whatever spelling the version arrived in.
 *
 * The two sources disagree: `/healthcheck.json` reports `v1.7.9` while the
 * footer scrape captures a bare `1.7.9`, because its regex drops the `v`. A
 * plain `startsWith("1.")` therefore misses the healthcheck form — and the
 * thing it gates is the warning that this run cannot answer the `EntrantID`
 * and premium-endpoint questions for the 2.4.5 build BATL actually runs. A
 * missing caveat on a provisional answer is worse than a noisy one, so the
 * comparison is on the parsed major rather than on the string.
 */
export function isLegacyVersion(version: string | undefined): boolean {
  return majorVersion(version) === 1
}

/** The leading integer of a version string, ignoring any `v` prefix. */
export function majorVersion(version: string | undefined): number | undefined {
  const m = /^\s*v?(\d+)\./i.exec(version ?? "")
  return m ? Number(m[1]) : undefined
}

/**
 * A provenance string reduced to something safe and stable to commit.
 *
 * Unlike `stableUrl` this does NOT parse as a URL — these are sentences
 * ("copy of championship <uuid> on this server") or filesystem paths, and
 * URL-parsing a sentence percent-encodes the spaces into nonsense.
 *
 * Absolute paths are made relative to the working directory, because a fixture
 * path resolved at load time carries somebody's home directory, and these
 * files are committed and public.
 */
export function stableSource(source: string): string {
  const absolute = isAbsolute(source)
  const text = absolute ? toRepoRelative(source) : source
  return text.replace(UUID_ANYWHERE, "{id}").replace(STEAM_GUID, "{guid}")
}

function toRepoRelative(absolutePath: string): string {
  const rel = relative(process.cwd(), absolutePath)
  // Outside the repo entirely: keep the filename, drop the directories.
  return !rel || rel.startsWith("..") ? basename(absolutePath) : rel
}

/**
 * A URL reduced to the part worth committing: path only, identifiers masked.
 *
 * Two reasons, and both matter for a file that gets checked in.
 *
 * Privacy: form actions are resolved to absolute URLs, so they carry the host
 * — which is how a LAN address ends up in a public artefact even after the
 * `baseUrl` field is redacted. Entrant links carry Steam GUIDs outright.
 *
 * Stability: the championship and event UUIDs are new on every run, so an
 * un-masked capture differs from the previous one everywhere, every time. The
 * whole point of committing these is that the diff on the next ACSM upgrade
 * shows what actually changed.
 */
export function stableUrl(url: string): string {
  let out = url
  try {
    const u = new URL(url, "http://placeholder")
    out = u.pathname + u.search
  } catch {
    // Already a path, or something unparseable; mask it as-is.
  }
  return out.replace(UUID_ANYWHERE, "{id}").replace(STEAM_GUID, "{guid}")
}

/**
 * EntryList keys whose count doesn't match the entrant count, excluding those
 * already known not to be per-entrant arrays.
 *
 * Without the exclusion this re-reports the unpaired checkboxes and the
 * NumEntrants counter that the caller has just described, and the genuinely
 * interesting key — a counter nobody has seen before, or an array that really
 * is short — gets lost among them. Uses the same list `postForm` refuses on,
 * so this says what champctl would actually reject.
 */
export function raggedKeys(shapes: Record<string, number>, expected: number): string[] {
  const known = new Set<string>(NON_ARRAY_ENTRY_LIST_FIELDS)
  return Object.entries(shapes)
    .filter(([k, n]) => k.startsWith("EntryList.") && !known.has(k) && n !== expected)
    .map(([k, n]) => `${k}=${n}`)
}

export interface PitBoxComparison {
  sentCount: number
  returnedCount: number
  /** How many entrants didn't survive the round trip. */
  entrantsLost: number
  sentDuplicates: number[]
  /** Slots with no PitBox at all — ACSM defaults those to the list index. */
  sentWithoutPitBox: number
  sentPitBoxes: (number | undefined)[]
  returnedPitBoxes: (number | undefined)[]
}

/**
 * Does a duplicate pit box cost an entrant?
 *
 * `AddInPitBox` overwrites on collision, so if import routes through it, two
 * entrants sharing a box means one is silently deleted. Comparing the counts
 * either side of the round trip answers that.
 *
 * An entrant with no `PitBox` has no box, rather than a box numbered -1.
 * Folding those into a sentinel made them collide with each other and produced
 * "duplicate pit boxes at -1", which is a sentence about nothing. They're
 * excluded from the duplicate hunt and counted separately, since a slot whose
 * position is doing the work is worth knowing about on its own
 * (docs/acsm-write-path.md §2).
 */
export function comparePitBoxes(sent: Championship, returned: Championship): PitBoxComparison {
  const boxesOf = (c: Championship): (number | undefined)[] =>
    slots(events(c)[0]?.EntryList).map((s) => s.entrant.PitBox)

  const before = boxesOf(sent)
  const after = boxesOf(returned)

  const seen = new Set<number>()
  const duplicates = new Set<number>()
  for (const b of before) {
    if (typeof b !== "number") continue
    if (seen.has(b)) duplicates.add(b)
    seen.add(b)
  }

  return {
    sentCount: before.length,
    returnedCount: after.length,
    entrantsLost: Math.max(0, before.length - after.length),
    sentDuplicates: [...duplicates].sort((a, b) => a - b),
    sentWithoutPitBox: before.filter((b) => typeof b !== "number").length,
    sentPitBoxes: before,
    returnedPitBoxes: after,
  }
}
