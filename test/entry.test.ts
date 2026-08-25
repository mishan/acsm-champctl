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
          EntryList: entryList(
            boxes.map((box, i) => ({ ...driver(`d${i}`), PitBox: box })),
          ),
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

  it("counts the spectator car against capacity", () => {
    const c = championship({
      SpectatorCarEnabled: true,
      SpectatorCar: { Model: "ford_transit", PitBox: 29, Name: "Spectator" },
      Events: [raceEvent({ RaceSetup: { MaxClients: 30 } })],
    })
    expect(codes(c)).toContain("grid.max-clients")
  })

  it("stays silent when the pit count is unknown", () => {
    const c = championship({ Events: [raceEvent({ RaceSetup: { MaxClients: 999 } })] })
    expect(codes(c, pitTable())).not.toContain("grid.max-clients")
  })

  it("errors when an entrant sits beyond the last pit box", () => {
    const c = championship({
      Events: [
        raceEvent({
          EntryList: entryList([{ ...driver("late"), PitBox: 30 }]),
        }),
      ],
    })
    const f = run(c).findings.find((x) => x.code === "entry.pit-box-out-of-range")
    expect(f?.severity).toBe("ERROR")
    expect(f?.message).toContain("stops at 29")
  })
})

describe("spectator car", () => {
  it("errors when it shares a pit box with an entrant", () => {
    const c = championship({
      SpectatorCarEnabled: true,
      SpectatorCar: { Model: "ford_transit", PitBox: 2, Name: "Spectator" },
      Events: [
        raceEvent({
          EntryList: entryList([driver("a"), driver("b"), driver("clash")]),
        }),
      ],
    })
    // Reported for every list the box collides in; the event one names a driver.
    const found = run(c).findings.filter((x) => x.code === "entry.spectator-pit-box")
    expect(found.length).toBeGreaterThan(0)
    expect(found.every((f) => f.severity === "ERROR")).toBe(true)
    expect(found.some((f) => f.message.includes("clash"))).toBe(true)
  })

  it("is ignored while disabled", () => {
    const c = championship({
      SpectatorCarEnabled: false,
      SpectatorCar: { Model: "ford_transit", PitBox: 0 },
      Events: [raceEvent({ EntryList: entryList([driver("a")]) })],
    })
    expect(codes(c)).not.toContain("entry.spectator-pit-box")
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
  it("catches a spectator model left in the car list while disabled", () => {
    // The exact bug the import test exposed (plan §5.5).
    const c = championship({
      SpectatorCarEnabled: false,
      Events: [
        raceEvent({ RaceSetup: { Cars: "rss_formula_hybrid_2021;ford_transit" } }),
      ],
    })
    const f = run(c).findings.find((x) => x.code === "grid.race-setup-cars")
    expect(f?.severity).toBe("WARN")
    expect(f?.message).toContain("ford_transit")
  })

  it("accepts the spectator model when the spectator car is on", () => {
    const c = championship({
      SpectatorCarEnabled: true,
      SpectatorCar: { Model: "ford_transit", PitBox: 29 },
      Events: [
        raceEvent({ RaceSetup: { Cars: "rss_formula_hybrid_2021;ford_transit" } }),
      ],
    })
    expect(codes(c)).not.toContain("grid.race-setup-cars")
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
  it("errors on duplicates when they're disallowed", () => {
    const c = championship({
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
    const f = run(c).findings.find((x) => x.code === "entry.duplicate-skin")
    expect(f?.severity).toBe("ERROR")
    expect(f?.message).toContain("red_07")
  })

  it("stays quiet when duplicates are allowed", () => {
    const c = championship({
      Events: [
        raceEvent({
          RaceSetup: { AllowDuplicateSkinChoices: true },
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

  it("allows the same skin name on different models", () => {
    const c = championship({
      Classes: [
        championshipClass({ AvailableCars: ["car_a", "car_b"], Entrants: entryList(emptySlots(2)) }),
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
    expect(codes(c)).not.toContain("entry.duplicate-skin")
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
