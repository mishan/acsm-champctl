/**
 * Championship standings, from ACSM if it will say and from the export if not.
 *
 * ## Why there are two of these
 *
 * `standings.json` is ACSM's own arithmetic, so it can never disagree with the
 * page drivers actually look at. But it is **premium only** — absent from the
 * public `router.go` (docs/acsm-write-path.md §6) — so a league on the OSS
 * build gets nothing from it, no harness can serve it, and no fixture of its
 * response exists. `AcsmReader.standings` returns `unknown` because nobody has
 * ever seen the shape, and `parseStandings` below is written to *not recognise*
 * things rather than to guess at them.
 *
 * The export is the fallback: results are inline at
 * `Events[].Sessions[].Results` and the points table is in `Classes[].Points`,
 * both on every build. The cost is that champctl is then doing ACSM's sums, and
 * standings that disagree with the standings page are worse than no standings.
 *
 * ## What the fallback refuses to do, and why that matters
 *
 * Four things about ACSM's scoring have never been measured against a real
 * manager, and each of them would change every number in the table:
 *
 * - **More than one class.** Which finishing position a class scores — the one
 *   in the class or the one on the road — is not written down anywhere, and
 *   `ChampionshipClass.Entrants` would have to be matched to results by name or
 *   by GUID, which is unmeasured in its own right.
 * - **`IgnoreXWorstEvents`.** Something is dropped; which events, and whether
 *   the drop is per driver or per championship, is not written down anywhere.
 * - **`CollisionWithDriver` / `CollisionWithEnv` / `CutTrack`.** These are on
 *   the points table and the incidents are in the export, but whether ACSM
 *   applies them automatically is unknown. `ResultEntry.Penalties` is typed
 *   `unknown[]` for exactly this reason.
 * - **The second race of a reversed-grid round.** `SecondRaceMultiplier` says
 *   there is one, and nothing in this repo knows what session key its results
 *   arrive under. BATL's 2x20 is this case.
 *
 * So `computeStandings` refuses, naming the reason, rather than producing a
 * table that is quietly wrong in front of a league. A refusal is a to-do list:
 * `npm run recon:standings` is what would close it.
 */

import type { Championship, ChampionshipClass, SessionResults } from "../acsm/types.js"
import { classes, eventHasStarted, events, eventSession } from "../acsm/view.js"

export interface StandingsRow {
  /** 1-based, after sorting by points. */
  position: number
  driver: string
  points: number
}

export interface StandingsClass {
  name: string
  rows: StandingsRow[]
}

export type StandingsSource = "endpoint" | "export"

export interface Standings {
  source: StandingsSource
  classes: StandingsClass[]
}

/** Why the export cannot be scored the way ACSM would score it. */
export interface Unscorable {
  scorable: false
  /** One plain sentence naming what isn't modelled. */
  reason: string
}

export function isUnscorable(v: StandingsClass[] | Unscorable): v is Unscorable {
  return "scorable" in v
}

/**
 * Standings out of whatever `standings.json` returned, or undefined.
 *
 * Undefined means "I don't recognise this", and it is the honest answer far
 * more often than a parser normally admits: the shape is unmeasured, so this
 * accepts a small number of plausible spellings and refuses everything else
 * rather than digging hopefully through an object it has never seen. A wrong
 * guess here posts a made-up table, which is the one outcome worse than the
 * endpoint being unavailable.
 *
 * Both key casings are read, because the championships listing taught us that
 * lesson already: 2.4.15 answers `/api/championships/list.json` in lowercase
 * where the export uses `ID` and `Name`, and champctl read only the capitalised
 * spelling — so every entry silently lost its id (see `summaries()` in
 * `acsm/client.ts`). Assuming one casing for a response nobody has looked at
 * would be repeating it on purpose.
 */
