import { describe, expect, it } from "vitest"

import { check } from "../src/gridmom/index.js"
import { entryChecks } from "../src/gridmom/checks/entry.js"
import {
  NOW,
  championship,
  championshipClass,
  driver,
  emptySlots,
  entryList,
  pitTable,
  raceEvent,
  suzukaPits,
  testProfile,
} from "./support/build.js"

const run = (c: Parameters<typeof check>[0], pits = pitTable([suzukaPits])) =>
  check(c, testProfile(), { pits, now: NOW, checks: entryChecks })

const codes = (c: Parameters<typeof check>[0], pits?: ReturnType<typeof pitTable>) =>
  run(c, pits).findings.map((f) => f.code)

describe("duplicate pit boxes", () => {
  it("is quiet when every box is distinct", () => {
    expect(codes(championship())).not.toContain("entry.duplicate-pit-box")
  })

  it("reproduces the real Suzuka bug: duplicates at 3, 16 and 27", () => {
    // The live championship has 30 slots with 3, 16 and 27 doubled up and gaps
    // at 10, 19 and 22 (plan §3.2). Rebuild exactly that shape.
    const boxes: number[] = []
    for (let i = 0; i < 30; i++) {
      if (i === 10 || i === 19 || i === 22) continue
      boxes.push(i)
    }
    boxes.push(3, 16, 27)

    const c = championship({
      Events: [
        raceEvent({
          EntryList: entryList(boxes.map((box, i) => ({ ...driver(`d${i}`), PitBox: box }))),
        }),
      ],
      Classes: [championshipClass({ Entrants: entryList(emptySlots(4)) })],
    })

    const report = run(c)
    const finding = report.findings.find((f) => f.code === "entry.duplicate-pit-box")

    expect(finding).toBeDefined()
    expect(finding!.severity).toBe("ERROR")
    expect(finding!.message).toContain("duplicate pit boxes at 3, 16 and 27")
    // gridmom should name the gaps, since that is the actual fix.
    expect(finding!.message).toContain("gaps at 10, 19 and 22")
    // ...and the stakes: AddInPitBox overwrites, so a save deletes the losers.
    expect(finding!.message).toContain("Saving this event will drop 3 drivers")
    expect(finding!.data).toMatchObject({ pitBoxes: [3, 16, 27], entrantsAtRisk: 3 })
    expect(report.ok).toBe(false)
  })

  it("reports the class list separately from the event list", () => {
    const c = championship({
      Classes: [
        championshipClass({
          Entrants: entryList([
            { ...driver("a"), PitBox: 9 },
            { ...driver("b"), PitBox: 9 },
            { ...driver("c"), PitBox: 10 },
            { ...driver("d"), PitBox: 10 },
          ]),
        }),
      ],
    })
    const found = run(c).findings.filter((f) => f.code === "entry.duplicate-pit-box")
    expect(found).toHaveLength(1)
    expect(found[0]!.message).toContain("duplicate pit boxes at 9 and 10")
    // A class list is saved from the championship form, not an event form.
    expect(found[0]!.message).toContain("Saving the championship will drop 2 drivers")
    expect(found[0]!.location?.className).toBe("RSS Formula Hybrid")
  })
})

