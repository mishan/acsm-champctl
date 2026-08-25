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
import { regenerateIds } from "../acsm/write.js"
import { classes, events } from "../acsm/view.js"
import type { RaceFormat } from "../finalize/format.js"
import { applyFormat } from "../finalize/format.js"
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

  // A spec is usually parsed JSON — champctl-month reads one from a file — so
  // a blank track is a plausible typo rather than a programming error. Left
  // alone it emits an event with `Track: ""`, which ACSM accepts and then
  // fails to load on race night.
  const blank = spec.rounds
    .map((r, i) => (r.track?.trim() ? undefined : i + 1))
    .filter((n): n is number => n !== undefined)
  if (blank.length > 0) {
    throw new EmitError(
      `Round${blank.length === 1 ? "" : "s"} ${blank.join(", ")} ${
        blank.length === 1 ? "has" : "have"
      } no track. Every round needs one — an event with a blank track imports ` +
        `cleanly and then fails to load when the server tries to run it.`,
    )
  }

  const schedule = monthSchedule(spec.rounds, profile, spec.startDate)
  const grid = gridCap(spec.rounds, options.pits)

  // Start from the template, then the league baseline. Both are whole-object
  // overlays, so anything neither mentions survives from the template.
  const base = mergeAll<Championship>(template, profile.baseline.championship ?? {})

  const templateClass = classes(template)[0]
  const templateEvent = events(template)[0]
  if (!templateEvent) {
    throw new EmitError(
      "The template championship has no events to use as a shape for this month's rounds. " +
        "A golden template must be a real exported championship (plan §4.1).",
    )
  }

  const slots = spec.entryListSlots ?? profile.entryList.targetSlots
  const entryList = unclaimedEntryList(slots)

  const spectatorEnabled = base.SpectatorCarEnabled === true
  const cars = derivedCars(spec.cars, spectatorEnabled ? base.SpectatorCar?.Model : undefined)
  derived.push(`RaceSetup.Cars from the class car list${spectatorEnabled ? " plus the spectator car" : ""}`)

  const championshipClass: ChampionshipClass = {
    ...(templateClass ?? {}),
    ID: randomUUID(),
    Name: spec.className ?? spec.cars[0] ?? "Class",
    AvailableCars: [...spec.cars],
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

  const eventList: ChampionshipEvent[] = spec.rounds.map((round, i) =>
    buildEvent({
      templateEvent,
      round,
      scheduled: schedule[i] as RoundSchedule,
      cars,
      maxClients: grid.maxClients,
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

  // The sweep only rewrites UUID-shaped strings, deliberately, so a template
  // with a non-UUID ID would come through unchanged and could still collide.
  // Only that case needs a fresh one, and by then there is nothing left
  // pointing at the old value for it to disagree with.
  if (!isUuid(out.ID)) out.ID = randomUUID()

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
  const all = [...cars]
  if (spectatorModel && !all.includes(spectatorModel)) all.push(spectatorModel)
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

/** Matches what `regenerateIds` considers rewritable, so the two agree. */
function isUuid(value: string | undefined): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value ?? "")
}

function signUpForm(template: SignUpForm | undefined, enabled: boolean): SignUpForm {
  const base: SignUpForm = { ...(template ?? {}), Enabled: enabled, Responses: [] }
  // Keeping a league's Discord-username question on a championship with
  // sign-ups disabled is the §5.5 bug; an empty form is the honest state.
  return enabled ? base : { ...base, ExtraFields: [] }
}

interface BuildEventOptions {
  templateEvent: ChampionshipEvent
  round: RoundSpec
  scheduled: RoundSchedule
  cars: string
  maxClients: number
  entryList: EntryList
  baselineRaceSetup: Partial<RaceSetup>
  format?: RaceFormat | undefined
}

function buildEvent(o: BuildEventOptions): ChampionshipEvent {
  const ev: ChampionshipEvent = {
    ...o.templateEvent,
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
      MaxClients: o.maxClients,
    },
  }
  return o.format ? applyFormat(ev, o.format) : ev
}
