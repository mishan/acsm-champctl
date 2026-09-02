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

import * as cheerio from "cheerio"

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

/** One occurrence of a named control, described by where it sits. */
export interface ControlSite {
  /** `input`, `select` or `textarea`. */
  tag: string
  /** An input's `type`, or the tag name for a select or textarea. */
  type: string
  /**
   * Class names of the control's ancestors, nearest first, up to the form.
   *
   * The counts alone say a key appears eight times for six entrants and no more
   * than that. Where those eight sit is the answer: ACSM's own "add entrant"
   * button clones a hidden template row, so a template contributes an
   * occurrence that no entrant owns.
   */
  ancestors: string[]
  /**
   * `id` of every ancestor up to the form, nearest first. Not depth-bounded.
   *
   * Because `#entrantTemplate` is the answer, and it sits above the four
   * Bootstrap wrappers `ancestors` stops at. Ids are few, so walking all the way
   * costs nothing.
   */
  ancestorIds: string[]
  /**
   * Hidden by an ancestor — the shape of a clone-me template row.
   *
   * A hint about *why* the count is what it is, never a reason to leave a value
   * out: `display: none` has no effect on form submission, only `disabled` does.
   * Prefer `ancestorIds` for identifying a template row — this one is a
   * heuristic and that one is ACSM's own marker.
   */
  hidden: boolean
}

/** Class names on an element, in source order. */
function classesOf($el: cheerio.Cheerio<never>): string[] {
  return ($el.attr("class") ?? "").split(/\s+/).filter(Boolean)
}

/** `display:none`, a `hidden` attribute, or a class that says the same. */
function looksHidden($el: cheerio.Cheerio<never>): boolean {
  if ($el.attr("hidden") !== undefined) return true
  if (/display\s*:\s*none/i.test($el.attr("style") ?? "")) return true
  return classesOf($el).some((c) => /^(d-none|hidden|invisible)$/i.test(c))
}

/**
 * Where each occurrence of the named controls actually sits in a form.
 *
 * `shape()` answers "how many", which is enough to know a payload is ragged and
 * not enough to know what to do about it. On 2.4.15 the championship form
 * renders `EntryList.OverwriteAllEvents` eight times and `TransferTeamPoints`
 * seven for six entrants (docs/acsm-2.4.15.md §5), and champctl cannot write
 * that form until someone can say which occurrence belongs to which entrant.
 *
 * Deliberately returns structure and not values: this output is committed and
 * public, and an entrant row carries a driver's name and Steam GUID.
 *
 * `depth` bounds the ancestor chain because ACSM's markup nests a dozen deep in
 * Bootstrap wrappers, and the interesting class is always the innermost one.
 */
export function describeControls(
  html: string,
  actionNeedle: string,
  names: readonly string[],
  depth = 4,
): Record<string, ControlSite[]> {
  const $ = cheerio.load(html)
  const form = $("form")
    .toArray()
    .find((el) => ($(el).attr("action") ?? "").includes(actionNeedle))

  const out: Record<string, ControlSite[]> = {}
  if (!form) return out

  const $form = $(form)
  for (const name of names) {
    const sites: ControlSite[] = []
    // Attribute-selector escaping: these names contain a dot, which cheerio
    // would otherwise read as a class selector.
    for (const el of $form.find(`[name="${name}"]`).toArray()) {
      const $el = $(el) as unknown as cheerio.Cheerio<never>
      const tag = (el as { tagName?: string }).tagName?.toLowerCase() ?? "?"
      const ancestors: string[] = []
      const ancestorIds: string[] = []
      let hidden = looksHidden($el)

      let $node = $el.parent() as unknown as cheerio.Cheerio<never>
      for (let i = 0; $node.length > 0; i++) {
        if ($node.is("form")) break
        const classes = classesOf($node)
        if (i < depth && classes.length > 0) ancestors.push(stableSource(classes.join(" ")))
        if (i < depth && looksHidden($node)) hidden = true
        const id = $node.attr("id")
        if (id) ancestorIds.push(stableSource(id))
        $node = $node.parent() as unknown as cheerio.Cheerio<never>
      }

      sites.push({
        tag,
        type: tag === "input" ? ($el.attr("type") ?? "text").toLowerCase() : tag,
        ancestors,
        ancestorIds,
        hidden,
      })
    }
    out[name] = sites
  }
  return out
}

/**
 * The distinct shapes among a key's occurrences, with how many took each.
 *
 * Eight identical rows is a different finding from six of one shape and two of
 * another, and only the second says "some of these are not entrants". Collapsing
 * to shapes keeps the artefact readable when a real entry list has thirty.
 */
export function summariseControls(sites: readonly ControlSite[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const s of sites) {
    const key = `${s.type}${s.hidden ? " (hidden)" : ""} in [${s.ancestors.join(" < ")}]`
    out[key] = (out[key] ?? 0) + 1
  }
  return out
}

/**
 * ACSM's marker for the entrant row its "add entrant" button clones.
 *
 * `manager.js` takes a copy on load and then `$tmpl.remove()`s it, so a browser
 * never submits that row. champctl runs no JS and parses it, which is the whole
 * of the extra-occurrence puzzle: the same class of departure as `TrackLayout`
 * (docs/acsm-write-path.md §15) and the checkbox rewrite (§4).
 */
export const ENTRANT_TEMPLATE_ID = "entrantTemplate"