describe("grid capacity", () => {
  it("errors when MaxClients exceeds the track's pit boxes", () => {
    const c = championship({
      Events: [raceEvent({ RaceSetup: { MaxClients: 40 } })],
    })
    const f = run(c).findings.find((x) => x.code === "grid.max-clients")
    expect(f?.severity).toBe("ERROR")
    expect(f?.message).toContain("only has 30 pit boxes")
  })

  /**
   * The spectator car is not counted, and used to be.
   *
   * Plan §4.5 had the cap as `pitboxes - spectatorCars`, on the reading that a
   * car on the grid needs a box. The league that runs one says it occupies
   * nothing — it is an observer, and their pits have clipping off — so
   * counting it fired this a car early and made the emitter cap every
   * championship a car below what the track allows.
   */
  it("does not count the spectator car against capacity", () => {
    const c = championship({
      SpectatorCarEnabled: true,
      SpectatorCar: { Model: "ford_transit", PitBox: 29, Name: "Spectator" },
      Events: [raceEvent({ RaceSetup: { MaxClients: 30 } })],
    })
    expect(codes(c)).not.toContain("grid.max-clients")
  })

  it("still errors on a grid that genuinely will not fit", () => {
    const c = championship({
      SpectatorCarEnabled: true,
      SpectatorCar: { Model: "ford_transit", PitBox: 29, Name: "Spectator" },
      Events: [raceEvent({ RaceSetup: { MaxClients: 31 } })],
    })
    expect(codes(c)).toContain("grid.max-clients")
  })

  it("stays silent when the pit count is unknown", () => {
    const c = championship({ Events: [raceEvent({ RaceSetup: { MaxClients: 999 } })] })
    expect(codes(c, pitTable())).not.toContain("grid.max-clients")
  })

  it("errors when an entrant sits beyond the last pit box on an event that ran", () => {
    const c = championship({
      Events: [
        raceEvent({
          StartedTime: "2026-08-12T19:00:00-07:00",
          EntryList: entryList([{ ...driver("late"), PitBox: 30 }]),
        }),
      ],
    })
    const f = run(c).findings.find((x) => x.code === "entry.pit-box-out-of-range")
    expect(f?.severity).toBe("ERROR")
    expect(f?.message).toContain("stops at 29")
  })

  it("only warns while the event hasn't run", () => {
    // An entry list deliberately holds more places than the smallest track has
    // pit boxes (plan §4.4) — 30 slots against an 18-car grid, because sizing
    // the championship to its tightest night locks people out of every other
    // one, and MaxClients is what caps a given race. As an ERROR this made the
    // emitter produce championships that gridmom then refused to import: two
    // modules disagreeing about the same file.
    const c = championship({
      Events: [
        raceEvent({
          EntryList: entryList([{ ...driver("late"), PitBox: 30 }]),
        }),
      ],
    })
    const report = run(c)
    const f = report.findings.find((x) => x.code === "entry.pit-box-out-of-range")
    expect(f?.severity).toBe("WARN")
    expect(f?.message).toContain("stops at 29")
    expect(f?.message).toContain("larger than the grid is normal")
    // And it no longer blocks a push.
    expect(report.counts.ERROR).toBe(0)
  })
})

describe("spectator car", () => {
  /**
   * There is no `entry.spectator-pit-box` check any more, and this is what
   * used to fail.
   *
   * It reported an ERROR whenever the spectator car's box matched an
   * entrant's. The league that runs one says it occupies no box at all — an
   * observer, with pit clipping off besides — so on their July championship it
   * fired for every event and the class list, named a real driver each time,
   * and blocked every push over something that has never gone wrong.
   */
  it("does not report sharing a pit box with an entrant", () => {
    const c = championship({
      SpectatorCarEnabled: true,
      SpectatorCar: { Model: "ford_transit", PitBox: 2, Name: "Spectator" },
      Events: [
        raceEvent({
          EntryList: entryList([driver("a"), driver("b"), driver("clash")]),
        }),
      ],
    })
    expect(codes(c)).not.toContain("entry.spectator-pit-box")
    // And nothing else took up the complaint: sharing a box is simply fine.
    expect(run(c).findings.filter((f) => f.severity === "ERROR")).toEqual([])
  })
})

describe("car models", () => {
  it("errors on a model the class doesn't allow", () => {
    const c = championship({
      Classes: [
        championshipClass({
          Entrants: entryList([driver("wrong", { Model: "ks_mazda_miata" })]),
        }),
      ],
      Events: [raceEvent({ EntryList: entryList(emptySlots(4)) })],
    })
    const f = run(c).findings.find((x) => x.code === "entry.model-not-available")
    expect(f?.severity).toBe("ERROR")
    expect(f?.message).toContain("ks_mazda_miata")
  })

  it("allows the any_car_model sentinel", () => {
    const c = championship({
      Classes: [championshipClass({ Entrants: entryList(emptySlots(4)) })],
    })
    expect(codes(c)).not.toContain("entry.model-not-available")
  })

  it("ignores the spectator car's model", () => {
    const c = championship({
      SpectatorCarEnabled: true,
      SpectatorCar: { Model: "ford_transit", PitBox: 29 },
      Classes: [
        championshipClass({
          Entrants: entryList([driver("spec", { Model: "ford_transit" })]),
        }),
      ],
    })
    expect(codes(c)).not.toContain("entry.model-not-available")
  })
})