export function parseStandings(body: unknown): StandingsClass[] | undefined {
  if (body === null || typeof body !== "object") return undefined

  const root = body as Record<string, unknown>
  const classList = firstArray(root, ["Classes", "classes", "Standings", "standings"])

  // A flat array of rows, with no class layer at all.
  if (classList === undefined) {
    const flat = Array.isArray(body) ? body : firstArray(root, ["Results", "results"])
    if (!flat) return undefined
    const rows = parseRows(flat)
    return rows && rows.length > 0 ? [{ name: "", rows }] : undefined
  }

  const out: StandingsClass[] = []
  for (const entry of classList) {
    if (entry === null || typeof entry !== "object") continue
    const cls = entry as Record<string, unknown>
    const rows = parseRows(
      firstArray(cls, ["Standings", "standings", "Results", "results", "Rows", "rows"]) ?? [],
    )
    if (!rows) return undefined
    out.push({ name: firstString(cls, ["Name", "name", "Class", "class"]) ?? "", rows })
  }
  return out.length > 0 ? out : undefined
}

function parseRows(raw: readonly unknown[]): StandingsRow[] | undefined {
  const rows: StandingsRow[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") return undefined
    const r = entry as Record<string, unknown>

    // The driver may be a string or a nested object, since results elsewhere in
    // ACSM nest it (`ResultCar.Driver.Name`).
    const nested = r["Driver"] ?? r["driver"]
    const driver =
      firstString(r, ["DriverName", "driverName", "Name", "name"]) ??
      (nested !== null && typeof nested === "object"
        ? firstString(nested as Record<string, unknown>, ["Name", "name"])
        : typeof nested === "string"
          ? nested
          : undefined)

    const points = firstNumber(r, ["Points", "points", "Total", "total"])
    if (driver === undefined || points === undefined) return undefined
    rows.push({ position: 0, driver, points })
  }
  return ranked(rows)
}

function firstArray(o: Record<string, unknown>, keys: readonly string[]): unknown[] | undefined {
  for (const k of keys) {
    const v = o[k]
    if (Array.isArray(v)) return v
  }
  return undefined
}

function firstString(o: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === "string" && v.trim()) return v
  }
  return undefined
}

function firstNumber(o: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === "number" && Number.isFinite(v)) return v
  }
  return undefined
}

/**
 * Standings worked out from the export, or a refusal saying why not.
 *
 * Only the part of ACSM's scoring that is unambiguous: points for finishing
 * position, from `Result[]`, which the plan records as finishing order (§3.1).
 * A disqualified driver scores nothing. Everything else refuses — see the
 * module header.
 */
export function computeStandings(c: Championship): StandingsClass[] | Unscorable {
  const blocked = whyNotScorable(c)
  if (blocked) return { scorable: false, reason: blocked }

  const raced = events(c).filter((ev) => eventHasStarted(ev))
  if (raced.length === 0) {
    return { scorable: false, reason: "No round has been raced yet." }
  }

  const out: StandingsClass[] = []
  for (const cls of classes(c)) {
    const places = (cls.Points?.Places ?? []).filter((n) => typeof n === "number")
    const totals = new Map<string, number>()

    for (const ev of raced) {
      const results = eventSession(ev, "Race")?.Results
      for (const [index, driver] of finishers(results).entries()) {
        totals.set(driver, (totals.get(driver) ?? 0) + (places[index] ?? 0))
      }
    }

    out.push({
      name: cls.Name ?? "",
      rows: ranked([...totals].map(([driver, points]) => ({ position: 0, driver, points }))),
    })
  }
  return out
}

/**
 * Finishing order as driver names, disqualifications removed.
 *
 * Removed rather than scored zero, because the two differ for everyone behind
 * them: ACSM's `Result[]` is the order as classified, so dropping a DSQ is what
 * moves the next driver up into the points they were actually awarded.
 */
function finishers(results: SessionResults | null | undefined): string[] {
  const rows = Array.isArray(results?.Result) ? results.Result : []
  return rows
    .filter((r) => r && r.Disqualified !== true)
    .map((r) => (r.DriverName ?? "").trim())
    .filter(Boolean)
}

