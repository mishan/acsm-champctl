import { DateTime } from "luxon"
import { describe, expect, it } from "vitest"

import { diff } from "../src/acsm/diff.js"
import type { Championship } from "../src/acsm/types.js"
import { events, slots } from "../src/acsm/view.js"
import { gridCap } from "../src/emit/grid.js"
import { deepMerge, definedOnly, mergeAll } from "../src/emit/merge.js"
import {
  ANY_CAR_MODEL,
  derivedCars,
  EmitError,
  emitMonth,
  unclaimedEntryList,
  type MonthSpec,
} from "../src/emit/month.js"
import { cloneMonth, specFromChampionship } from "../src/emit/clone.js"
import { monthSchedule, nextWeekday } from "../src/emit/schedule.js"
import { ScheduleError } from "../src/finalize/schedule.js"
import {
  championship,
  championshipClass,
  driver,
  entryList,
  pitTable,
  raceEvent,
  testProfile,
} from "./support/build.js"

const ZONE = "America/Los_Angeles"
const NOW = new Date("2026-08-24T12:00:00-07:00")

/**
 * Paths the emitter is *supposed* to change when re-emitting a template.
 *
 * Kept as an explicit list rather than a loose filter, so the §4.1 regression
 * test fails on anything else. Adding to this list should feel like a decision.
 */
const EXPECTED_EMIT_CHANGES = [
  /^ID$/,
  /^Created$/,
  /^Updated$/,
  /(^|\.)InternalUUID$/,
  /^Classes\[\d+\]\.ID$/,
  /^Events\[\d+\]\.ID$/,
  // Results are cleared so the month is importable.
  /^Events\[\d+\]\.(StartedTime|CompletedTime|Sessions)/,
  // Regenerated per round.
  /^Events\[\d+\]\.Scheduled$/,
  /^Events\[\d+\]\.ScheduledServerID$/,
  // Entry lists are rebuilt at the sentinel model.
  /^Events\[\d+\]\.EntryList/,
  /^Classes\[\d+\]\.Entrants/,
  // Derived rather than inherited.
  /^Events\[\d+\]\.RaceSetup\.(Cars|MaxClients)$/,
  /^SignUpForm\.Responses/,
]