describe("RaceSetup.Cars", () => {
  it("catches a model left in the car list that the class can't drive", () => {
    // The bug the import test exposed (plan §5.5), with a model the profile
    // has not excluded. `ford_transit` no longer serves here: BATL declares it
    // in `excludedCarModels`, so it is forgiven by design — see below.
    const c = championship({
      SpectatorCarEnabled: false,
      Events: [raceEvent({ RaceSetup: { Cars: "rss_formula_hybrid_2021;ks_mazda_miata" } })],
    })
    const f = run(c).findings.find((x) => x.code === "grid.race-setup-cars")
    expect(f?.severity).toBe("WARN")
    expect(f?.message).toContain("ks_mazda_miata")
  })

  it("accepts the spectator model when the spectator car is on", () => {
    const c = championship({
      SpectatorCarEnabled: true,
      SpectatorCar: { Model: "ford_transit", PitBox: 29 },
      Events: [raceEvent({ RaceSetup: { Cars: "rss_formula_hybrid_2021;ford_transit" } })],
    })
    expect(codes(c)).not.toContain("grid.race-setup-cars")
  })

  /**
   * `excludedCarModels` is league furniture, and it applies here too.
   *
   * It always did in `entry.model-not-available` and never did in this check,
   * so BATL — who run a Ford Transit in every race for the stream, and whose
   * `SpectatorCar.Model` is `""` so the branch above forgives nothing — got the
   * same van reported once per round, on every championship, for ever.
   *
   * The trade is deliberate: a league that names a model here is saying "this
   * is ours, stop telling me about it", so champctl stops, including in the
   * case §5.5 was about. Any *other* stray model is still caught.
   */
  it("forgives an excluded model however the spectator car is set", () => {
    for (const enabled of [true, false]) {
      const c = championship({
        SpectatorCarEnabled: enabled,
        Events: [raceEvent({ RaceSetup: { Cars: "rss_formula_hybrid_2021;ford_transit" } })],
      })
      expect(codes(c)).not.toContain("grid.race-setup-cars")
    }
  })

  it("does not turn an excluded model into a missing one", () => {
    // Forgiven in one direction only. Folding the exclusions into the expected
    // set would swap "still lists ford_transit" for "is missing ford_transit"
    // on every championship that doesn't run one.
    const c = championship({
      SpectatorCarEnabled: false,
      Events: [raceEvent({ RaceSetup: { Cars: "rss_formula_hybrid_2021" } })],
    })
    expect(codes(c)).not.toContain("grid.race-setup-cars")
  })
})

describe("the spectator car's model", () => {
  /**
   * Found on a live BATL championship: switched on, model `""`.
   *
   * It is also why `grid.race-setup-cars` had nothing to forgive the Transit
   * with — every check that reasons about "the spectator model" was reasoning
   * about an empty string.
   */
  it("warns when the spectator car is on with no model", () => {
    const c = championship({ SpectatorCarEnabled: true, SpectatorCar: { Model: "" } })
    const f = run(c).findings.find((x) => x.code === "entry.spectator-no-model")
    expect(f?.severity).toBe("WARN")
    expect(f?.message).toContain("no car model set")
  })

  /**
   * The shape every 2.4.x export has, and the one this check got wrong.
   *
   * ACSM keeps the real car in `SpectatorCars[0]` and leaves the singular
   * `SpectatorCar` blank. Reading the singular field made this fire on a
   * championship whose spectator car was configured perfectly — measured
   * against a live BATL championship that had been running for months.
   */
  it("reads the model out of SpectatorCars, where 2.4.x keeps it", () => {
    const c = championship({
      SpectatorCarEnabled: true,
      SpectatorCar: { Model: "" },
      SpectatorCars: [{ Model: "ford_transit", Name: "BATL TV", PitBox: 30 }],
    })
    expect(codes(c)).not.toContain("entry.spectator-no-model")
  })

  it("still warns when neither field carries a model", () => {
    const c = championship({
      SpectatorCarEnabled: true,
      SpectatorCar: { Model: "" },
      SpectatorCars: [{ Model: "", PitBox: 30 }],
    })
    expect(codes(c)).toContain("entry.spectator-no-model")
  })

  it("says nothing when the spectator car is off", () => {
    const c = championship({ SpectatorCarEnabled: false, SpectatorCar: { Model: "" } })
    expect(codes(c)).not.toContain("entry.spectator-no-model")
  })

  it("says nothing when it has a model", () => {
    const c = championship({
      SpectatorCarEnabled: true,
      SpectatorCar: { Model: "ford_transit" },
    })
    expect(codes(c)).not.toContain("entry.spectator-no-model")
  })
})

