/**
 * Create-a-month: template plus overlays, out comes a championship (plan §4.1,
 * §5.1).
 *
 * ```
 * golden template (a real exported championship)
 *   → league defaults          (the profile baseline)
 *     → month overrides        (car, tracks, name, schedule)
 *       → event overrides      (format, race length, quali timing)
 *         → emit
 * ```
 *
 * Everything the emitter does not explicitly set flows through from the
 * template untouched, which is what makes this survive ACSM upgrades — see
 * `merge.ts`.
 *
 * The fields it *does* set are the ones a template gets wrong, and every one
 * of them is a bug the round-trip diff actually caught (plan §5.5). They are
 * listed on `emitMonth` below. Each is inherited-and-stale rather than absent,
 * which is why none of them announce themselves.
 */

import { randomUUID } from "node:crypto"

import { DateTime } from "luxon"

import {
  ANY_CAR_MODEL,
  type Championship,
  type ChampionshipClass,
  type ChampionshipEvent,
  type Entrant,
  type EntryList,
  type RaceSetup,
  type SignUpForm,
} from "../acsm/types.js"
import { FORBIDDEN_KEYS, regenerateIds } from "../acsm/write.js"
import { classes, events } from "../acsm/view.js"
import type { RaceFormat } from "../finalize/format.js"
import { applyFormat } from "../finalize/format.js"
import { practiceMinutesFor } from "../finalize/schedule.js"
import type { PitTable } from "../pits/table.js"
import type { LeagueProfile } from "../profile/types.js"
import { deepMerge, mergeAll } from "./merge.js"
import { gridCap, type GridCap } from "./grid.js"
import { monthSchedule, type RoundSchedule } from "./schedule.js"

/**
 * The sentinel that makes multi-model months work (plan §4.4).
 *
 * ACSM replaces it with the driver's chosen car when a sign-up is accepted, so
 * a month with ten available cars needs *N* slots at this model rather than
 * per-model counts. Confirmed against the October 2025 Legends championship:
 * five slots sat here during round one and were a GT-R, two 911s, a Capri and
 * a Pantera by round two.
 *
 * Re-exported from `acsm/types` rather than redeclared: `view.isAnyCarModel`
 * compares against that one, and two copies of a sentinel are two things that
 * can drift apart while every test still passes.
 */
export { ANY_CAR_MODEL }

export interface RoundSpec {
  track: string
  layout?: string
  /** Overrides the generated date for this round. */
  date?: string
  /** Why it moved, for the audit trail. Never written to ACSM. */
  dateNote?: string
  /** Per-event format override; the month default applies otherwise. */
  format?: RaceFormat
  name?: string
}

export interface MonthSpec {
  name: string
  /** Car models available to the class. `RaceSetup.Cars` is derived from this. */
  cars: string[]
  className?: string
  rounds: RoundSpec[]
  /** How many people may hold a place. NOT the grid cap — see §4.4. */
  entryListSlots?: number
  /** Applied to every round unless the round overrides it. */
  format?: RaceFormat
  /** First race night. Later rounds follow the profile's weekday rule. */
  startDate?: string
  description?: string
  signUpsEnabled?: boolean
}

export interface EmitOptions {
  template: Championship
  spec: MonthSpec
  profile: LeagueProfile
  pits?: PitTable
  /** Injectable for tests; `Created`/`Updated` are stamped from it. */
  now?: Date
  /** Overrides applied last, for anything not modelled here. */
  championshipOverrides?: Partial<Championship>
}

export interface EmitResult {
  championship: Championship
  grid: GridCap
  schedule: RoundSchedule[]
  /** What the emitter set rather than inherited, for a review screen. */
  derived: string[]
}

export class EmitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EmitError"
  }
}

/**
 * Builds a month.
 *
 * The fields set rather than inherited, each because inheriting it was a real
 * bug (plan §5.5):
 *
 * - **`Created`** — a template carries the date *it* was made, so an inherited
 *   value claims the championship existed a month before it did.
 * - **`RaceSetup.Cars`** — derived from the class `AvailableCars` plus the
 *   spectator model only when the spectator car is on. The template's copy
 *   still listed `ford_transit` with the spectator car disabled.
 * - **`ExportSecondRaceToACSR`** — forced off when `ACSR` is off, because the
 *   two together are a contradiction.
 * - **`SignUpForm.ExtraFields`** — cleared when sign-ups are disabled, rather
 *   than keeping the league's Discord-username question on a form nobody sees.
 */