function isExpectedEmitChange(path: string): boolean {
  return EXPECTED_EMIT_CHANGES.some((re) => re.test(path))
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

describe("deep merge", () => {
  it("lets unmodelled fields flow through untouched", () => {
    // The property that makes this survive ACSM upgrades (plan §4.1).
    const template = { Known: 1, SomeFutureAcsmField: { nested: [1, 2], flag: true } }
    const merged = deepMerge(template, { Known: 2 })
    expect(merged).toEqual({ Known: 2, SomeFutureAcsmField: { nested: [1, 2], flag: true } })
  })

  it("replaces arrays rather than merging them index by index", () => {
    // Events and Classes are ordered lists where position is meaning. Merging
    // a two-event month into a five-event template would leave rounds 3-5 of
    // last month attached to this one.
    const merged = deepMerge({ Events: [1, 2, 3, 4, 5] }, { Events: [9, 8] })
    expect(merged.Events).toEqual([9, 8])
  })

  it("treats undefined as 'not specified' and null as a value", () => {
    // Overlays are built by spreading partials, so optional properties arrive
    // as undefined. Reading that as "blank this field" would silently clear.
    expect(deepMerge({ a: 1, b: 2 }, { a: undefined })).toEqual({ a: 1, b: 2 })
    expect(deepMerge({ a: 1 }, { a: null })).toEqual({ a: null })
  })

  it("does not mutate either input", () => {
    const base = { a: { b: 1 } }
    const overlay = { a: { c: 2 } }
    const before = JSON.stringify([base, overlay])
    deepMerge(base, overlay)
    expect(JSON.stringify([base, overlay])).toBe(before)
  })

  it("refuses prototype-polluting keys from a parsed overlay", () => {
    // A saved month spec is parsed JSON, where __proto__ survives as an
    // ordinary own property — which is what makes a naive merge assign it.
    //
    // The damage is to the *result's* prototype, not to Object.prototype:
    // `out["__proto__"] = value` on a plain object reparents that object, so
    // the merged championship silently inherits fields nobody set. Asserting
    // on global pollution instead would pass either way — verified.
    const overlay = JSON.parse('{"__proto__":{"polluted":true},"Name":"ok"}') as object
    const merged = deepMerge({ Name: "before" }, overlay) as Record<string, unknown>

    expect(merged["Name"]).toBe("ok")
    expect(merged["polluted"]).toBeUndefined()
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined()
  })

  it("applies a chain left to right", () => {
    expect(mergeAll({ a: 1, b: 1, c: 1 }, { b: 2, c: 2 }, { c: 3 })).toEqual({ a: 1, b: 2, c: 3 })
  })

  it("strips undefined from a spread-built overlay", () => {
    expect(definedOnly({ a: 1, b: undefined })).toEqual({ a: 1 })
  })
})

// ---------------------------------------------------------------------------
// Grid cap
// ---------------------------------------------------------------------------

describe("grid cap", () => {
  const pits = pitTable([
    { track: "spa", layout: "", pitboxes: 30, source: "manual", verifiedAt: "2026-01-01T00:00:00Z" },
    {
      track: "brands_hatch",
      layout: "indy",
      pitboxes: 24,
      source: "manual",
      verifiedAt: "2026-01-01T00:00:00Z",
    },
    { track: "suzuka", layout: "", pitboxes: 30, source: "manual", verifiedAt: "2026-01-01T00:00:00Z" },
  ])

  it("names the track that binds the cap", () => {
    // "Capped at 24" invites an argument; naming the track says what to drop.
    const cap = gridCap(
      [{ track: "spa" }, { track: "brands_hatch", layout: "indy" }, { track: "suzuka" }],
      pits,
    )
    expect(cap.maxClients).toBe(24)
    expect(cap.bindingTrack).toBe("brands_hatch (indy)")
    expect(cap.summary).toBe("Capped at 24 by brands_hatch (indy).")
  })

  it("does not treat an unknown pit count as unlimited", () => {
    // Emitting a number derived from nothing is worse than saying it's unknown.
    const cap = gridCap([{ track: "spa" }, { track: "some_mod_track" }], pits)
    expect(cap.maxClients).toBe(30)
    expect(cap.unknownTracks).toEqual(["some_mod_track"])
    expect(cap.summary).toContain("no pit count on file")
  })

  it("says so when nothing is known at all", () => {
    const cap = gridCap([{ track: "mod_a" }, { track: "mod_b" }], pits)
    expect(cap.maxClients).toBe(0)
    expect(cap.bindingTrack).toBeUndefined()
    expect(cap.summary).toContain("grid cap is unknown")
    expect(cap.summary).toContain("mod_a and mod_b")
  })

  it("handles a month with one track", () => {
    expect(gridCap([{ track: "spa" }], pits)).toMatchObject({
      maxClients: 30,
      bindingTrack: "spa",
    })
  })
})

// ---------------------------------------------------------------------------
// Schedule generation
// ---------------------------------------------------------------------------

describe("month schedule", () => {
  const profile = testProfile() // weekday 3 (Wed), quali 20:00, 60m practice

  it("puts one round a week on the league's weekday", () => {
    const rounds = monthSchedule([{}, {}, {}], profile, "2026-09-02")
    const dates = rounds.map((r) => DateTime.fromISO(r.qualiStart).setZone(ZONE))

    expect(dates.map((d) => d.toFormat("yyyy-MM-dd"))).toEqual([
      "2026-09-02",
      "2026-09-09",
      "2026-09-16",
    ])
    for (const d of dates) expect(d.weekday).toBe(3)
  })

  it("schedules practice start, not quali start", () => {
    // Scheduled = qualiStart − practiceDuration. An hour out otherwise.
    const [first] = monthSchedule([{}], profile, "2026-09-02")
    const scheduled = DateTime.fromISO(first?.scheduled ?? "").setZone(ZONE)
    expect(scheduled.toFormat("HH:mm")).toBe("19:00")
    expect(DateTime.fromISO(first?.qualiStart ?? "").setZone(ZONE).toFormat("HH:mm")).toBe("20:00")
  })

  it("keeps the wall clock across the November DST boundary", () => {
    // Five rounds spanning the change; every one is still an 8pm quali.
    const rounds = monthSchedule([{}, {}, {}, {}, {}], profile, "2026-10-14")
    const quali = rounds.map((r) => DateTime.fromISO(r.qualiStart).setZone(ZONE))
    for (const q of quali) expect(q.toFormat("HH:mm")).toBe("20:00")
    // And the offset really did change underneath them.
    expect(quali[0]?.offset).not.toBe(quali.at(-1)?.offset)
  })

  it("takes a per-round date override without shifting later rounds", () => {
    // A race moving a week is a one-off; dragging the rest of the month along
    // would be a surprise nobody asked for.
    const rounds = monthSchedule([{}, { date: "2026-09-12" }, {}], profile, "2026-09-02")
    const dates = rounds.map((r) => DateTime.fromISO(r.qualiStart).setZone(ZONE).toFormat("yyyy-MM-dd"))
    expect(dates).toEqual(["2026-09-02", "2026-09-12", "2026-09-16"])
    expect(rounds[1]?.overridden).toBe(true)
    expect(rounds[2]?.overridden).toBe(false)
  })

  it("carries the note explaining why a round moved", () => {
    const [, second] = monthSchedule(
      [{}, { date: "2026-09-12", dateNote: "clashes with the 24h" }],
      profile,
      "2026-09-02",
    )
    expect(second?.note).toBe("clashes with the 24h")
  })

  it("refuses a start date in a DST gap rather than moving the race", () => {
    const springProfile = testProfile({
      schedule: { ...profile.schedule, qualiStart: "02:30" },
    })
    expect(() => monthSchedule([{}], springProfile, "2026-03-08")).toThrow(ScheduleError)
  })

  it("finds the next occurrence of a weekday, including today", () => {
    const wed = DateTime.fromISO("2026-09-02T15:00", { zone: ZONE })
    expect(nextWeekday(wed, 3).toFormat("yyyy-MM-dd")).toBe("2026-09-02")
    expect(nextWeekday(wed.plus({ days: 1 }), 3).toFormat("yyyy-MM-dd")).toBe("2026-09-09")
  })
})

// ---------------------------------------------------------------------------
// Entry list
// ---------------------------------------------------------------------------

describe("entry list generation", () => {
  it("emits N slots at the sentinel model", () => {
    // Multi-model months are solved by the sentinel, not by preallocation
    // (plan §4.4). ACSM overwrites it when a sign-up is accepted.
    const list = unclaimedEntryList(4)
    expect(Object.keys(list)).toEqual(["CAR_0", "CAR_1", "CAR_2", "CAR_3"])
    for (const e of Object.values(list)) expect(e.Model).toBe(ANY_CAR_MODEL)
  })

  it("lines PitBox up with the CAR_n key", () => {
    // CAR_n *is* the pit box (docs §3); a mismatch means entrants overwrite
    // each other on the next form save.
    for (const [key, entrant] of Object.entries(unclaimedEntryList(5))) {
      expect(entrant.PitBox).toBe(Number(key.slice("CAR_".length)))
    }
  })

  it("refuses a nonsensical slot count", () => {
    expect(() => unclaimedEntryList(-1)).toThrow(EmitError)
    expect(() => unclaimedEntryList(1.5)).toThrow(EmitError)
  })
})

describe("deriving RaceSetup.Cars", () => {
  it("joins the class car list with semicolons", () => {
    expect(derivedCars(["rss_formula_hybrid_2021", "ks_porsche_911"])).toBe(
      "rss_formula_hybrid_2021;ks_porsche_911",
    )
  })

  it("includes the spectator model only when the spectator car is on", () => {
    // The §5.5 bug: the template's Cars still listed ford_transit with the
    // spectator car disabled, advertising a van nobody could pick.
    expect(derivedCars(["a"], "ford_transit")).toBe("a;ford_transit")
    expect(derivedCars(["a"])).toBe("a")
  })

  it("does not duplicate a spectator model already in the list", () => {
    expect(derivedCars(["a", "ford_transit"], "ford_transit")).toBe("a;ford_transit")
  })
})

// ---------------------------------------------------------------------------
// The emitter
// ---------------------------------------------------------------------------

describe("emitting a month", () => {
  const template = (over: Partial<Championship> = {}): Championship =>
    championship({
      ID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      Name: "Last Month",
      Created: "2026-07-01T00:00:00-07:00",
      Updated: "2026-07-01T00:00:00-07:00",
      Classes: [championshipClass({ AvailableCars: ["old_car"] })],
      Events: [
        raceEvent({
          StartedTime: "2026-07-08T19:00:00-07:00",
          CompletedTime: "2026-07-08T21:00:00-07:00",
          EntryList: entryList([driver("Ada"), driver("Grace")]),
          RaceSetup: { Track: "old_track", Cars: "old_car;ford_transit", MaxClients: 12 },
        }),
      ],
      ...over,
    })

  const spec = (over: Partial<MonthSpec> = {}): MonthSpec => ({
    name: "September 2026",
    cars: ["rss_formula_hybrid_2021"],
    rounds: [{ track: "spa" }, { track: "suzuka" }],
    startDate: "2026-09-02",
    ...over,
  })

  const pits = pitTable([
    { track: "spa", layout: "", pitboxes: 30, source: "manual", verifiedAt: "2026-01-01T00:00:00Z" },
    { track: "suzuka", layout: "", pitboxes: 24, source: "manual", verifiedAt: "2026-01-01T00:00:00Z" },
  ])

  const emit = (o: { template?: Championship; spec?: MonthSpec } = {}) =>
    emitMonth({
      template: o.template ?? template(),
      spec: o.spec ?? spec(),
      profile: testProfile(),
      pits,
      now: NOW,
    })

  it("makes one event per round, in order", () => {
    const { championship: c } = emit()
    expect(events(c).map((e) => e.RaceSetup?.Track)).toEqual(["spa", "suzuka"])
  })

  it("stamps Created rather than inheriting the template's", () => {
    // §5.5: the test championship claimed to exist a month before it did.
    const { championship: c } = emit()
    expect(c.Created).toBe(NOW.toISOString())
    expect(c.Created).not.toBe("2026-07-01T00:00:00-07:00")
  })

  it("derives Cars instead of inheriting a stale list", () => {
    // §5.5: the template's Cars carried ford_transit with the spectator car off.
    const { championship: c } = emit()
    for (const ev of events(c)) {
      expect(ev.RaceSetup?.Cars).toBe("rss_formula_hybrid_2021")
      expect(ev.RaceSetup?.Cars).not.toContain("ford_transit")
    }
  })

  it("turns off ExportSecondRaceToACSR when ACSR is off", () => {
    // §5.5: harmless in itself, but exactly the contradiction to not emit.
    const { championship: c } = emit({
      template: template({ ACSR: false, ExportSecondRaceToACSR: true }),
    })
    expect(c.ExportSecondRaceToACSR).toBe(false)
  })

  it("leaves ExportSecondRaceToACSR alone when ACSR is on", () => {
    const { championship: c } = emit({
      template: template({ ACSR: true, ExportSecondRaceToACSR: true }),
    })
    expect(c.ExportSecondRaceToACSR).toBe(true)
  })

  it("clears sign-up ExtraFields when sign-ups are disabled", () => {
    // §5.5: BATL's Discord-username question survived onto a form nobody sees.
    const { championship: c } = emit({
      template: template({
        SignUpForm: { Enabled: false, Responses: [], ExtraFields: [{ Name: "Discord" }] },
      }),
    })
    expect(c.SignUpForm?.ExtraFields).toEqual([])
  })

  it("keeps ExtraFields when sign-ups are on", () => {
    const { championship: c } = emit({
      template: template({
        SignUpForm: { Enabled: true, Responses: [], ExtraFields: [{ Name: "Discord" }] },
      }),
      spec: spec({ signUpsEnabled: true }),
    })
    expect(c.SignUpForm?.ExtraFields).toEqual([{ Name: "Discord" }])
  })

  it("never carries the template's sign-up responses", () => {
    // Public data, and last month's applicants have nothing to do with this
    // month (plan §5.3).
    const { championship: c } = emit({
      template: template({
        SignUpForm: {
          Enabled: true,
          ExtraFields: [],
          Responses: [{ Name: "Ada", GUID: "76561198000000001" }],
        },
      }),
    })
    expect(c.SignUpForm?.Responses).toEqual([])
  })

  it("drops the template's results, so the month is importable", () => {
    // A template event carries the race it ran; carrying those in would make
    // the import safety rules refuse it, correctly.
    const { championship: c } = emit()
    for (const ev of events(c)) {
      expect(ev.StartedTime).toBe("0001-01-01T00:00:00Z")
      expect(ev.CompletedTime).toBe("0001-01-01T00:00:00Z")
      expect(ev.Sessions).toEqual({})
    }
  })

  it("does not carry last month's drivers into this month's entry list", () => {
    const { championship: c } = emit()
    for (const ev of events(c)) {
      const names = slots(ev.EntryList).map((s) => s.entrant.Name)
      expect(names.every((n) => n === "")).toBe(true)
    }
  })

  it("regenerates every UUID, so importing creates rather than overwrites", () => {
    const t = template()
    const { championship: c } = emit({ template: t })
    expect(c.ID).not.toBe(t.ID)
    expect(c.ID).toMatch(/^[0-9a-f-]{36}$/)
    expect(JSON.stringify(c)).not.toContain(t.ID as string)
  })

  it("regenerates a UUID hiding in a field the emitter has never heard of", () => {
    // The root ID and the class/event IDs are assigned directly, so they change
    // whether or not the sweep runs. This is what the sweep is actually for:
    // unmodelled fields flow through by design, and one carrying a template
    // UUID would make the import collide with the championship it came from.
    const stale = "12345678-1234-1234-1234-123456789abc"
    const t = template() as Championship & { SomeFutureAcsmField?: unknown }
    t.SomeFutureAcsmField = { LinkedID: stale }

    const { championship: c } = emit({ template: t })
    expect(JSON.stringify(c)).not.toContain(stale)
    const future = (c as Record<string, unknown>)["SomeFutureAcsmField"] as { LinkedID: string }
    expect(future.LinkedID).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("writes MaxClients from the binding track, and says which", () => {
    const { championship: c, grid } = emit()
    expect(grid.maxClients).toBe(24)
    expect(grid.summary).toContain("suzuka")
    for (const ev of events(c)) expect(ev.RaceSetup?.MaxClients).toBe(24)
  })

  it("does not size the entry list down to the grid cap", () => {
    // §4.4: 30 slots against MaxClients 18 is deliberate oversubscription.
    // Sizing to the smallest track locks people out of a *championship* for a
    // constraint that applies on one night.
    const { championship: c, grid } = emit()
    expect(grid.maxClients).toBe(24)
    for (const ev of events(c)) {
      expect(Object.keys(ev.EntryList ?? {})).toHaveLength(testProfile().entryList.targetSlots)
    }
    expect(testProfile().entryList.targetSlots).toBeGreaterThan(grid.maxClients)
  })

  it("applies a month-wide format to every round", () => {
    const { championship: c } = emit({
      spec: spec({
        format: {
          length: { kind: "laps", laps: 18 },
          reversedGridPositions: 5,
          mandatoryPit: true,
          extraLap: false,
        },
      }),
    })
    for (const ev of events(c)) {
      expect(ev.RaceSetup?.RacePitWindowStart).toBe(1)
      expect(ev.RaceSetup?.ReversedGridRacePositions).toBe(5)
    }
  })

  it("lets a round override the month's format", () => {
    const { championship: c } = emit({
      spec: spec({
        format: {
          length: { kind: "laps", laps: 18 },
          reversedGridPositions: 0,
          mandatoryPit: false,
          extraLap: false,
        },
        rounds: [
          { track: "spa" },
          {
            track: "suzuka",
            format: {
              length: { kind: "minutes", minutes: 40 },
              reversedGridPositions: 0,
              mandatoryPit: true,
              extraLap: false,
            },
          },
        ],
      }),
    })
    const [spa, suzuka] = events(c)
    expect(spa?.RaceSetup?.RacePitWindowStart).toBe(0)
    expect(suzuka?.RaceSetup?.RacePitWindowStart).toBe(1)
  })

  it("reports what it set rather than inherited", () => {
    const { derived } = emit()
    expect(derived.join(" ")).toMatch(/Cars/)
    expect(derived.join(" ")).toMatch(/Created/)
    expect(derived.join(" ")).toMatch(/UUID/)
  })

  it("refuses a month with no rounds or no cars", () => {
    expect(() => emit({ spec: spec({ rounds: [] }) })).toThrow(EmitError)
    expect(() => emit({ spec: spec({ cars: [] }) })).toThrow(EmitError)
  })

  it("refuses a template with no events to take a shape from", () => {
    expect(() => emit({ template: template({ Events: [] }) })).toThrow(/no events/)
  })

  it("re-emitting with no overrides changes nothing but the IDs and stamps", () => {
    // Plan §4.1's regression test. When an ACSM upgrade adds a field the
    // emitter doesn't know about, this fails — before a Wednesday does.
    const t = template()
    // No format: applying one is an override, and it deliberately normalises
    // absent booleans to explicit ones. This is the template pipeline alone.
    const { format: _ignored, ...asSpec } = specFromChampionship(t)
    const { championship: c } = emitMonth({
      template: t,
      spec: { ...asSpec, name: t.Name as string },
      profile: testProfile(),
      pits,
      now: NOW,
    })

    const changes = diff(t, c, { omitEmpty: true, timestampsAsInstants: true }).filter(
      (d) => !isExpectedEmitChange(d.path),
    )
    expect(changes, JSON.stringify(changes, null, 2)).toEqual([])
  })

  it("keeps unmodelled template fields", () => {
    // The whole point of template-and-overlay: a field champctl has never
    // heard of survives into the emitted month.
    const t = template() as Championship & { SomeFutureAcsmField?: unknown }
    t.SomeFutureAcsmField = { nested: true }
    const { championship: c } = emit({ template: t })
    expect((c as Record<string, unknown>)["SomeFutureAcsmField"]).toEqual({ nested: true })
  })

  describe("clone last month", () => {
    const lastMonth = championship({
      ID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      Name: "August 2026",
      Classes: [
        championshipClass({
          Name: "GT3",
          AvailableCars: ["car_a", "car_b"],
          Entrants: entryList([driver("Ada"), driver("Grace"), driver("Linus")]),
        }),
      ],
      Events: [
        raceEvent({
          RaceSetup: {
            Track: "spa",
            Cars: "car_a;car_b;ford_transit",
            Sessions: { Race: { Name: "Race", Time: 0, Laps: 20, IsOpen: 1 } },
          },
        }),
        raceEvent({ RaceSetup: { Track: "suzuka" } }),
      ],
    })

    it("reads the tracks, cars and class name back out", () => {
      const spec = specFromChampionship(lastMonth)
      expect(spec.rounds.map((r) => r.track)).toEqual(["spa", "suzuka"])
      expect(spec.cars).toEqual(["car_a", "car_b"])
      expect(spec.className).toBe("GT3")
      expect(spec.entryListSlots).toBe(3)
    })

    it("prefers the class car list over the derived RaceSetup.Cars", () => {
      // RaceSetup.Cars can carry a spectator model the class never had — that
      // is the §5.5 bug. Cloning from it would propagate the van forever.
      expect(specFromChampionship(lastMonth).cars).not.toContain("ford_transit")
    })

    it("does not carry last month's dates", () => {
      // The one thing a clone definitely doesn't want: a "new" month that has
      // already happened.
      const spec = specFromChampionship(lastMonth)
      expect(spec.rounds.every((r) => r.date === undefined)).toBe(true)
      expect(spec).not.toHaveProperty("startDate")
    })

    it("builds this month from last month", () => {
      const { championship: c, grid } = cloneMonth({
        source: lastMonth,
        profile: testProfile(),
        pits,
        now: NOW,
        overrides: { name: "September 2026", startDate: "2026-09-02" },
      })

      expect(c.Name).toBe("September 2026")
      expect(c.ID).not.toBe(lastMonth.ID)
      expect(events(c).map((e) => e.RaceSetup?.Track)).toEqual(["spa", "suzuka"])
      expect(grid.maxClients).toBe(24)
      // And the clone goes through the same fixes as a fresh month.
      expect(c.Created).toBe(NOW.toISOString())
      for (const ev of events(c)) expect(ev.RaceSetup?.Cars).toBe("car_a;car_b")
    })

    it("lets overrides replace the track list outright", () => {
      const { championship: c } = cloneMonth({
        source: lastMonth,
        profile: testProfile(),
        pits,
        now: NOW,
        overrides: { name: "Sept", startDate: "2026-09-02", rounds: [{ track: "suzuka" }] },
      })
      expect(events(c)).toHaveLength(1)
    })

    it("refuses to clone a championship with no events", () => {
      expect(() => specFromChampionship(championship({ Events: [] }))).toThrow(EmitError)
    })

    it("refuses a clone with no name to give it", () => {
      expect(() =>
        cloneMonth({
          source: championship({ Name: "", Events: [raceEvent()] }),
          profile: testProfile(),
          now: NOW,
        }),
      ).toThrow(/needs a name/)
    })
  })
})
