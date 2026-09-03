import { describe, expect, it } from "vitest"

import type { Championship, Entrant } from "../src/acsm/types.js"
import type { Livery, LiveryPack } from "../src/liveries/pack.js"
import { LiveryPlanError, planLiveries, unreachableRounds } from "../src/liveries/plan.js"
import { championship, championshipClass, entryList, raceEvent } from "./support/build.js"

const CAR = "rss_formula_hybrid_2021"
const A = "11111111-1111-1111-1111-111111111111"
const NIL = "00000000-0000-0000-0000-000000000000"

const livery = (driverName: string, carModel = CAR): Livery => ({
  carModel,
  driverName,
  skinFolder: driverName,
  files: [{ name: "livery.dds", bytes: new Uint8Array([1]) }],
  totalBytes: 1,
})

const packOf = (...liveries: Livery[]): LiveryPack => ({
  liveries,
  totalBytes: liveries.reduce((a, l) => a + l.totalBytes, 0),
})

const person = (over: Partial<Entrant>): Partial<Entrant> => ({
  Model: CAR,
  Skin: "",
  ...over,
})

const champWith = (entrants: Partial<Entrant>[], over: Partial<Championship> = {}) =>
  championship({
    Name: "September 2026",
    Classes: [championshipClass({ Entrants: entryList(entrants) })],
    Events: [raceEvent({ EntryList: {} })],
    ...over,
  })

describe("planLiveries", () => {
  it("matches a driver and reports the skin it would replace", () => {
    const c = champWith([person({ Name: "Misha", Skin: "misha_old" })])
    const plan = planLiveries(c, "champ-1", packOf(livery("Misha")))

    expect(plan.assignments).toHaveLength(1)
    expect(plan.assignments[0]).toMatchObject({
      driverName: "Misha",
      carModel: CAR,
      skinFolder: "Misha",
      classIndex: 0,
      entrantIndex: 0,
      fromSkin: "misha_old",
      overriddenInRounds: [],
    })
    expect(plan.noop).toBe(false)
  })

  it("places an entrant at its CAR_n position, not its position in the pack", () => {
    // slots() sorts by the CAR_n key, which is the order the championship form
    // renders rows in. If these two orders disagree, a livery lands on the
    // wrong driver.
    const c = champWith([person({ Name: "Ann" }), person({ Name: "Bob" }), person({ Name: "Cal" })])
    const plan = planLiveries(c, "champ-1", packOf(livery("Cal"), livery("Ann")))
    expect(plan.assignments.map((a) => [a.driverName, a.entrantIndex])).toEqual([
      ["Cal", 2],
      ["Ann", 0],
    ])
  })

  it("finds a driver in the second class", () => {
    const c = championship({
      Classes: [
        championshipClass({ ID: "c1", Entrants: entryList([person({ Name: "Ann" })]) }),
        championshipClass({ ID: "c2", Entrants: entryList([person({ Name: "Bob" })]) }),
      ],
      Events: [raceEvent({ EntryList: {} })],
    })
    expect(planLiveries(c, "champ-1", packOf(livery("Bob"))).assignments[0]).toMatchObject({
      classIndex: 1,
      entrantIndex: 0,
    })
  })

  it("separates a livery that changes nothing from one that does", () => {
    const c = champWith([
      person({ Name: "Misha", Skin: "Misha" }),
      person({ Name: "postaL", Skin: "old" }),
    ])
    const plan = planLiveries(c, "champ-1", packOf(livery("Misha"), livery("postaL")))
    expect(plan.assignments.map((a) => a.driverName)).toEqual(["postaL"])
    expect(plan.unchanged.map((a) => a.driverName)).toEqual(["Misha"])
    expect(plan.noop).toBe(false)
  })

  it("is a no-op when every livery is already assigned", () => {
    // Re-running after a successful drop must not post the championship form
    // again. That POST replaces the whole championship, so a pointless one is
    // not free.
    const c = champWith([person({ Name: "Misha", Skin: "Misha" })])
    expect(planLiveries(c, "champ-1", packOf(livery("Misha"))).noop).toBe(true)
  })

  it("reports rounds that already have results", () => {
    const c = champWith([person({ Name: "Misha" })], {
      Events: [
        raceEvent({
          EntryList: {},
          StartedTime: "2026-09-02T20:00:00Z",
          CompletedTime: "2026-09-02T21:00:00Z",
          Sessions: { RACE: { Name: "Race", Results: { Type: "RACE" } } },
        }),
        raceEvent({ EntryList: {} }),
      ],
    })
    expect(planLiveries(c, "champ-1", packOf(livery("Misha"))).racedRounds).toEqual([1])
  })

  it("does not call a round raced because its practice server is running", () => {
    // This is what a live looping practice looks like in the export, and it is
    // what the check used to report as "already been raced". ACSM stamps
    // StartedTime from the UDP new-session callback, and a practice is a
    // session — so an untouched round somebody opened practice on looked raced.
    const c = champWith([person({ Name: "Misha" })], {
      Events: [
        raceEvent({
          EntryList: {},
          StartedTime: "2026-09-02T19:00:00Z",
          CompletedTime: "0001-01-01T00:00:00Z",
          Sessions: {
            PRACTICE: {
              Name: "Practice",
              StartedTime: "2026-09-02T19:00:00Z",
              CompletedTime: "0001-01-01T00:00:00Z",
              Results: null,
            },
          },
        }),
      ],
    })
    expect(planLiveries(c, "champ-1", packOf(livery("Misha"))).racedRounds).toEqual([])
  })

  it("counts a finished session with results even when the event is not complete", () => {
    // A two-race night part way through: qualifying is in the book, the event
    // is not over, and those cars did run in their old liveries.
    const c = champWith([person({ Name: "Misha" })], {
      Events: [
        raceEvent({
          EntryList: {},
          StartedTime: "2026-09-02T19:00:00Z",
          CompletedTime: "0001-01-01T00:00:00Z",
          Sessions: {
            QUALIFY: {
              Name: "Qualifying",
              CompletedTime: "2026-09-02T20:20:00Z",
              Results: { Type: "QUALIFY" },
            },
          },
        }),
      ],
    })
    expect(planLiveries(c, "champ-1", packOf(livery("Misha"))).racedRounds).toEqual([1])
  })
})