/**
 * Where the stream car parks.
 *
 * `CAR_n` is pit box n, so a spectator car below the list's length is sharing
 * a box with a slot, and `AddInPitBox` overwrites on collision. Found on a
 * live championship at box 0, cloned from one where it sat at 29.
 */
describe("the spectator car's pit box", () => {
  const withBox = (box: number, slotCount = 4) =>
    championship({
      SpectatorCarEnabled: true,
      SpectatorCars: [{ Model: "ford_transit", Name: "BATL TV", PitBox: box }],
      Classes: [championshipClass({ Entrants: entryList(emptySlots(slotCount)) })],
      Events: [raceEvent({ EntryList: entryList(emptySlots(slotCount)) })],
    })

  it("warns when it sits in a slot an entrant can hold", () => {
    const f = run(withBox(0)).findings.find((x) => x.code === "entry.spectator-pit-box-taken")
    expect(f?.severity).toBe("WARN")
    expect(f?.message).toContain("pit box 0")
    // The fix, named: past the end of the list.
    expect(f?.message).toContain("park it at 4")
    expect(f?.data).toMatchObject({ pitBox: 0, slots: 4, suggested: 4 })
  })

  it("is quiet when it is parked past the last slot", () => {
    expect(codes(withBox(4))).not.toContain("entry.spectator-pit-box-taken")
    expect(codes(withBox(9))).not.toContain("entry.spectator-pit-box-taken")
  })

  it("catches the last slot itself, which is a real box", () => {
    // Off-by-one guard: 4 slots are boxes 0..3, so box 3 is taken and 4 is free.
    expect(codes(withBox(3))).toContain("entry.spectator-pit-box-taken")
  })

  it("says nothing when the spectator car is off", () => {
    const c = withBox(0)
    c.SpectatorCarEnabled = false
    expect(codes(c)).not.toContain("entry.spectator-pit-box-taken")
  })
})