/**
 * Which rows of a repeated key sit inside a clone-me template.
 *
 * Indices are into the key's own occurrences in document order, which is the
 * index ACSM's `BuildEntryList` walks — so these are exactly the positions a
 * payload has to drop before the remaining ones line up with the entrants.
 *
 * Exact rather than heuristic. `hidden` guesses from styling; this reads the id
 * ACSM's own JavaScript keys off.
 */
export function templateRowIndices(sites: readonly ControlSite[]): number[] {
  return sites
    .map((s, i) => (s.ancestorIds.includes(ENTRANT_TEMPLATE_ID) ? i : -1))
    .filter((i) => i >= 0)
}

export interface UuidCensus {
  /** No value at all — `BuildEntryList` mints a fresh UUID for these. */
  empty: number
  /** The all-zero UUID, which `CombineEntryLists` explicitly refuses to match. */
  nil: number
  /** A real UUID. */
  real: number
}

/**
 * Sorts UUID values into the three cases that behave differently, without
 * emitting any of them.
 *
 * The distinction is load-bearing twice over. `BuildEntryList` does
 * `e := NewEntrant()` — a fresh UUID — and only overwrites it when
 * `uuid.Parse` succeeds, so an empty value means *a save mints a new identity*
 * while a nil value means the nil is preserved. And `CombineEntryLists` guards
 * on `entrant.InternalUUID != uuid.Nil`, so nil class entrants can never take
 * an override from an event entry list.
 */
export function uuidCensus(values: readonly (string | undefined)[]): UuidCensus {
  const NIL = "00000000-0000-0000-0000-000000000000"
  const out: UuidCensus = { empty: 0, nil: 0, real: 0 }
  for (const v of values) {
    const s = (v ?? "").trim()
    // No case folding, deliberately: the nil UUID is zeros and dashes, so there
    // is no case for it to arrive in. A `toLowerCase()` here reads like it
    // handles something and handles nothing — and the test written to cover it
    // passed with the call removed, which is how it was noticed.
    if (s === "") out.empty++
    else if (s === NIL) out.nil++
    else out.real++
  }
  return out
}

export interface InternalUuidJoin {
  classEntrants: number
  /** Class entrants whose InternalUUID is missing or the nil UUID. */
  classEntrantsWithoutUuid: number
  /** Per round: how many class entrants were found in that round's entry list. */
  matchedPerRound: number[]
  /** Rounds with no entry list of their own; those inherit the class list whole. */
  roundsWithoutEntryList: number[]
  /** Class entrants matched in every round. The ones a global change reaches. */
  matchedEverywhere: number
}

/**
 * Whether `EntryList.OverwriteAllEvents` can find anything to overwrite.
 *
 * The mechanism joins a class entrant to an event entrant on `InternalUUID`:
 *
 *   eventEntrant := event.EntryList.FindEntrantByInternalUUID(entrant.InternalUUID)
 *   eventEntrant.OverwriteProperties(entrant)
 *
 * and `FindEntrantByInternalUUID` returns `&Entrant{}` on a miss — so a class
 * entrant that matches nothing in a round is not an error, a warning or a log
 * line. The properties are copied into a throwaway struct and dropped.
 *
 * That matters here because this repo's own plan §5.5 says the opposite of what
 * ACSM assumes: "`InternalUUID` is a per-list identity, NOT a join key — the
 * class list and each event list use different UUIDs for the same driver."
 * Both cannot be true. If the plan is right, setting a skin at championship
 * level reaches no round at all and does so silently, which is the worst
 * possible failure mode for a livery drop nobody watches.
 *
 * One read of an export settles it, so this counts the overlap rather than
 * arguing about it. Identity only — no names, no GUIDs.
 */
export function internalUuidJoin(championship: Championship): InternalUuidJoin {
  const NIL = "00000000-0000-0000-0000-000000000000"
  const usable = (id: unknown): id is string =>
    typeof id === "string" && id.trim() !== "" && id !== NIL

  const classUuids: string[] = []
  let withoutUuid = 0
  for (const cls of championship.Classes ?? []) {
    for (const s of slots(cls?.Entrants)) {
      if (usable(s.entrant.InternalUUID)) classUuids.push(s.entrant.InternalUUID)
      else withoutUuid++
    }
  }

  const matchedPerRound: number[] = []
  const roundsWithoutEntryList: number[] = []
  const matchCount = new Map<string, number>()

  events(championship).forEach((ev, i) => {
    const list = ev?.EntryList
    // ACSM's own reading: an event with no entry list of its own uses the class
    // list unchanged, so there is nothing to overwrite and nothing to miss.
    if (!list || Object.keys(list).length === 0) {
      roundsWithoutEntryList.push(i + 1)
      matchedPerRound.push(classUuids.length)
      for (const id of classUuids) matchCount.set(id, (matchCount.get(id) ?? 0) + 1)
      return
    }

    const present = new Set(
      slots(list)
        .map((s) => s.entrant.InternalUUID)
        .filter(usable),
    )
    let matched = 0
    for (const id of classUuids) {
      if (!present.has(id)) continue
      matched++
      matchCount.set(id, (matchCount.get(id) ?? 0) + 1)
    }
    matchedPerRound.push(matched)
  })

  const rounds = matchedPerRound.length
  return {
    classEntrants: classUuids.length + withoutUuid,
    classEntrantsWithoutUuid: withoutUuid,
    matchedPerRound,
    roundsWithoutEntryList,
    matchedEverywhere: classUuids.filter((id) => (matchCount.get(id) ?? 0) === rounds).length,
  }
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