describe("planLiveries refusals", () => {
  it("refuses a driver who is not in the entry list", () => {
    const c = champWith([person({ Name: "Misha" })])
    expect(() => planLiveries(c, "champ-1", packOf(livery("Nobody")))).toThrowError(LiveryPlanError)
    expect(() => planLiveries(c, "champ-1", packOf(livery("Nobody")))).toThrowError(
      /No entrant called "Nobody"/,
    )
  })

  it("matches a name whose accents are encoded differently on each side", () => {
    // The case that actually strands a driver: a zip made on a Mac carries the
    // decomposed form, ACSM holds the precomposed one, and both print
    // "Ricky Häkkinen". Escapes rather than literals, or the two sides of this
    // test would be the same source text and it would prove nothing.
    const decomposed = "Ricky Ha\u0308kkinen"
    const precomposed = "Ricky H\u00e4kkinen"
    expect(decomposed).not.toBe(precomposed)

    const c = champWith([person({ Name: precomposed, Skin: "old" })])
    const plan = planLiveries(c, "champ-1", packOf(livery(decomposed)))
    expect(plan.assignments).toHaveLength(1)
    expect(plan.assignments[0]?.fromSkin).toBe("old")
  })

  it("still misses on case, which is the rule working as chosen", () => {
    // Normalising encodings is not the same as folding case. A driver called
    // "postaL" is not "POSTAL", and guessing there puts one driver in another's
    // livery.
    const c = champWith([person({ Name: "postaL" })])
    expect(() => planLiveries(c, "champ-1", packOf(livery("POSTAL")))).toThrowError(
      /No entrant called/,
    )
  })

  it("points at a name that differs only in case or spacing", () => {
    // The near-miss that actually happens. Named, not auto-corrected: accepting
    // a suggestion here puts a driver in another driver's livery.
    const c = champWith([person({ Name: "postaL" })])
    expect(() => planLiveries(c, "champ-1", packOf(livery("PostaL")))).toThrowError(
      /has "postaL", which differs only in case or spacing/,
    )
  })

  it("says so when nothing is close either", () => {
    const c = champWith([person({ Name: "Misha" })])
    expect(() => planLiveries(c, "champ-1", packOf(livery("Nobody")))).toThrowError(
      /No entrant name is close to it either/,
    )
  })

  it("refuses when the same name is in the entry list twice", () => {
    const c = champWith([person({ Name: "Misha" }), person({ Name: "Misha" })])
    expect(() => planLiveries(c, "champ-1", packOf(livery("Misha")))).toThrowError(
      /appears 2 times in the entry list/,
    )
  })

  it("refuses a livery filed under a car the driver doesn't drive", () => {
    // The upload goes to /car/{model}/skin, so this would put the skin on a car
    // nobody in this championship races and then assign a folder that isn't
    // there.
    const c = champWith([person({ Name: "Misha", Model: CAR })])
    expect(() => planLiveries(c, "champ-1", packOf(livery("Misha", "ford_transit")))).toThrowError(
      /entered in rss_formula_hybrid_2021, but the livery is filed under ford_transit/,
    )
  })

  it("refuses rather than assigning the liveries it could match", () => {
    // All or nothing. A half-applied drop is worse to unpick than one that
    // didn't happen.
    const c = champWith([person({ Name: "Misha" })])
    expect(() =>
      planLiveries(c, "champ-1", packOf(livery("Misha"), livery("Nobody"))),
    ).toThrowError(LiveryPlanError)
  })
})