export function emitMonth(options: EmitOptions): EmitResult {
  const { template, spec, profile } = options
  const now = options.now ?? new Date()
  const derived: string[] = []

  if (spec.rounds.length === 0) {
    throw new EmitError("A month needs at least one round; nothing to generate from an empty list.")
  }
  if (spec.cars.length === 0) {
    throw new EmitError(
      "A month needs at least one car model — RaceSetup.Cars is derived from it, and an empty " +
        "car list produces a championship nobody can enter.",
    )
  }

  // Trimmed once, here, and used everywhere below. A spec is usually parsed
  // JSON, and " bmw_m3" is as easy to type as "" — it just fails later and
  // less obviously, as an unknown car model on race night rather than as a
  // blank one. Refusing it would be unhelpful when the fix is unambiguous.
  const cars = spec.cars.map((c) => c.trim())

  // A list of blanks is the same mistake as an empty list, and just as
  // reachable from a hand-edited spec. `["", "bmw"]` joins to ";bmw" for
  // RaceSetup.Cars and leaves "" in the class AvailableCars — a model that
  // cannot load, in the field that decides what people are allowed to enter.
  // Refused by index for the same reason blank tracks are, below.
  const blankCars = cars
    .map((c, i) => (c ? undefined : i + 1))
    .filter((n): n is number => n !== undefined)
  if (blankCars.length > 0) {
    throw new EmitError(
      `Car model${blankCars.length === 1 ? "" : "s"} ${blankCars.join(", ")} ` +
        `${blankCars.length === 1 ? "is" : "are"} blank. RaceSetup.Cars is a semicolon-joined ` +
        `list, so a blank entry becomes an empty model nobody can drive.`,
    )
  }

  // A spec is usually parsed JSON — champctl-month reads one from a file — so
  // a blank track is a plausible typo rather than a programming error. Left
  // alone it emits an event with `Track: ""`, which ACSM accepts and then
  // fails to load on race night.
  // Same for tracks and layouts: they reach RaceSetup.Track, the pit-table
  // lookup and the grid summary, and whitespace makes all three disagree.
  const rounds = spec.rounds.map((r) => ({
    ...r,
    track: r.track?.trim() ?? "",
    ...(r.layout === undefined ? {} : { layout: r.layout.trim() }),
  }))

  const blank = rounds
    .map((r, i) => (r.track ? undefined : i + 1))
    .filter((n): n is number => n !== undefined)
  if (blank.length > 0) {
    throw new EmitError(
      `Round${blank.length === 1 ? "" : "s"} ${blank.join(", ")} ${
        blank.length === 1 ? "has" : "have"
      } no track. Every round needs one — an event with a blank track imports ` +
        `cleanly and then fails to load when the server tries to run it.`,
    )
  }

  // Anchored to the same `now` that stamps Created/Updated. Without this,
  // omitting startDate made the schedule depend on wall-clock time while every
  // other date in the same championship came from `now` — so a test could pin
  // Created and still get a schedule that moved, and a caller passing `now`
  // deliberately would get a month half in one timeframe and half in another.
  // The template event's practice length, not the league default: Scheduled is
  // quali minus practice, and the two disagreeing puts every round off by the
  // difference. templateEvent is resolved below, so this reads it from the
  // same place buildEvent will.
  const firstTemplateEvent = events(template)[0]
  const practiceMinutes = firstTemplateEvent
    ? practiceMinutesFor(firstTemplateEvent, profile.schedule.practiceMinutes)
    : profile.schedule.practiceMinutes

  const schedule = monthSchedule(
    rounds,
    profile,
    spec.startDate,
    DateTime.fromJSDate(now).setZone(profile.schedule.timezone),
    practiceMinutes,
  )
  // The spectator car takes a pit box, and gridmom counts it against the
  // track's capacity, so the cap has to leave room for it.
  const spectatorBoxes = mergeAll<Championship>(template, profile.baseline.championship ?? {})
    .SpectatorCarEnabled
    ? 1
    : 0
  const grid = gridCap(rounds, options.pits, { reservedBoxes: spectatorBoxes })

  // Start from the template, then the league baseline. Both are whole-object
  // overlays, so anything neither mentions survives from the template.
  const base = mergeAll<Championship>(template, profile.baseline.championship ?? {})

  const templateClasses = classes(template)
  const templateClass = templateClasses[0]
  const templateEvent = events(template)[0]
  if (!templateEvent) {
    throw new EmitError(
      "The template championship has no events to use as a shape for this month's rounds. " +
        "A golden template must be a real exported championship (plan §4.1).",
    )
  }

  // A MonthSpec describes one class, and `Classes` is replaced wholesale below.
  // Cloning a two-class championship therefore dropped the second class and its
  // entrants with no error, no warning and no `derived` line — the emitter's
  // one silent data loss. Modelling a single class is a deliberate limit;
  // doing it quietly is not.
  if (templateClasses.length > 1) {
    const names = templateClasses.map((c, i) => c.Name ?? `class ${i + 1}`)
    throw new EmitError(
      `The template has ${templateClasses.length} classes (${names.join(", ")}), and a month ` +
        `spec describes one. Emitting would keep ${JSON.stringify(names[0])} and silently drop ` +
        `the rest along with their entrants. Split the month, or start from a single-class ` +
        `template.`,
    )
  }

  const slots = spec.entryListSlots ?? profile.entryList.targetSlots
  const entryList = unclaimedEntryList(slots)

  const spectatorEnabled = base.SpectatorCarEnabled === true
  const carList = derivedCars(cars, spectatorEnabled ? base.SpectatorCar?.Model : undefined)
  derived.push(
    `RaceSetup.Cars from the class car list${spectatorEnabled ? " plus the spectator car" : ""}`,
  )

  const championshipClass: ChampionshipClass = {
    ...(templateClass ?? {}),
    // Keep the template's class ID and let the sweep at the end rename it —
    // the same reasoning `out.ID` gets, for the same reason. Minting here
    // instead breaks referential integrity: an unmodelled field still holding
    // the *template's* class ID gets mapped to one fresh value while the class
    // itself carries another, so a reference that matched in the template
    // silently stops matching. There is exactly one class built from exactly
    // one template class, so the sweep can carry it. Only a missing, non-UUID
    // or nil ID needs minting, because the sweep leaves those alone.
    ID: isFreshlyGeneratedId(templateClass?.ID) ? (templateClass?.ID as string) : randomUUID(),
    // The template's own class name before a car model: a template is a real
    // championship, so "GT3" or "RSS Formula Hybrid" is already the label a
    // league uses. Falling straight to `cars[0]` renamed an inherited class to
    // a model string, which reads like an id rather than a class.
    Name: spec.className?.trim() || templateClass?.Name || cars[0] || "Class",
    AvailableCars: [...cars],
    Entrants: entryList,
  }

  // The league baseline applies to events too, not just to the championship.
  // gridmom checks `RaceSetup` against `baseline.raceSetup` and reports any
  // difference as an INFO, so an emitter that skipped it would generate months
  // that its own checker immediately complains about — and `EntryListType` /
  // `PracticeEntryListType` would only be right when the template happened to
  // agree (plan §4.4 explains why that pair is deliberate).
  const baselineRaceSetup = profile.baseline.raceSetup ?? {}
  if (Object.keys(baselineRaceSetup).length > 0) {
    derived.push("league baseline applied to every round's RaceSetup")
  }

  // Only when a real pit count set it. gridCap returns its fallback (0) to
  // mean "no cap", and writing that through as MaxClients: 0 is a grid nobody
  // can join — the "number derived from nothing" the module says it refuses to
  // emit, and it would clobber the template's value and the baseline's on the
  // way. bindingTrack is set exactly when a track supplied the number.
  const capped = grid.bindingTrack !== undefined
  if (capped) {
    derived.push(`RaceSetup.MaxClients ${grid.maxClients} from ${grid.bindingTrack}'s pit boxes`)
  } else {
    derived.push(`RaceSetup.MaxClients left as the template had it — ${lower(grid.summary)}`)
  }

  // monthSchedule returns one entry per round, and `as RoundSchedule` asserted
  // that rather than checking it — the one cast in this function that
  // noUncheckedIndexedAccess was trying to prevent. If the two ever disagree,
  // an undefined lands in `scheduled` and surfaces later as an event with no
  // date, which reads as an ACSM problem. Fail here, naming the round.
  const scheduleFor = (i: number): RoundSchedule => {
    const s = schedule[i]
    if (!s) {
      throw new EmitError(
        `Internal: the schedule has ${schedule.length} entries for ${spec.rounds.length} rounds, ` +
          `so round ${i + 1} has no date. This is a champctl bug, not a problem with the spec.`,
      )
    }
    return s
  }

  const eventList: ChampionshipEvent[] = rounds.map((round, i) =>
    buildEvent({
      templateEvent,
      round,
      scheduled: scheduleFor(i),
      cars: carList,
      ...(capped ? { maxClients: grid.maxClients } : {}),
      entryList: unclaimedEntryList(slots),
      baselineRaceSetup,
      format: round.format ?? spec.format,
    }),
  )

  const signUpsEnabled = spec.signUpsEnabled ?? base.SignUpForm?.Enabled === true

  let out: Championship = {
    ...base,
    Name: spec.name,
    Classes: [championshipClass],
    Events: eventList,
    SignUpForm: signUpForm(base.SignUpForm, signUpsEnabled),
    ...(spec.description === undefined ? {} : { Description: spec.description }),
  }

  // A template carries the date it was made. Stamping is the fix; see §5.5.
  out.Created = now.toISOString()
  out.Updated = now.toISOString()
  derived.push("Created and Updated stamped from now, not inherited")

  // ACSR off with the second-race export on is a contradiction. gridmom would
  // report it; the emitter simply shouldn't produce it.
  if (out.ACSR !== true && out.ExportSecondRaceToACSR === true) {
    out.ExportSecondRaceToACSR = false
    derived.push("ExportSecondRaceToACSR turned off, since ACSR is off")
  }

  if (!signUpsEnabled && (base.SignUpForm?.ExtraFields?.length ?? 0) > 0) {
    derived.push("SignUpForm.ExtraFields cleared, since sign-ups are disabled")
  }

  if (options.championshipOverrides) {
    out = deepMerge(out, options.championshipOverrides)
  }

  // Last, so nothing downstream can reintroduce a template ID. An import that
  // keeps them lands on top of the championship the template came from.
  //
  // regenerateIds builds one old→new mapping and applies it across the whole
  // object graph, so a field elsewhere that referenced the championship's own
  // ID still points at it afterwards. Assigning a fresh `out.ID` *after* the
  // sweep would break exactly that: the root would get one value and every
  // reference to it another.
  out = regenerateIds(out)

  // The sweep only rewrites UUID-shaped strings that aren't the nil UUID, so a
  // template whose ID is neither comes through unchanged and could still
  // collide with the championship it came from. Those cases need a fresh one.
  //
  // "By then nothing points at the old value" was wrong, and is why this now
  // does more than assign. The sweep skipped that ID precisely *because* it
  // didn't look like a UUID — and it skipped every unmodelled field holding a
  // copy of it for the same reason. Minting a new root ID on its own therefore
  // left those references pointing at an ID that no longer existed anywhere.
  //
  // So a non-UUID root ID is replaced everywhere it appears, exactly as the
  // sweep would have done had it recognised it. That inherits the sweep's
  // trade-off — a field that merely happens to equal the old ID is rewritten
  // too — which is the same bet `regenerateIds` already takes for UUIDs, and
  // the cheaper mistake: a stray rewrite is visible in the diff, a dangling
  // reference is not.
  //
  // The nil UUID is the exception. It is the "unset" sentinel and appears on
  // every blank date, id and reference in the export, so rewriting each
  // occurrence would fill the month with references to the championship. That
  // one only gets a fresh root ID.
  if (!isFreshlyGeneratedId(out.ID)) {
    const previous = out.ID
    const fresh = randomUUID()
    out.ID = fresh
    if (previous && previous !== NIL_UUID) {
      out = replaceExactString(out, previous, fresh)
      derived.push(`references to the template's id ${JSON.stringify(previous)} repointed`)
    }
  }

  derived.push("every UUID regenerated, so importing creates rather than overwrites")

  return { championship: out, grid, schedule, derived }
}

