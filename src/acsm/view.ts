/**
 * Read-side accessors over a championship export.
 *
 * Everything here is total: an absent or malformed field yields an empty
 * result rather than throwing. The checker runs against real exports from
 * arbitrary ACSM versions and must never crash on one.
 */

import {
  ANY_CAR_MODEL,
  type Championship,
  type ChampionshipClass,
  type ChampionshipEvent,
  type Entrant,
  type EntryList,
  type EventSession,
  type RaceSetup,
  type SessionConfig,
  type SessionKey,
  SESSION_KEY_ALIASES,
  type SignUpResponse,
} from "./types.js"

/** Go's `time.Time` zero value, as it serialises into an export. */
export const GO_ZERO_TIME = "0001-01-01T00:00:00Z"

/** True when a Go timestamp field is unset. Also treats empty/absent as unset. */
export function isZeroTime(t: string | undefined | null): boolean {
  if (!t) return true
  if (t === GO_ZERO_TIME) return true
  // Some versions emit a local-offset zero time, e.g. 0001-01-01T00:00:00-07:52.
  return t.startsWith("0001-01-01T")
}

/** A slot paired with its `CAR_n` key, since the key is the cross-list join. */
export interface Slot {
  /** The `CAR_n` map key. This is the join key across lists, not InternalUUID. */
  key: string
  /** Numeric suffix of the key, or `Number.MAX_SAFE_INTEGER` if unparseable. */
  index: number
  entrant: Entrant
}

const CAR_KEY = /^CAR_(\d+)$/

/**
 * Entry list as an array in `CAR_n` numeric order.
 *
 * Object key order is insertion order in practice, but an export that has been
 * round-tripped through another tool may not preserve it, so we sort.
 */
export function slots(list: EntryList | undefined): Slot[] {
  if (!list || typeof list !== "object") return []
  return Object.entries(list)
    .filter(([, e]) => e != null && typeof e === "object")
    .map(([key, entrant]) => {
      const m = CAR_KEY.exec(key)
      return {
        key,
        index: m?.[1] !== undefined ? Number(m[1]) : Number.MAX_SAFE_INTEGER,
        entrant,
      }
    })
    .sort((a, b) => a.index - b.index || a.key.localeCompare(b.key))
}

export function classes(c: Championship | undefined): ChampionshipClass[] {
  return Array.isArray(c?.Classes) ? c.Classes.filter(Boolean) : []
}

export function events(c: Championship | undefined): ChampionshipEvent[] {
  return Array.isArray(c?.Events) ? c.Events.filter(Boolean) : []
}

export function signUpResponses(c: Championship | undefined): SignUpResponse[] {
  const r = c?.SignUpForm?.Responses
  return Array.isArray(r) ? r.filter(Boolean) : []
}

export function acceptedSignUps(c: Championship | undefined): SignUpResponse[] {
  return signUpResponses(c).filter((r) => r.Status === "Accepted")
}

/** Human-facing event label: `Suzuka (layout)` or the 1-based round number. */
export function eventLabel(ev: ChampionshipEvent, round: number): string {
  const t = trackLabel(ev.RaceSetup)
  return t ? `${t} (round ${round})` : `round ${round}`
}

/** `track` or `track/layout`, as used for pit-table lookups and messages. */
export function trackLabel(rs: RaceSetup | undefined): string {
  const track = (rs?.Track ?? "").trim()
  if (!track) return ""
  const layout = (rs?.TrackLayout ?? "").trim()
  return layout ? `${track}/${layout}` : track
}

/**
 * Looks up a session regardless of how this ACSM version spells the key.
 *
 * `SessionType` is a Go string type whose constants are `"BOOK"`, `"PRACTICE"`,
 * `"QUALIFY"`, `"RACE"`, but exports have also carried the friendly spellings.
 * Because `Sessions` is a map, a key we don't recognise is not an error — the
 * lookup simply returns nothing, which would silently disable every format
 * check rather than failing loudly. Hence matching on aliases.
 */