describe("cross-list comparison", () => {
  it("warns when an event entry list drops a championship entrant", () => {
    const alice = driver("alice")
    const bob = driver("bob")
    const c = championship({
      Classes: [championshipClass({ Entrants: entryList([alice, bob]) })],
      Events: [raceEvent({ EntryList: entryList([alice]) })],
    })
    const f = run(c).findings.find((x) => x.code === "entry.event-differs-from-class")
    expect(f?.severity).toBe("WARN")
    expect(f?.message).toContain("bob")
    // And what to do about it, because champctl cannot: `postForm` strips
    // `EntryList.OverwriteAllEvents`, so no champctl save ever propagates the
    // class list to an event.
    expect(f?.message).toContain("Server Manager")
  })

  /**
   * Every claimed entrant missing, which is a different fact.
   *
   * The shape a freshly created championship is in before anyone has been
   * through the events: the class list has people, every event list is
   * unclaimed slots. Reported per-name it reads as one driver's problem —
   * "misha is in the championship but not in this event" — when what it means
   * is that the round has nobody in it at all.
   */
  it("says an event list is empty rather than naming everyone in it", () => {
    const c = championship({
      Classes: [championshipClass({ Entrants: entryList([driver("alice"), driver("bob")]) })],
      Events: [raceEvent({ EntryList: entryList(emptySlots(30)) })],
    })
    const f = run(c).findings.find((x) => x.code === "entry.event-differs-from-class")
    expect(f?.severity).toBe("WARN")
    expect(f?.message).toContain("Nobody is in")
    expect(f?.message).toContain("2 drivers")
    expect(f?.message).toContain("Server Manager")
    expect(f?.data).toMatchObject({ empty: true })
  })

  /**
   * A name with no GUID is a person, and the finding used to say otherwise.
   *
   * ACSM lets an entrant be added by name alone — no Steam GUID until they
   * first connect — and `claimedSlots` counts those, correctly. Counting GUIDs
   * instead reported a round with people in it as "Nobody is in this entry
   * list", and told whoever read it to go and populate a list that already had
   * somebody in it.
   */
  it("does not call a list of unregistered drivers empty", () => {
    const c = championship({
      Classes: [championshipClass({ Entrants: entryList([driver("alice"), driver("bob")]) })],
      Events: [raceEvent({ EntryList: entryList([driver("carol", { GUID: "" })]) })],
    })
    const f = run(c).findings.find((x) => x.code === "entry.event-differs-from-class")
    expect(f?.message).not.toContain("Nobody is in")
    expect(f?.data).toMatchObject({ empty: false })
  })

  it("does not call a partly-populated list empty", () => {
    const alice = driver("alice")
    const c = championship({
      Classes: [championshipClass({ Entrants: entryList([alice, driver("bob")]) })],
      Events: [raceEvent({ EntryList: entryList([alice]) })],
    })
    const f = run(c).findings.find((x) => x.code === "entry.event-differs-from-class")
    expect(f?.message).not.toContain("Nobody is in")
    expect(f?.data).toMatchObject({ empty: false })
  })

  it("warns when events disagree on how many slots exist", () => {
    const c = championship({
      Events: [
        raceEvent({ EntryList: entryList(emptySlots(30)) }),
        raceEvent({ EntryList: entryList(emptySlots(24)) }),
      ],
    })
    const f = run(c).findings.find((x) => x.code === "entry.length-varies")
    expect(f?.message).toMatch(/30.*24|24.*30/)
  })
})

describe("skins", () => {
  /**
   * A league that has said it enforces unique skins, and only that league.
   *
   * `testProfile()` does not set `uniqueSkins`, so `run` finds nothing — which
   * is the case that matters most and is checked below.
   */
  const strict = (c: Parameters<typeof check>[0]) =>
    check(c, testProfile({ entryList: { targetSlots: 30, uniqueSkins: true } }), {
      pits: pitTable([suzukaPits]),
      now: NOW,
      checks: entryChecks,
    })

  const twoInOneSkin = () =>
    championship({
      Events: [
        raceEvent({
          EntryList: entryList([
            driver("alice", { Skin: "red_07" }),
            driver("bob", { Skin: "red_07" }),
          ]),
        }),
      ],
      Classes: [championshipClass({ Entrants: entryList(emptySlots(2)) })],
    })

  /**
   * The default, and the whole point of the change.
   *
   * This used to key off ACSM's `AllowDuplicateSkinChoices`, which is `false`
   * in every export anyone has looked at — Go's zero value for a field nobody
   * sets, not a league declaring a rule. Reading it as one turned a BATL
   * championship into 27 ERRORs, blocked every push, and buried the two
   * findings that were real. Most leagues share skins because not everyone has
   * one of their own.
   */
  it("says nothing unless the league asked", () => {
    expect(codes(twoInOneSkin())).not.toContain("entry.duplicate-skin")
  })

  it("does not read ACSM's AllowDuplicateSkinChoices as a league rule", () => {
    // Explicitly `false`, as every real export carries it. Still silent.
    const c = championship({
      Events: [
        raceEvent({
          RaceSetup: { AllowDuplicateSkinChoices: false },
          EntryList: entryList([
            driver("alice", { Skin: "red_07" }),
            driver("bob", { Skin: "red_07" }),
          ]),
        }),
      ],
      Classes: [championshipClass({ Entrants: entryList(emptySlots(2)) })],
    })
    expect(codes(c)).not.toContain("entry.duplicate-skin")
  })

  it("warns, not errors, for a league that does mind", () => {
    // WARN because two identical cars is confusing on a broadcast, not a
    // broken or unfair race — and an ERROR would block the push.
    const f = strict(twoInOneSkin()).findings.find((x) => x.code === "entry.duplicate-skin")
    expect(f?.severity).toBe("WARN")
    expect(f?.message).toContain("red_07")
  })

  it("allows the same skin name on different models", () => {
    // Skins are per-model folders, so `car_a/red_07` and `car_b/red_07` are
    // two different skins that happen to share a name.
    const c = championship({
      Classes: [
        championshipClass({
          AvailableCars: ["car_a", "car_b"],
          Entrants: entryList(emptySlots(2)),
        }),
      ],
      Events: [
        raceEvent({
          EntryList: entryList([
            driver("alice", { Model: "car_a", Skin: "red_07" }),
            driver("bob", { Model: "car_b", Skin: "red_07" }),
          ]),
        }),
      ],
    })
    expect(strict(c).findings.map((f) => f.code)).not.toContain("entry.duplicate-skin")
  })
})