/**
 * `RaceSetup.Cars` — a semicolon-joined model list, *derived* and never
 * inherited (plan §5.5).
 *
 * The spectator model is included only when the spectator car is enabled. The
 * bug this fixes was the reverse: the template's `Cars` still carried
 * `ford_transit` on a championship whose spectator car was off, so the car
 * list advertised a van nobody could pick.
 */
export function derivedCars(cars: readonly string[], spectatorModel?: string): string {
  // Trimmed here as well as at the spec boundary, because the spectator model
  // comes from the template rather than the spec and this is the only place
  // the two meet. A stray space would otherwise produce "a;b; ford_transit",
  // which ACSM reads as a model it doesn't have.
  const all = cars.map((c) => c.trim()).filter(Boolean)
  const spectator = spectatorModel?.trim()
  if (spectator && !all.includes(spectator)) all.push(spectator)
  return all.join(";")
}

/** `slots` unclaimed entries at the sentinel model, keyed `CAR_0..CAR_{n-1}`. */
export function unclaimedEntryList(slots: number): EntryList {
  if (!Number.isInteger(slots) || slots < 0) {
    throw new EmitError(`Entry list slots must be a non-negative integer, got ${slots}`)
  }
  const out: EntryList = {}
  for (let i = 0; i < slots; i++) {
    const entrant: Entrant = {
      Name: "",
      GUID: "",
      Model: ANY_CAR_MODEL,
      Skin: "",
      // CAR_n *is* the pit box (docs §3), so these have to line up or entrants
      // overwrite each other on the next form save.
      PitBox: i,
      Ballast: 0,
      Restrictor: 0,
    }
    out[`CAR_${i}`] = entrant
  }
  return out
}