describe("whether a championship-level write reaches the races", () => {
  /** A round whose own entry list holds this entrant, joined by InternalUUID. */
  const roundWith = (uuid: string, model = CAR) =>
    raceEvent({
      EntryList: entryList([person({ Name: "Misha", InternalUUID: uuid, Model: model })]),
    })

  it("reaches every round when the class entrants have no UUID", () => {
    // What BATL's manager measured. CombineEntryLists guards on
    // `entrant.InternalUUID != uuid.Nil`, so nothing overrides and the class
    // skin is what races.
    const c = champWith([person({ Name: "Misha", InternalUUID: NIL })], {
      Events: [roundWith(NIL), roundWith(NIL)],
    })
    const plan = planLiveries(c, "champ-1", packOf(livery("Misha")))
    expect(plan.assignments[0]?.overriddenInRounds).toEqual([])
    expect(unreachableRounds(plan)).toEqual([])
  })

  it("names the rounds that would override a real UUID", () => {
    // The other world. The write lands in the database and the race still runs
    // the old livery, which is the failure nobody would notice until race night.
    const c = champWith([person({ Name: "Misha", InternalUUID: A })], {
      Events: [roundWith(A), raceEvent({ EntryList: {} }), roundWith(A)],
    })
    const plan = planLiveries(c, "champ-1", packOf(livery("Misha")))
    expect(plan.assignments[0]?.overriddenInRounds).toEqual([1, 3])
    expect(unreachableRounds(plan)).toEqual([1, 3])
  })

  it("does not count a round whose entry list is empty", () => {
    // CombineEntryLists returns the class list unchanged for those.
    const c = champWith([person({ Name: "Misha", InternalUUID: A })], {
      Events: [raceEvent({ EntryList: {} })],
    })
    expect(unreachableRounds(planLiveries(c, "champ-1", packOf(livery("Misha"))))).toEqual([])
  })

  it("does not count a round where the model differs", () => {
    // ACSM's condition is UUID *and* Model. Either half failing means no
    // override, and treating the UUID alone as the join would report a round as
    // unreachable when it isn't.
    const c = champWith([person({ Name: "Misha", InternalUUID: A, Model: CAR })], {
      Events: [roundWith(A, "ford_transit")],
    })
    expect(unreachableRounds(planLiveries(c, "champ-1", packOf(livery("Misha"))))).toEqual([])
  })

  it("treats an empty UUID the same as the nil one", () => {
    const c = champWith([person({ Name: "Misha", InternalUUID: "" })], {
      Events: [roundWith("")],
    })
    expect(unreachableRounds(planLiveries(c, "champ-1", packOf(livery("Misha"))))).toEqual([])
  })
})