function lookupSession<T>(
  sessions: Record<string, T> | undefined,
  key: SessionKey,
): T | undefined {
  if (!sessions || typeof sessions !== "object") return undefined

  const exact = sessions[key]
  if (exact !== undefined) return exact

  const aliases = SESSION_KEY_ALIASES[key]
  for (const [k, v] of Object.entries(sessions)) {
    if (aliases.includes(k.trim().toLowerCase())) return v
  }
  return undefined
}

/** Session *configuration* — durations, laps — from `RaceSetup.Sessions`. */
export function session(
  ev: ChampionshipEvent,
  key: SessionKey,
): SessionConfig | undefined {
  return lookupSession(ev.RaceSetup?.Sessions, key)
}

/** Session *state* — started/completed times and results — from `Sessions`. */
export function eventSession(
  ev: ChampionshipEvent,
  key: SessionKey,
): EventSession | undefined {
  return lookupSession(ev.Sessions, key)
}

/** The literal keys this export used, for recon and for diagnosing a mismatch. */
export function sessionKeysUsed(c: Championship | undefined): string[] {
  const keys = new Set<string>()
  for (const ev of events(c)) {
    for (const k of Object.keys(ev.RaceSetup?.Sessions ?? {})) keys.add(k)
    for (const k of Object.keys(ev.Sessions ?? {})) keys.add(k)
  }
  return [...keys].sort()
}

/** A session counts as configured only when ACSM would actually run it. */
export function sessionEnabled(s: SessionConfig | undefined): boolean {
  if (!s) return false
  // IsOpen is a tri-state (0 closed / 1 open / 2 open-until-20s-to-green) and
  // is not an enable flag, so presence plus any duration is the real test.
  return (s.Time ?? 0) > 0 || (s.Laps ?? 0) > 0
}

/** Parses `RaceSetup.Cars`, a semicolon-joined model list. */
export function raceSetupCars(rs: RaceSetup | undefined): string[] {
  return (rs?.Cars ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Every model any class in the championship allows. */
export function availableCars(c: Championship | undefined): Set<string> {
  const out = new Set<string>()
  for (const cls of classes(c)) {
    for (const m of cls.AvailableCars ?? []) {
      if (typeof m === "string" && m.trim()) out.add(m.trim())
    }
  }
  return out
}

/** True when the class can be entered in more than one model (plan §4.4). */
export function isMultiModel(cls: ChampionshipClass): boolean {
  return (cls.AvailableCars ?? []).filter(Boolean).length > 1
}

/** An unclaimed slot: no GUID and no name. Model may be the sentinel. */
export function isUnclaimed(e: Entrant): boolean {
  return !(e.GUID ?? "").trim() && !(e.Name ?? "").trim()
}

export function isAnyCarModel(e: Entrant): boolean {
  return (e.Model ?? "").trim() === ANY_CAR_MODEL
}

/** Claimed slots fill the grid; total slots do not (plan §4.4). */
export function claimedSlots(list: EntryList | undefined): Slot[] {
  return slots(list).filter((s) => !isUnclaimed(s.entrant))
}

/**
 * True if any event has run. Gates the never-re-import rule (plan §3.2) and
 * suppresses schedule checks that only make sense before the fact.
 */
export function hasStarted(c: Championship | undefined): boolean {
  return events(c).some((ev) => eventHasStarted(ev))
}

export function eventHasStarted(ev: ChampionshipEvent): boolean {
  if (!isZeroTime(ev.StartedTime)) return true
  for (const s of Object.values(ev.Sessions ?? {})) {
    if (s && !isZeroTime(s.StartedTime)) return true
  }
  return false
}

/** The spectator car occupies a pit box and must be counted against capacity. */
export function spectatorCar(c: Championship | undefined): Entrant | undefined {
  return c?.SpectatorCarEnabled ? c.SpectatorCar : undefined
}

/** How many pit boxes the spectator car consumes: 1 when enabled, else 0. */
export function spectatorCarCount(c: Championship | undefined): number {
  return spectatorCar(c) ? 1 : 0
}

/** Normalises a Steam GUID for comparison. */
export function normGuid(g: string | undefined | null): string {
  return (g ?? "").trim()
}