/** Go's zero UUID. `regenerateIds` deliberately leaves this one alone. */
const NIL_UUID = "00000000-0000-0000-0000-000000000000"

/**
 * Replaces every string that exactly equals `from`, returning a new object.
 *
 * Deliberately whole-string rather than substring: an ID embedded in a URL or
 * a sentence is prose, and rewriting inside it would corrupt text rather than
 * repoint a reference.
 */
function replaceExactString<T>(value: T, from: string, to: string): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v === from ? to : v
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v)) {
        // Same guard `deepMerge` uses, for the same reason and from the same
        // list. A template is parsed JSON, where `__proto__` survives as an
        // ordinary own property — and `out[k] = ...` on a plain object with
        // that key reparents the object rather than adding a field, so the
        // emitted month would silently inherit whatever it pointed at.
        // Rebuilding an object is exactly where that bites, and this rebuilds
        // every object in the championship.
        if (FORBIDDEN_KEYS.has(k)) continue
        out[k] = walk(val)
      }
      return out
    }
    return v
  }
  return walk(value) as T
}

/**
 * Whether `regenerateIds` would have given this ID a fresh value.
 *
 * The nil UUID is excluded precisely *because* the sweep skips it. Counting it
 * as already-fresh would let a template whose ID is all zeroes emit a month
 * that keeps it — and then every such month collides with every other one.
 */