/** The first reason this championship can't be scored here, if there is one. */
function whyNotScorable(c: Championship): string | undefined {
  // This scored every class off the *overall* finishing order, so a two-class
  // championship came back with both classes holding the same rows, and a GT4
  // driver who finished third on the road took third-place points in the GT3
  // table as well. Filtering `cls.Entrants` would fix the first half and guess
  // at the second: whether ACSM awards a class its in-class position or its
  // overall one has never been measured, so refusing is the honest answer.
  const all = classes(c)
  if (all.length > 1) {
    return `it runs ${all.length} classes, and champctl has never measured whether ACSM scores a class by finishing position within the class or overall`
  }

  const ignore = c.IgnoreXWorstEvents
  if (typeof ignore === "number" && ignore > 0) {
    return `it drops its ${ignore} worst ${ignore === 1 ? "round" : "rounds"}, and champctl has never measured which rounds ACSM drops`
  }

  for (const cls of classes(c)) {
    const penalty = penaltyPoints(cls)
    if (penalty) {
      return `${cls.Name || "a class"} awards ${penalty} points, and champctl has never measured whether ACSM applies those automatically`
    }
  }

  for (const [i, ev] of events(c).entries()) {
    if (!eventHasStarted(ev)) continue
    const reversed = ev.RaceSetup?.ReversedGridRacePositions
    if (typeof reversed === "number" && reversed > 0) {
      return `round ${i + 1} is a reversed-grid two-race round, and champctl doesn't know which session key holds the second race's results`
    }
  }
  return undefined
}

/** Which penalty-points fields this class has set, named for the refusal. */
function penaltyPoints(cls: ChampionshipClass): string | undefined {
  const named: string[] = []
  for (const key of ["CollisionWithDriver", "CollisionWithEnv", "CutTrack"] as const) {
    const v = cls.Points?.[key]
    if (typeof v === "number" && v !== 0) named.push(key)
  }
  return named.length > 0 ? named.join(" and ") : undefined
}

/** Sorts by points, descending, and numbers the result. Ties share a position. */
export function ranked(rows: readonly StandingsRow[]): StandingsRow[] {
  const sorted = [...rows].sort((a, b) => b.points - a.points || a.driver.localeCompare(b.driver))

  let lastPoints: number | undefined
  let lastPosition = 0
  return sorted.map((row, i) => {
    // Equal points share a position — two drivers on 40 are both second, and
    // the next one is fourth. Numbering them 2 and 3 would invent a gap the
    // season does not have.
    const position = row.points === lastPoints ? lastPosition : i + 1
    lastPoints = row.points
    lastPosition = position
    return { ...row, position }
  })
}

/**
 * What the two sources disagree about, if anything.
 *
 * This is what stops the fallback rotting. At a premium league the endpoint
 * always answers, so without a reason to run the computation it would sit
 * unexercised until the day it was needed — which is the day it is least
 * welcome to be broken. Comparing on every run means it is exercised nightly,
 * and a disagreement is a real finding either way round: either champctl's sums
 * are wrong, or ACSM changed how it scores.
 *
 * Reported to whoever ran the job, never to the channel. A league does not need
 * to hear champctl arguing with its own manager.
 */
export function compareStandings(
  endpoint: readonly StandingsClass[],
  computed: readonly StandingsClass[],
): string[] {
  const differences: string[] = []
  const byName = new Map(computed.map((c) => [c.name, c]))

  for (const cls of endpoint) {
    const mine = byName.get(cls.name)
    if (!mine) {
      differences.push(`champctl worked out no standings for ${cls.name || "the unnamed class"}`)
      continue
    }
    const minePoints = new Map(mine.rows.map((r) => [r.driver, r.points]))
    for (const row of cls.rows) {
      const got = minePoints.get(row.driver)
      if (got === undefined) {
        differences.push(`${row.driver} is in ACSM's standings and not in champctl's`)
      } else if (got !== row.points) {
        differences.push(
          `${row.driver}: ACSM says ${row.points} points, champctl worked out ${got}`,
        )
      }
    }
  }
  return differences
}