describe("sign-ups", () => {
  const accepted = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      Name: `applicant${i}`,
      GUID: `guid-${i}`,
      Status: "Accepted" as const,
    }))

  it("warns when accepted sign-ups outnumber the slots", () => {
    const c = championship({
      SignUpForm: { Enabled: true, Responses: accepted(6) },
      Classes: [championshipClass({ Entrants: entryList(emptySlots(4)) })],
      Events: [raceEvent({ EntryList: entryList(emptySlots(4)) })],
    })
    const f = run(c).findings.find((x) => x.code === "signup.exceeds-slots")
    expect(f?.severity).toBe("WARN")
    expect(f?.message).toContain("6 sign-ups")
  })

  it("warns when an accepted driver has no slot in a locked race", () => {
    const c = championship({
      SignUpForm: {
        Enabled: true,
        Responses: [{ Name: "stranded", GUID: "guid-x", Status: "Accepted" }],
      },
      Events: [raceEvent({ EntryList: entryList(emptySlots(10)) })],
      Classes: [championshipClass({ Entrants: entryList(emptySlots(10)) })],
    })
    const f = run(c).findings.find((x) => x.code === "signup.no-slot")
    expect(f?.message).toContain("stranded")
    expect(f?.message).toContain("can't join the race")
  })

  it("ignores rejected sign-ups", () => {
    const c = championship({
      SignUpForm: {
        Enabled: true,
        Responses: [{ Name: "nope", GUID: "guid-x", Status: "Rejected" }],
      },
      Events: [raceEvent({ EntryList: entryList(emptySlots(10)) })],
      Classes: [championshipClass({ Entrants: entryList(emptySlots(10)) })],
    })
    expect(codes(c)).not.toContain("signup.no-slot")
  })

  /**
   * The locked flag is a championship field, not an event one.
   *
   * This check gated on `ev.RaceSetup.EntryListType`, which no real export
   * carries, so `undefined === 1` was false on every championship anyone has
   * ever run it against and the check could not fire at all. It passed its
   * tests because `raceEvent` put the field where the code looked rather than
   * where ACSM keeps it. Both of these read the championship now.
   */
  it("reads the locked flag off the championship, not the event", () => {
    const c = championship({
      EntryListType: 1,
      SignUpForm: {
        Enabled: true,
        Responses: [{ Name: "stranded", GUID: "guid-x", Status: "Accepted" }],
      },
      // RaceSetup deliberately says nothing about it, which is the shape every
      // real export has.
      Events: [raceEvent({ EntryList: entryList(emptySlots(10)) })],
      Classes: [championshipClass({ Entrants: entryList(emptySlots(10)) })],
    })
    expect(codes(c)).toContain("signup.no-slot")
  })

  it("says nothing when the race list is unlocked", () => {
    // Anyone can take any free slot, so an accepted driver without one of
    // their own is not shut out of anything.
    const c = championship({
      EntryListType: 0,
      SignUpForm: {
        Enabled: true,
        Responses: [{ Name: "stranded", GUID: "guid-x", Status: "Accepted" }],
      },
      Events: [raceEvent({ EntryList: entryList(emptySlots(10)) })],
      Classes: [championshipClass({ Entrants: entryList(emptySlots(10)) })],
    })
    expect(codes(c)).not.toContain("signup.no-slot")
  })
})