function isFreshlyGeneratedId(value: string | undefined): boolean {
  if (!value || value === NIL_UUID) return false
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

function signUpForm(template: SignUpForm | undefined, enabled: boolean): SignUpForm {
  const base: SignUpForm = { ...(template ?? {}), Enabled: enabled, Responses: [] }
  // Keeping a league's Discord-username question on a championship with
  // sign-ups disabled is the §5.5 bug; an empty form is the honest state.
  return enabled ? base : { ...base, ExtraFields: [] }
}

/** Joins a sentence onto a clause without a capital in the middle of it. */
function lower(sentence: string): string {
  return sentence.charAt(0).toLowerCase() + sentence.slice(1)
}

interface BuildEventOptions {
  templateEvent: ChampionshipEvent
  round: RoundSpec
  scheduled: RoundSchedule
  cars: string
  /** Omitted when no track supplied a pit count; see the caller. */
  maxClients?: number
  entryList: EntryList
  baselineRaceSetup: Partial<RaceSetup>
  format?: RaceFormat | undefined
}

function buildEvent(o: BuildEventOptions): ChampionshipEvent {
  const ev: ChampionshipEvent = {
    ...o.templateEvent,
    // Minted here rather than left to the sweep, unlike the class and the
    // championship. Every round is built from the *same* template event, so
    // keeping its ID would give all of them one value — and the sweep maps one
    // old ID to one new ID, so they would stay identical afterwards. Distinct
    // rounds need distinct IDs, and no reference to the template event could
    // have meant "all of them" anyway.
    ID: randomUUID(),
    Scheduled: o.scheduled.scheduled,
    EntryList: o.entryList,
    // A template event carries the results of the race it ran. Carrying those
    // into a new month would make gridmom refuse to import it — correctly.
    StartedTime: "0001-01-01T00:00:00Z",
    CompletedTime: "0001-01-01T00:00:00Z",
    Sessions: {},
    RaceSetup: {
      // Template first, then the league baseline over it, then the fields this
      // round decides. The baseline is a *default*, so it loses to anything
      // the month or the round actually says.
      ...deepMerge(o.templateEvent.RaceSetup ?? {}, o.baselineRaceSetup),
      Track: o.round.track,
      TrackLayout: o.round.layout ?? "",
      Cars: o.cars,
      // Absent rather than 0 when the grid cap is unknown, so the template's
      // value (or the baseline's) survives instead of being overwritten with a
      // number no track supplied.
      ...(o.maxClients === undefined ? {} : { MaxClients: o.maxClients }),
    },
  }
  return o.format ? applyFormat(ev, o.format) : ev
}
