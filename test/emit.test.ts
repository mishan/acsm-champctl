import { DateTime } from "luxon"
import { describe, expect, it } from "vitest"

import { diff } from "../src/acsm/diff.js"
import type { Championship } from "../src/acsm/types.js"
import { ANY_CAR_MODEL as CANONICAL_ANY_CAR_MODEL } from "../src/acsm/types.js"
import { events, isAnyCarModel, session, slots } from "../src/acsm/view.js"
import { gridCap } from "../src/emit/grid.js"
import { deepMerge, definedOnly, mergeAll } from "../src/emit/merge.js"
import { FORBIDDEN_KEYS } from "../src/acsm/write.js"
import {
  ANY_CAR_MODEL,
  derivedCars,
  EmitError,
  emitChampionship,
  unclaimedEntryList,
  type ChampionshipSpec,
} from "../src/emit/championship.js"
import { cloneChampionship, specFromChampionship } from "../src/emit/clone.js"
import type { PitTable } from "../src/pits/table.js"
import { monthSchedule, nextWeekday } from "../src/emit/schedule.js"
import { ScheduleError } from "../src/finalize/schedule.js"
import { check } from "../src/gridmom/index.js"
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
  // Results are cleared so the championship is importable.
  /^Events\[\d+\]\.(StartedTime|CompletedTime|Sessions)/,
  // Regenerated per round.
  /^Events\[\d+\]\.Scheduled$/,
  /^Events\[\d+\]\.ScheduledServerID$/,
  // Entry lists are rebuilt at the sentinel model.
  /^Events\[\d+\]\.EntryList/,
  /^Classes\[\d+\]\.Entrants/,
  // Derived rather than inherited.
  /^Events\[\d+\]\.RaceSetup\.(Cars|MaxClients)$/,
  // Set per round, and empty unless the spec named one. Every round is built
  // from the same template event, so an inherited name is the template's track
  // on all of them — see "does not name every round after the template's
  // track". `""` is what ACSM writes for an event it created.
  /^Events\[\d+\]\.Name$/,
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
    // a two-event championship into a five-event template would leave rounds 3-5 of
    // the previous championship attached to this one.
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
    // A saved championship spec is parsed JSON, where __proto__ survives as an
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

  it("refuses every key the canonical list names, not a copy of it", () => {
    // This module used to keep its own FORBIDDEN_KEYS beside the one in
    // acsm/write.ts. Two lists is one that gets updated and one that doesn't,
    // and the one that doesn't guards a merge fed by parsed JSON.
    //
    // Driving the assertion off the imported set rather than a literal is the
    // point: a key added there has to be refused here, or this fails.
    for (const key of FORBIDDEN_KEYS) {
      const overlay = JSON.parse(`{"${key}":{"polluted":true},"Name":"ok"}`) as object
      const merged = deepMerge({ Name: "before" }, overlay) as Record<string, unknown>

      expect(merged["Name"], `${key} overlay still merged the rest`).toBe("ok")
      expect(merged["polluted"], `${key} leaked a field`).toBeUndefined()
      expect(Object.getPrototypeOf(merged), `${key} reparented the result`).toBe(Object.prototype)
    }
  })

  it("doesn't keep a list of its own to drift from", async () => {
    // The behavioural test above only fires once the two lists *disagree*, so
    // a freshly re-added identical copy would sail past it and then rot. This
    // fires the moment one exists.
    const merge = await import("../src/emit/merge.js")
    expect(Object.keys(merge)).not.toContain("FORBIDDEN_KEYS")
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
    {
      track: "spa",
      layout: "",
      pitboxes: 30,
      source: "manual",
      verifiedAt: "2026-01-01T00:00:00Z",
    },
    {
      track: "brands_hatch",
      layout: "indy",
      pitboxes: 24,
      source: "manual",
      verifiedAt: "2026-01-01T00:00:00Z",
    },
    {
      track: "suzuka",
      layout: "",
      pitboxes: 30,
      source: "manual",
      verifiedAt: "2026-01-01T00:00:00Z",
    },
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

  it("handles a championship with one track", () => {
    expect(gridCap([{ track: "spa" }], pits)).toMatchObject({
      maxClients: 30,
      bindingTrack: "spa",
    })
  })
})