describe("race numbers", () => {
  const withPattern = (pattern: string | undefined, skins: string[]) => {
    const profile = testProfile()
    if (pattern) profile.entryList.raceNumberFromSkin = pattern
    const c = championship({
      Classes: [championshipClass({ Entrants: entryList(emptySlots(2)) })],
      Events: [
        raceEvent({
          EntryList: entryList(skins.map((skin, i) => driver(`d${i}`, { Skin: skin }))),
        }),
      ],
    })
    return check(c, profile, { pits: pitTable([suzukaPits]), now: NOW, checks: entryChecks })
  }

  it("doesn't run without a league pattern", () => {
    // ACSM has no race number field, so guessing finds a duplicate every time.
    const codes = withPattern(undefined, ["batl_07", "batl_07"]).findings.map((f) => f.code)
    expect(codes).not.toContain("entry.duplicate-race-number")
  })

  it("finds real duplicates when the league says how to read them", () => {
    const f = withPattern("_(\\d{1,3})$", ["batl_07", "other_07", "batl_12"]).findings.find(
      (x) => x.code === "entry.duplicate-race-number",
    )
    expect(f?.severity).toBe("WARN")
    expect(f?.message).toContain("race number 7")
  })

  it("treats 07 and 7 as the same number", () => {
    const codes = withPattern("_(\\d{1,3})$", ["batl_07", "other_7"]).findings.map((f) => f.code)
    expect(codes).toContain("entry.duplicate-race-number")
  })

  it("ignores a non-numeric capture rather than calling everyone NaN", () => {
    // String(Number("red")) is "NaN", and every entrant matching would collapse
    // into one bogus duplicate group.
    const codes = withPattern("_(\\w+)$", ["batl_red", "other_blue", "third_green"]).findings.map(
      (f) => f.code,
    )
    expect(codes).not.toContain("entry.duplicate-race-number")
  })

  it("still finds duplicates among the numeric ones when others don't parse", () => {
    const f = withPattern("_(\\w+)$", ["batl_red", "other_9", "third_9"]).findings.find(
      (x) => x.code === "entry.duplicate-race-number",
    )
    expect(f?.message).toContain("race number 9")
  })

  it("warns rather than crashing on an invalid pattern", () => {
    const f = withPattern("_(\\d{1,3}$", ["batl_07"]).findings.find(
      (x) => x.code === "entry.race-number-pattern",
    )
    expect(f?.severity).toBe("WARN")
  })
})

describe("unclaimed slots in a multi-model class", () => {
  it("warns when an empty slot is pinned to a specific model", () => {
    const c = championship({
      Classes: [
        championshipClass({
          AvailableCars: ["car_a", "car_b"],
          Entrants: entryList([{ Model: "car_a" }, { Model: "any_car_model" }]),
        }),
      ],
      Events: [raceEvent({ EntryList: entryList(emptySlots(2)) })],
    })
    const f = run(c).findings.find((x) => x.code === "entry.unclaimed-not-sentinel")
    expect(f?.severity).toBe("WARN")
    expect(f?.message).toContain("any_car_model")
  })

  it("doesn't apply to a single-model class", () => {
    const c = championship({
      Classes: [
        championshipClass({
          AvailableCars: ["car_a"],
          Entrants: entryList([{ Model: "car_a" }]),
        }),
      ],
      Events: [raceEvent({ EntryList: entryList(emptySlots(2)) })],
    })
    expect(codes(c)).not.toContain("entry.unclaimed-not-sentinel")
  })
})