// ---------------------------------------------------------------------------
// Schedule generation
// ---------------------------------------------------------------------------

describe("championship schedule", () => {
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
    expect(
      DateTime.fromISO(first?.qualiStart ?? "")
        .setZone(ZONE)
        .toFormat("HH:mm"),
    ).toBe("20:00")
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
    // A race moving a week is a one-off; dragging the rest of the championship along
    // would be a surprise nobody asked for.
    const rounds = monthSchedule([{}, { date: "2026-09-12" }, {}], profile, "2026-09-02")
    const dates = rounds.map((r) =>
      DateTime.fromISO(r.qualiStart).setZone(ZONE).toFormat("yyyy-MM-dd"),
    )
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
    // Multi-model championships are solved by the sentinel, not by preallocation
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

describe("emitting a championship", () => {
  const template = (over: Partial<Championship> = {}): Championship =>
    championship({
      ID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      Name: "Previous Championship",
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

  const spec = (over: Partial<ChampionshipSpec> = {}): ChampionshipSpec => ({
    name: "September 2026",
    cars: ["rss_formula_hybrid_2021"],
    rounds: [{ track: "spa" }, { track: "suzuka" }],
    startDate: "2026-09-02",
    ...over,
  })

  const pits = pitTable([
    {
      track: "spa",
      layout: "",
      pitboxes: 30,
      source: "manual",
      verifiedAt: "2026-01-01T00:00:00Z",
    },
    {
      track: "suzuka",
      layout: "",
      pitboxes: 24,
      source: "manual",
      verifiedAt: "2026-01-01T00:00:00Z",
    },
  ])

  const emit = (
    o: { template?: Championship; spec?: ChampionshipSpec; pits?: PitTable | undefined } = {},
  ) =>
    emitChampionship({
      template: o.template ?? template(),
      spec: o.spec ?? spec(),
      profile: testProfile(),
      // Passing `pits: undefined` explicitly means "no pit table" — the case
      // one of these tests is about — and omitting the key entirely means "use
      // the shared one". Both end up *absent* on EmitOptions rather than set to
      // undefined, because exactOptionalPropertyTypes distinguishes the two and
      // EmitOptions.pits does not accept undefined.
      ...("pits" in o ? (o.pits ? { pits: o.pits } : {}) : { pits }),
      now: NOW,
    })

  it("makes one event per round, in order", () => {
    const { championship: c } = emit()
    expect(events(c).map((e) => e.RaceSetup?.Track)).toEqual(["spa", "suzuka"])
  })

  /**
   * Every round is built from the *same* template event, so anything on it that
   * describes a track and isn't `RaceSetup.Track` gets copied onto all of them.
   * `Name` is exactly that, and it is what a person reads.
   *
   * BATL's first championship built this way came out with all five rounds
   * called "Donington Park National, Great Britain" — July's round one — while
   * `RaceSetup.Track` was correct throughout, so gridmom reported the right
   * tracks and the manager displayed the wrong ones. Nothing caught it because
   * ACSM writes `Name: ""` on every event it creates, so every fixture had an
   * empty string to copy and copying it looked like working.
   */
  it("does not name every round after the template's track", () => {
    const t = template()
    for (const ev of events(t)) ev.Name = "Donington Park National, Great Britain"

    const { championship: c } = emit({ template: t })
    expect(events(c).map((e) => e.Name)).toEqual(["", ""])
    // And the tracks are still the ones asked for, which was never the problem.
    expect(events(c).map((e) => e.RaceSetup?.Track)).toEqual(["spa", "suzuka"])
  })

  it("uses a round's own name when the spec gives one", () => {
    // `RoundSpec.name` has been declared since the emitter was written and was
    // never read — so a spec that named a round was quietly ignored, and the
    // template's name won anyway.
    const { championship: c } = emit({
      spec: {
        ...spec(),
        rounds: [{ track: "spa", name: "Season opener" }, { track: "suzuka" }],
      },
    })
    expect(events(c).map((e) => e.Name)).toEqual(["Season opener", ""])
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
    // Public data, and the previous championship's applicants have nothing to do with this
    // championship (plan §5.3).
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

  it("drops the template's results, so the championship is importable", () => {
    // A template event carries the race it ran; carrying those in would make
    // the import safety rules refuse it, correctly.
    const { championship: c } = emit()
    for (const ev of events(c)) {
      expect(ev.StartedTime).toBe("0001-01-01T00:00:00Z")
      expect(ev.CompletedTime).toBe("0001-01-01T00:00:00Z")
      expect(ev.Sessions).toEqual({})
    }
  })

  it("does not carry the previous championship's drivers into this championship's entry list", () => {
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

  it("keeps a reference to the class ID pointing at the class", () => {
    // Minting the class ID before the sweep broke this. The sweep maps each
    // distinct old UUID to one new one, so a fresh class ID and the template
    // class ID an unmodelled field still held were two different inputs and
    // came out as two different values — a reference that matched in the
    // template silently stopped matching in the emitted championship.
    const templateClassId = "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb"
    const t = template({
      Classes: [championshipClass({ ID: templateClassId, AvailableCars: ["old_car"] })],
    }) as Championship & { SomeFutureAcsmField?: unknown }
    t.SomeFutureAcsmField = { ClassRef: templateClassId }

    const { championship: c } = emit({ template: t })
    const ref = (c as Record<string, unknown>)["SomeFutureAcsmField"] as { ClassRef: string }

    expect(c.Classes?.[0]?.ID).toBe(ref.ClassRef)
    // Still regenerated — the point is that it moved consistently, not that it
    // stayed put.
    expect(c.Classes?.[0]?.ID).not.toBe(templateClassId)
  })

  it("repoints references when the root id wasn't UUID-shaped", () => {
    // The sweep skips a non-UUID id — and skips every unmodelled field holding
    // a copy of it, for the same reason. Minting a fresh root id on its own
    // therefore left those references pointing at an id that no longer existed
    // anywhere, which is the failure the sweep exists to prevent, arriving by
    // the one route it doesn't cover.
    const t = template({ ID: "previous-championship" }) as Championship & {
      SomeFutureAcsmField?: unknown
    }
    t.SomeFutureAcsmField = { ChampionshipRef: "previous-championship" }

    const { championship: c, derived } = emit({ template: t })
    const ref = (c as Record<string, unknown>)["SomeFutureAcsmField"] as {
      ChampionshipRef: string
    }

    expect(c.ID).toMatch(/^[0-9a-f-]{36}$/)
    expect(c.ID).not.toBe("previous-championship")
    expect(ref.ChampionshipRef).toBe(c.ID)
    expect(JSON.stringify(c)).not.toContain("previous-championship")
    expect(derived.join(" ")).toMatch(/references to the template's id/)
  })

  it("emits a championship with nothing reparented, whatever the template carried", () => {
    // An end-to-end invariant, not a test of one guard. Two passes rebuild
    // every object in the championship — the id sweep and, for a non-UUID root
    // id, replaceExactString — and `out[k] = ...` with a __proto__ key
    // reparents an object rather than adding a field. An export is parsed
    // JSON, where __proto__ survives as an ordinary own property.
    //
    // Deliberately asserted on the emitted championship rather than on either pass:
    // when this was written the two happened to cancel out, the sweep
    // reparenting and replaceExactString rebuilding it away, so a test aimed
    // at one of them passed whether or not it was guarded. What must hold is
    // that nothing comes out of emitChampionship inheriting fields nobody set.
    const t = template({ ID: "previous-championship" }) as Championship & {
      SomeFutureAcsmField?: unknown
    }
    // Parsed, because __proto__ only survives as an own property that way.
    t.SomeFutureAcsmField = JSON.parse(
      String.raw`{"__proto__":{"polluted":true},"Ref":"ok"}`,
    ) as object

    const { championship: c } = emit({ template: t })
    const field = (c as Record<string, unknown>)["SomeFutureAcsmField"] as Record<string, unknown>

    expect(field["polluted"]).toBeUndefined()
    expect(Object.getPrototypeOf(field)).toBe(Object.prototype)
    expect(field["Ref"]).toBe("ok")
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined()
  })

  it("does not repoint the nil UUID, which means 'unset' everywhere", () => {
    // The one id that must not be swept: it is the blank-value sentinel, so
    // rewriting each occurrence would turn every unset date and reference in
    // the championship into a reference to the championship.
    const t = template({ ID: "00000000-0000-0000-0000-000000000000" }) as Championship & {
      SomeFutureAcsmField?: unknown
    }
    t.SomeFutureAcsmField = { Unset: "00000000-0000-0000-0000-000000000000" }

    const { championship: c } = emit({ template: t })
    const kept = (c as Record<string, unknown>)["SomeFutureAcsmField"] as { Unset: string }

    expect(c.ID).toMatch(/^[0-9a-f-]{36}$/)
    expect(c.ID).not.toBe("00000000-0000-0000-0000-000000000000")
    expect(kept.Unset).toBe("00000000-0000-0000-0000-000000000000")
  })

  it("mints a class ID the sweep would not have rewritten", () => {
    // The sweep only rewrites UUID-shaped strings that aren't the nil UUID, so
    // carrying the template's ID through is only safe when it is one. The
    // shared fixture uses "class-1", which is exactly this case.
    const t = template()
    expect(t.Classes?.[0]?.ID).toBe("class-1")

    const { championship: c } = emit({ template: t })
    expect(c.Classes?.[0]?.ID).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("gives each round its own event ID", () => {
    // The class can be carried through the sweep; the event cannot. Every round
    // is built from the same template event, and the sweep maps one old ID to
    // one new ID, so leaving it to the sweep would give every round the same
    // event ID.
    const { championship: c } = emit()
    const ids = events(c).map((e) => e.ID)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("emits a championship gridmom has no errors about", () => {
    // The check the emitter's whole rationale rests on, and the one that was
    // missing: everything else here asserts a field, while this asserts the
    // two modules agree about the same championship. Three separate bugs hid
    // behind its absence — MaxClients: 0, the spectator car uncounted against
    // the grid cap, and Scheduled derived from the profile's practice length
    // rather than the event's.
    const { championship: c } = emit()
    const report = check(c, testProfile(), { pits, now: NOW })
    const errors = report.findings.filter((f) => f.severity === "ERROR")
    expect(errors.map((f) => `${f.code}: ${f.message}`)).toEqual([])
  })

  it("emits a championship gridmom has no errors about, with a spectator car", () => {
    // The spectator car occupies a pit box, so gridmom counts it against the
    // track's capacity. gridCap did not, so any template with one emitted a
    // championship whose MaxClients was exactly one too many for its tightest track.
    const t = template({ SpectatorCarEnabled: true, SpectatorCar: { Model: "ford_transit" } })
    const { championship: c } = emit({ template: t })
    const report = check(c, testProfile(), { pits, now: NOW })
    expect(report.findings.filter((f) => f.severity === "ERROR")).toEqual([])
  })

  it("derives Scheduled from the event's practice length, not the profile's", () => {
    // monthSchedule used profile.schedule.practiceMinutes for every round while
    // the practice session came from the template, so a 30-minute practice
    // against a 60-minute default put quali half an hour early — and gridmom's
    // schedule.derived-start, which reads the length off the event, says so.
    //
    // The session is *replaced*, not added: the fixture already carries a
    // "Practice" at 60, and adding a "PRACTICE" at 30 beside it just leaves
    // lookupSession finding the first one. The initial version of this test did
    // exactly that and measured nothing.
    const t = template()
    for (const ev of events(t)) {
      ev.RaceSetup = {
        ...ev.RaceSetup,
        Sessions: { Practice: { Name: "Practice", Time: 30, Laps: 0, IsOpen: 1 } },
      }
    }
    expect(session(events(t)[0]!, "Practice")?.Time).toBe(30)

    const { championship: c } = emit({ template: t })
    expect(session(events(c)[0]!, "Practice")?.Time).toBe(30)

    const report = check(c, testProfile(), { pits, now: NOW })
    expect(report.findings.map((f) => f.code)).not.toContain("schedule.derived-start")
  })

  it("writes MaxClients from the binding track, and says which", () => {
    const { championship: c, grid, derived } = emit()
    expect(grid.maxClients).toBe(24)
    expect(grid.summary).toContain("suzuka")
    for (const ev of events(c)) expect(ev.RaceSetup?.MaxClients).toBe(24)
    expect(derived.join(" ")).toMatch(/MaxClients 24 from .*suzuka/)
  })

  it("leaves MaxClients alone when no track has a pit count", () => {
    // gridCap returns its fallback of 0 to mean "no cap", and writing that
    // through gave every round MaxClients: 0 — a grid nobody can join, from a
    // number no track supplied, clobbering whatever the template said. gridmom
    // cannot catch it either: grid.max-clients returns early with no pit
    // record, and 0 <= pitboxes passes when there is one.
    const t = template()
    for (const ev of events(t)) ev.RaceSetup = { ...ev.RaceSetup, MaxClients: 12 }

    const { championship: c, grid, derived } = emit({ template: t, pits: undefined })

    expect(grid.bindingTrack).toBeUndefined()
    for (const ev of events(c)) expect(ev.RaceSetup?.MaxClients).toBe(12)
    expect(derived.join(" ")).toMatch(/MaxClients left as the template had it/)
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

  it("applies a championship-wide format to every round", () => {
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

  it("lets a round override the championship's format", () => {
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

  it("refuses a championship with no rounds or no cars", () => {
    expect(() => emit({ spec: spec({ rounds: [] }) })).toThrow(EmitError)
    expect(() => emit({ spec: spec({ cars: [] }) })).toThrow(EmitError)
  })

  it("refuses a round with a blank track, naming the round", () => {
    // A spec is usually parsed JSON — champctl-championship reads one from a file —
    // so a blank track is a plausible typo. Left alone it emits Track: "",
    // which imports cleanly and then fails to load on race night.
    for (const track of ["", "   "]) {
      expect(() => emit({ spec: spec({ rounds: [{ track: "spa" }, { track }] }) })).toThrow(
        /Round 2 has no track/,
      )
    }
  })

  it("trims car models rather than emitting one with a space in it", () => {
    // A spec is usually hand-edited JSON, where " bmw_m3" is as easy to type as
    // "". Untrimmed it reaches RaceSetup.Cars and AvailableCars as a model ACSM
    // does not have — which fails on race night rather than here. The blank
    // check already refused the empty case; this is the same typo with a
    // character in it.
    const { championship: c } = emit({ spec: spec({ cars: [" bmw_m3 ", "ford_gt "] }) })
    expect(c.Classes?.[0]?.AvailableCars).toEqual(["bmw_m3", "ford_gt"])
    for (const ev of events(c)) expect(ev.RaceSetup?.Cars).toBe("bmw_m3;ford_gt")
  })

  it("trims a track and its layout, so the pit lookup and the summary agree", () => {
    const { championship: c, grid } = emit({
      spec: spec({ rounds: [{ track: " suzuka " }, { track: "spa " }] }),
    })
    expect(events(c).map((e) => e.RaceSetup?.Track)).toEqual(["suzuka", "spa"])
    // The label the summary prints, and the one the pit table was asked for.
    expect(grid.summary).not.toMatch(/ \)|\( /)
    expect(grid.maxClients).toBe(24) // suzuka's count was still found
  })

  it("refuses a multi-class template instead of dropping a class", () => {
    // A ChampionshipSpec describes one class and Classes is replaced wholesale, so a
    // two-class template lost the second class and its entrants with no error,
    // no warning and nothing in `derived` — the emitter's one silent data
    // loss. Modelling a single class is a deliberate limit; doing it quietly
    // is not.
    const t = template({
      Classes: [
        championshipClass({ Name: "GT3", AvailableCars: ["a"] }),
        championshipClass({ Name: "GT4", AvailableCars: ["b"] }),
      ],
    })
    expect(() => emit({ template: t })).toThrow(EmitError)
    expect(() => emit({ template: t })).toThrow(/GT3, GT4/)
    expect(() => emit({ template: t })).toThrow(/silently drop/)
  })

  it("refuses a blank car model, naming it, not just an empty car list", () => {
    // Same argument one field over. A list of blanks is as reachable from a
    // hand-edited spec as an empty one: ["", "bmw"] joins to ";bmw" for
    // RaceSetup.Cars and leaves "" in the class AvailableCars — a model nobody
    // can drive, in the field that decides what people may enter.
    expect(() => emit({ spec: spec({ cars: ["bmw", "   "] }) })).toThrow(/Car model 2 is blank/)
    expect(() => emit({ spec: spec({ cars: ["", ""] }) })).toThrow(/Car models 1, 2 are blank/)
    expect(() => emit({ spec: spec({ cars: ["", "bmw"] }) })).toThrow(EmitError)
  })

  it("uses the one ANY_CAR_MODEL, not a second copy of the string", () => {
    // Two copies of a sentinel are two things that can drift apart while every
    // test still passes. isAnyCarModel is what the rest of the tool asks.
    const { championship: c } = emit()
    for (const ev of events(c)) {
      for (const s of slots(ev.EntryList)) expect(isAnyCarModel(s.entrant)).toBe(true)
    }
    expect(ANY_CAR_MODEL).toBe(CANONICAL_ANY_CAR_MODEL)
  })

  it("applies the league baseline to every round's RaceSetup", () => {
    // gridmom checks RaceSetup against baseline.raceSetup, so an emitter that
    // skipped it would generate championships its own checker complains about — and
    // the deliberate EntryListType/PracticeEntryListType pair (§4.4) would
    // only be right when the template happened to agree.
    const { championship: c } = emitChampionship({
      template: template({
        Events: [raceEvent({ RaceSetup: { EntryListType: 0, PracticeEntryListType: 0 } })],
      }),
      spec: spec(),
      profile: testProfile(),
      pits,
      now: NOW,
    })
    for (const ev of events(c)) {
      expect(ev.RaceSetup?.EntryListType).toBe(1)
      expect(ev.RaceSetup?.PracticeEntryListType).toBe(2)
    }
  })

  it("lets the championship's own settings beat the baseline", () => {
    // The baseline is a *default*, so it must lose to anything actually asked
    // for — otherwise a league could never run a one-off different format.
    //
    // The baseline here deliberately mentions the same fields the format sets.
    // A baseline naming only fields the format ignores would let a
    // wrong-precedence implementation pass unnoticed.
    const profile = testProfile({
      baseline: {
        raceSetup: {
          EntryListType: 1,
          PracticeEntryListType: 2,
          RacePitWindowStart: 0,
          ReversedGridRacePositions: 0,
        },
        championship: {},
      },
    })
    const { championship: c } = emitChampionship({
      template: template(),
      spec: spec({
        format: {
          length: { kind: "laps", laps: 18 },
          reversedGridPositions: 9,
          mandatoryPit: true,
          extraLap: false,
        },
      }),
      profile,
      pits,
      now: NOW,
    })

    for (const ev of events(c)) {
      expect(ev.RaceSetup?.ReversedGridRacePositions).toBe(9)
      expect(ev.RaceSetup?.RacePitWindowStart).toBe(1)
      // ...while a baseline field the championship said nothing about still applies.
      expect(ev.RaceSetup?.EntryListType).toBe(1)
    }
  })

  it("keeps the root ID consistent with references to it", () => {
    // regenerateIds applies one old→new mapping across the whole graph, so a
    // field that referenced the championship's own ID still points at it.
    // Assigning a fresh out.ID afterwards would give the root one value and
    // every reference another.
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    const t = template({ ID: id }) as Championship & { SomeFutureAcsmField?: unknown }
    t.SomeFutureAcsmField = { ChampionshipID: id }

    const { championship: c } = emit({ template: t })
    const ref = (c as Record<string, unknown>)["SomeFutureAcsmField"] as {
      ChampionshipID: string
    }
    expect(c.ID).not.toBe(id)
    expect(ref.ChampionshipID).toBe(c.ID)
  })

  it("still gives a fresh ID when the template's wasn't a UUID", () => {
    // regenerateIds only rewrites UUID-shaped strings, so a non-UUID template
    // ID would otherwise survive and could collide on import.
    const { championship: c } = emit({ template: template({ ID: "champ-1" }) })
    expect(c.ID).not.toBe("champ-1")
    expect(c.ID).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("gives a fresh ID when the template's was the nil UUID", () => {
    // regenerateIds deliberately leaves the nil UUID alone, so counting it as
    // already-fresh would let every championship emitted from an all-zeroes template
    // keep it — and then collide with every other one.
    const { championship: c } = emit({
      template: template({ ID: "00000000-0000-0000-0000-000000000000" }),
    })
    expect(c.ID).not.toBe("00000000-0000-0000-0000-000000000000")
    expect(c.ID).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("keeps the template's class name rather than renaming it to a car model", () => {
    // A template is a real championship, so its class name is already the
    // label a league uses. Falling straight to cars[0] renamed "GT3" to a
    // model string, which reads like an id.
    const { championship: c } = emit({
      template: template({
        Classes: [championshipClass({ Name: "GT3", AvailableCars: ["old_car"] })],
      }),
    })
    expect(c.Classes?.[0]?.Name).toBe("GT3")
  })

  it("still prefers an explicit className, and falls back to a car last", () => {
    expect(
      emit({ spec: spec({ className: "Formula Hybrid" }) }).championship.Classes?.[0]?.Name,
    ).toBe("Formula Hybrid")

    const noClass = emitChampionship({
      template: template({ Classes: [] }),
      spec: spec(),
      profile: testProfile(),
      pits,
      now: NOW,
    })
    expect(noClass.championship.Classes?.[0]?.Name).toBe("rss_formula_hybrid_2021")
  })

  it("anchors a generated schedule to `now`, not to the wall clock", () => {
    // Without startDate the schedule used DateTime.now() while Created came
    // from `now`, so one championship could straddle two timeframes — and a
    // test could pin Created and still get a schedule that moved.
    // Omitted rather than set to undefined: exactOptionalPropertyTypes means
    // those are different things, and it's the absent case being tested.
    const { startDate: _omitted, ...noStartDate } = spec()
    const { schedule } = emitChampionship({
      template: template(),
      spec: noStartDate,
      profile: testProfile(),
      pits,
      now: new Date("2027-03-01T12:00:00-08:00"), // a Monday
    })

    // The profile races on Wednesday, so the first round is 2027-03-03.
    const first = DateTime.fromISO(schedule[0]?.qualiStart ?? "").setZone(ZONE)
    expect(first.toFormat("yyyy-MM-dd")).toBe("2027-03-03")
    expect(first.weekday).toBe(3)
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
    const { championship: c } = emitChampionship({
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
    // heard of survives into the emitted championship.
    const t = template() as Championship & { SomeFutureAcsmField?: unknown }
    t.SomeFutureAcsmField = { nested: true }
    const { championship: c } = emit({ template: t })
    expect((c as Record<string, unknown>)["SomeFutureAcsmField"]).toEqual({ nested: true })
  })

  describe("clone the previous championship", () => {
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

    it("does not carry the previous championship's dates", () => {
      // The one thing a clone definitely doesn't want: a "new" championship that has
      // already happened.
      const spec = specFromChampionship(lastMonth)
      expect(spec.rounds.every((r) => r.date === undefined)).toBe(true)
      expect(spec).not.toHaveProperty("startDate")
    })

    it("builds this championship from the previous championship", () => {
      const { championship: c, grid } = cloneChampionship({
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
      // And the clone goes through the same fixes as a fresh championship.
      expect(c.Created).toBe(NOW.toISOString())
      for (const ev of events(c)) expect(ev.RaceSetup?.Cars).toBe("car_a;car_b")
    })

    it("lets overrides replace the track list outright", () => {
      const { championship: c } = cloneChampionship({
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
        cloneChampionship({
          source: championship({ Name: "", Events: [raceEvent()] }),
          profile: testProfile(),
          now: NOW,
        }),
      ).toThrow(/needs a name/)
    })
  })
})
