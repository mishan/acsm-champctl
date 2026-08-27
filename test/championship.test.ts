import { describe, expect, it } from "vitest"

import type { ContentIndex } from "../src/content/index.js"
import { check } from "../src/gridmom/index.js"
import { championshipChecks } from "../src/gridmom/checks/championship.js"
import { contentChecks } from "../src/gridmom/checks/content.js"
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

type Export = Parameters<typeof check>[0]

const run = (c: Export) => check(c, testProfile(), { now: NOW, checks: championshipChecks })

const codes = (c: Export) => run(c).findings.map((f) => f.code)

describe("dropped scores", () => {
  it("is quiet when the drop count leaves rounds standing", () => {
    const c = championship({
      IgnoreXWorstEvents: 1,
      Events: [raceEvent(), raceEvent({ RaceSetup: { Track: "ks_silverstone" } })],
    })
    expect(codes(c)).not.toContain("champ.ignore-worst")
  })

  it("warns when dropping the worst results erases the whole championship", () => {
    // Two rounds, both dropped: the standings table renders all zeroes and
    // nobody can work out why until someone reads the settings page.
    const c = championship({
      IgnoreXWorstEvents: 2,
      Events: [raceEvent(), raceEvent({ RaceSetup: { Track: "ks_silverstone" } })],
    })
    const f = run(c).findings.find((x) => x.code === "champ.ignore-worst")
    expect(f?.severity).toBe("WARN")
    expect(f?.message).toContain("worst 2 results but only has 2 rounds")
    expect(f?.message).toContain("everything gets dropped")
    expect(f?.data).toMatchObject({ ignoreXWorstEvents: 2, events: 2 })
  })

  it("says so plainly when the drop count exceeds the rounds", () => {
    const c = championship({ IgnoreXWorstEvents: 3, Events: [raceEvent()] })
    const f = run(c).findings.find((x) => x.code === "champ.ignore-worst")
    expect(f?.message).toContain("worst 3 results but only has 1 round")
    expect(f?.message).toContain("more gets dropped than exists")
  })
})

describe("points table length", () => {
  it("is quiet when the table is at least as long as the grid", () => {
    // The default fixture pays 20 places into an 18-car race.
    expect(codes(championship())).not.toContain("champ.points-places")
  })

  it("warns when the back of a full grid can't score", () => {
    const c = championship({
      Classes: [championshipClass({ Points: { Places: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1] } })],
      Events: [raceEvent({ RaceSetup: { MaxClients: 24 } })],
    })
    const f = run(c).findings.find((x) => x.code === "champ.points-places")
    expect(f?.severity).toBe("WARN")
    expect(f?.message).toContain("RSS Formula Hybrid pays points down to 10th")
    expect(f?.message).toContain("up to 24 cars can start")
    expect(f?.message).toContain("the last 14 finishers can't score")
    expect(f?.data).toMatchObject({ places: 10, maxClients: 24 })
  })
})

describe("repeated tracks", () => {
  it("is quiet when every round is somewhere else", () => {
    const c = championship({
      Events: [raceEvent(), raceEvent({ RaceSetup: { Track: "ks_silverstone" } })],
    })
    expect(codes(c)).not.toContain("champ.repeated-track")
  })

  it("names the rounds that share a track", () => {
    // Usually a copy-paste in the emitter rather than a deliberate
    // double-header, and it is only obvious once you list the rounds.
    const c = championship({
      Events: [raceEvent(), raceEvent({ RaceSetup: { Track: "ks_silverstone" } }), raceEvent()],
    })
    const f = run(c).findings.find((x) => x.code === "champ.repeated-track")
    expect(f?.severity).toBe("WARN")
    expect(f?.message).toContain("suzuka shows up 2 times")
    expect(f?.message).toContain("round 1 and round 3")
    expect(f?.data).toMatchObject({ track: "suzuka", rounds: ["round 1", "round 3"] })
  })
})

describe("ACSR", () => {
  it("is quiet when ACSR is off and nothing claims otherwise", () => {
    expect(codes(championship())).not.toContain("champ.acsr-export")
  })

  it("notices second-race export left on with ACSR switched off", () => {
    const c = championship({ ACSR: false, ExportSecondRaceToACSR: true })
    const f = run(c).findings.find((x) => x.code === "champ.acsr-export")
    expect(f?.severity).toBe("INFO")
    expect(f?.message).toContain("ACSR is switched off")
  })

  it("names both gates when ACSR is on and neither is set", () => {
    const c = championship({ ACSR: true })
    const f = run(c).findings.find((x) => x.code === "champ.acsr-gates")
    expect(f?.severity).toBe("INFO")
    expect(f?.message).toContain("the skill gate and the safety gate have no value set")
    expect(f?.data).toMatchObject({ gates: ["ACSRSkillGate", "ACSRSafetyGate"] })
  })

  it("names only the gate that's actually blank", () => {
    const c = championship({ ACSR: true, ACSRSkillGate: "1500" })
    const f = run(c).findings.find((x) => x.code === "champ.acsr-gates")
    expect(f?.message).toContain("the safety gate has no value set")
  })

  it("reads a numeric zero safety gate as unset, which is what 2.4.x sends", () => {
    // The exact bug: `?? ""` compared against the empty string, so the int 0
    // read as a configured gate and the check stayed quiet about the one
    // championship it exists for. Skill gate populated so the finding can only
    // be about the safety gate.
    const c = championship({ ACSR: true, ACSRSkillGate: "1500", ACSRSafetyGate: 0 })
    const f = run(c).findings.find((x) => x.code === "champ.acsr-gates")
    expect(f, "a zero safety gate is no gate").toBeTruthy()
    expect(f?.message).toContain("the safety gate has no value set")
    expect(f?.data).toMatchObject({ gates: ["ACSRSafetyGate"] })
  })

  it("still reads null and a stringified zero as unset", () => {
    // Spelling the cases out must not lose what `?? ""` covered: null was one
    // of them, and a build serialising the int as a string is the other shape
    // "no gate" plausibly arrives in.
    for (const ACSRSafetyGate of [null, "0"] as const) {
      const c = championship({ ACSR: true, ACSRSkillGate: "1500", ACSRSafetyGate })
      const f = run(c).findings.find((x) => x.code === "champ.acsr-gates")
      expect(f, `${JSON.stringify(ACSRSafetyGate)} is no gate`).toBeTruthy()
    }
  })

  it("is quiet when both gates carry a value", () => {
    const c = championship({ ACSR: true, ACSRSkillGate: "1500", ACSRSafetyGate: "95" })
    expect(codes(c)).not.toContain("champ.acsr-gates")
  })
})

describe("description vs schedule", () => {
  const twoRounds = (Description: string) =>
    championship({
      Description,
      Events: [raceEvent(), raceEvent({ RaceSetup: { Track: "ks_silverstone" } })],
    })

  it("flags a track the sign-up post never mentions", () => {
    // Drivers read the description, not the schedule tab, so a round missing
    // from the blurb is a round half the grid doesn't turn up to.
    const f = run(twoRounds("Round 1 at Suzuka, see you there.")).findings.find(
      (x) => x.code === "champ.description-tracks",
    )
    expect(f?.severity).toBe("INFO")
    expect(f?.message).toContain("ks_silverstone")
    expect(f?.data).toMatchObject({ missing: ["ks_silverstone"] })
  })

  it("is quiet when every track gets a mention", () => {
    const c = twoRounds("Suzuka then Silverstone.")
    expect(codes(c)).not.toContain("champ.description-tracks")
  })

  it("doesn't nag about a description that lists no tracks at all", () => {
    // Prose that never names a circuit isn't a mismatch, it's just prose.
    const c = twoRounds("Six rounds of close racing. Bring a helmet.")
    expect(codes(c)).not.toContain("champ.description-tracks")
  })

  it("reports a short track folder, which the word filter used to swallow", () => {
    // The filter drops short words so `ks_barcelona_gp` isn't matched on "ks"
    // or "gp", which appear across half of Kunos's content. At a floor of four
    // it also emptied the word list for "spa" — and an empty list counts as
    // mentioned — so the one track a BATL season is most likely to run could
    // never be reported missing.
    const c = championship({
      Description: "Rounds at Suzuka and Monza. See you there.",
      Events: [raceEvent({ RaceSetup: { Track: "spa" } }), raceEvent()],
    })
    const f = run(c).findings.find((x) => x.code === "champ.description-tracks")
    expect(f?.severity).toBe("INFO")
    expect(f?.message).toContain("spa")
  })

  it("still ignores a folder too short to be a name", () => {
    // Two characters is a prefix, not a circuit — matching on those would
    // report a mention wherever a description happened to contain "gp".
    const c = championship({
      Description: "Rounds at Suzuka and Monza.",
      Events: [raceEvent({ RaceSetup: { Track: "gp" } }), raceEvent()],
    })
    expect(codes(c)).not.toContain("champ.description-tracks")
  })
})

describe("practice rollover", () => {
  it("is quiet while the next round's practice opens itself", () => {
    expect(codes(championship())).not.toContain("champ.next-practice")
  })

  it("warns when someone has to open practice by hand", () => {
    const c = championship({ StartNextPracticeOnEventComplete: false })
    const f = run(c).findings.find((x) => x.code === "champ.next-practice")
    expect(f?.severity).toBe("WARN")
    expect(f?.message).toContain("won't start automatically")
  })
})

describe("sign-up deadline", () => {
  it("notices sign-ups still open past their own closing date", () => {
    // Against the fixed clock: closed three days before NOW.
    const c = championship({
      SignUpForm: {
        Enabled: true,
        RegistrationClosesAt: "2026-08-21T12:00:00-07:00",
        Responses: [],
        ExtraFields: [],
      },
    })
    const f = run(c).findings.find((x) => x.code === "champ.signup-deadline")
    expect(f?.severity).toBe("INFO")
    expect(f?.message).toContain("3 days ago")
    expect(f?.data).toMatchObject({ closesAt: "2026-08-21T12:00:00.000-07:00" })
  })

  it("is quiet while the deadline is still ahead", () => {
    const c = championship({
      SignUpForm: {
        Enabled: true,
        RegistrationClosesAt: "2026-08-30T12:00:00-07:00",
        Responses: [],
        ExtraFields: [],
      },
    })
    expect(codes(c)).not.toContain("champ.signup-deadline")
  })

  it("ignores a Go zero time, which is what an unset deadline looks like", () => {
    const c = championship({
      SignUpForm: {
        Enabled: true,
        RegistrationClosesAt: "0001-01-01T00:00:00Z",
        Responses: [],
        ExtraFields: [],
      },
    })
    expect(codes(c)).not.toContain("champ.signup-deadline")
  })
})

describe("sign-up form leftovers", () => {
  it("is quiet on a form with no extra questions", () => {
    expect(codes(championship())).not.toContain("champ.signup-leftovers")
  })

  it("notices questions carried over from whatever the form was copied from", () => {
    const c = championship({
      SignUpForm: {
        Enabled: false,
        Responses: [],
        ExtraFields: [{ Name: "Discord" }, { Name: "Preferred number" }],
      },
    })
    const f = run(c).findings.find((x) => x.code === "champ.signup-leftovers")
    expect(f?.severity).toBe("INFO")
    expect(f?.message).toContain("2 extra questions")
    expect(f?.data).toMatchObject({ extraFields: 2 })
  })

  it("says nothing while the form is actually in use", () => {
    const c = championship({
      SignUpForm: { Enabled: true, Responses: [], ExtraFields: [{ Name: "Discord" }] },
    })
    expect(codes(c)).not.toContain("champ.signup-leftovers")
  })
})

describe("created before its own events", () => {
  it("tolerates a normal gap between creating a championship and running it", () => {
    // The fixture is created 1 August for a 2 September round.
    expect(codes(championship())).not.toContain("champ.created-after-events")
  })

  it("flags a Created stamp inherited from the template it was copied from", () => {
    const c = championship({ Created: "2020-01-01T00:00:00-07:00" })
    const f = run(c).findings.find((x) => x.code === "champ.created-after-events")
    expect(f?.severity).toBe("INFO")
    expect(f?.message).toContain("created 1 January 2020")
    expect(f?.message).toContain("first round on 2 September 2026")
  })

  it("ignores a Go zero Created rather than calling year 1 a template stamp", () => {
    const c = championship({ Created: "0001-01-01T00:00:00Z" })
    expect(codes(c)).not.toContain("champ.created-after-events")
  })
})

describe("empty championship", () => {
  it("is quiet on a championship with rounds and slots", () => {
    const found = codes(championship())
    expect(found).not.toContain("champ.no-events")
    expect(found).not.toContain("champ.no-entrants")
  })

  it("warns when there are no events", () => {
    const f = run(championship({ Events: [] })).findings.find((x) => x.code === "champ.no-events")
    expect(f?.severity).toBe("WARN")
    expect(f?.message).toContain("no events")
  })

  it("warns when no list anywhere holds a slot", () => {
    const c = championship({
      Classes: [championshipClass({ Entrants: entryList([]) })],
      Events: [raceEvent({ EntryList: entryList([]) })],
    })
    const f = run(c).findings.find((x) => x.code === "champ.no-entrants")
    expect(f?.severity).toBe("WARN")
    expect(f?.message).toContain("no entry list at all")
  })

  it("doesn't also claim there are no entrants when there are no events", () => {
    expect(codes(championship({ Events: [] }))).not.toContain("champ.no-entrants")
  })
})

/**
 * Content checks.
 *
 * Nothing in the codebase builds a ContentIndex yet — no producer exists, so in
 * production `ctx.content` is always absent and the three installed-content
 * checks return immediately. These tests exist so those checks are known-correct
 * the day a producer (the event form's track XHR, or an on-host filesystem scan)
 * arrives, rather than being debugged for the first time against a live server.
 * `content.pit-count-unknown` is the exception: it runs off the pit table and is
 * reachable today.
 */

interface StubContentSpec {
  /** track -> layouts. Use `[""]` for a track with no separate layouts. */
  tracks?: Record<string, readonly string[]>
  /** model -> skin folder names. */
  cars?: Record<string, readonly string[]>
}

function stubContent(spec: StubContentSpec): ContentIndex {
  const tracks = spec.tracks ?? {}
  const cars = spec.cars ?? {}
  return {
    hasTrack(track, layout) {
      const layouts = tracks[track.trim()]
      if (!layouts) return false
      const l = (layout ?? "").trim()
      return l === "" || layouts.includes(l)
    },
    hasCar(model) {
      return Object.hasOwn(cars, model.trim())
    },
    skinsFor(model) {
      const skins = cars[model.trim()]
      return skins ? new Set(skins) : undefined
    },
  }
}

const suzukaInstalled: StubContentSpec = {
  tracks: { suzuka: [""] },
  cars: { rss_formula_hybrid_2021: ["alice_01", "bob_01"] },
}

const runContent = (
  c: Export,
  content?: ContentIndex,
  pits: ReturnType<typeof pitTable> = pitTable([suzukaPits]),
) =>
  check(c, testProfile(), {
    pits,
    now: NOW,
    checks: contentChecks,
    ...(content ? { content } : {}),
  })

const contentCodes = (c: Export, content?: ContentIndex, pits?: ReturnType<typeof pitTable>) =>
  runContent(c, content, pits).findings.map((f) => f.code)

describe("installed tracks", () => {
  it("skips entirely without a content index, rather than guessing", () => {
    expect(contentCodes(championship())).not.toContain("content.track-missing")
  })

  it("is quiet when the track is installed", () => {
    expect(contentCodes(championship(), stubContent(suzukaInstalled))).not.toContain(
      "content.track-missing",
    )
  })

  it("errors on a track the server doesn't have", () => {
    // The race simply won't launch, so this blocks a push.
    const c = championship({ Events: [raceEvent({ RaceSetup: { Track: "rt_bathurst" } })] })
    const report = runContent(c, stubContent(suzukaInstalled), pitTable())
    const f = report.findings.find((x) => x.code === "content.track-missing")
    expect(f?.severity).toBe("ERROR")
    expect(f?.message).toContain("rt_bathurst isn't installed")
    expect(f?.location?.round).toBe(1)
    expect(report.ok).toBe(false)
  })

  it("names the layout when only the layout is missing", () => {
    const c = championship({
      Events: [raceEvent({ RaceSetup: { Track: "ks_silverstone", TrackLayout: "international" } })],
    })
    const f = runContent(
      c,
      stubContent({ tracks: { ks_silverstone: ["gp"] } }),
      pitTable(),
    ).findings.find((x) => x.code === "content.track-missing")
    expect(f?.severity).toBe("ERROR")
    expect(f?.message).toContain("the international layout of ks_silverstone")
    expect(f?.data).toMatchObject({ track: "ks_silverstone", layout: "international" })
  })
})

/**
 * The layouts index is separate from the content index, and so is this check.
 * See `CheckContext.layouts`: layouts come off an event edit form, which needs
 * a login, so a caller can have one of the two and not the other.
 */
describe("track layouts", () => {
  const BRANDS = { ks_brands_hatch: ["indy", "gp"] }
  const at = (over: { Track: string; TrackLayout?: string }) =>
    championship({ Events: [raceEvent({ RaceSetup: over })] })

  const runLayouts = (c: Export, layouts?: Record<string, string[]> | null) =>
    check(c, testProfile(), {
      pits: pitTable(),
      now: NOW,
      checks: contentChecks,
      ...(layouts === undefined ? {} : { layouts }),
    })

  // Only this check's findings. The fixture's tracks have no pit count on
  // file, so `content.pit-count-unknown` rides along on every run and is
  // nothing to do with layouts.
  const codes = (c: Export, layouts?: Record<string, string[]> | null) =>
    runLayouts(c, layouts)
      .findings.map((f) => f.code)
      .filter((code) => code.startsWith("content.track-layout"))

  it("says nothing without a layout index", () => {
    // Nor with a read that failed, which is what null means on the wire.
    const c = at({ Track: "ks_brands_hatch" })
    expect(codes(c)).not.toContain("content.track-layout-unset")
    expect(codes(c, null)).not.toContain("content.track-layout-unset")
  })

  it("is quiet about a track that has no layout to choose", () => {
    // Absent from a present index means one layout, which ACSM stores as "".
    expect(codes(at({ Track: "spa" }), BRANDS)).toEqual([])
  })

  it("is quiet when the layout is one the track has", () => {
    expect(codes(at({ Track: "ks_brands_hatch", TrackLayout: "gp" }), BRANDS)).toEqual([])
  })

  /**
   * What the create screen produced before it asked for a layout: a clone
   * inherits `TrackLayout: ""`, and on a track with layouts that is a round
   * ACSM can't render and a race at whatever it falls back to.
   */
  it("warns when a track with layouts has none set", () => {
    const f = runLayouts(at({ Track: "ks_brands_hatch" }), BRANDS).findings.find(
      (x) => x.code === "content.track-layout-unset",
    )
    expect(f?.severity).toBe("WARN")
    expect(f?.message).toContain("indy and gp")
    expect(f?.location?.round).toBe(1)
    expect(f?.data).toMatchObject({ track: "ks_brands_hatch", available: ["indy", "gp"] })
  })

  /**
   * What every champctl event save wrote before `acsm/event-form.ts`: the
   * first option of a select listing every track on the server, so a Brands
   * Hatch round came back on a Black Cat County layout.
   */
  it("warns when the layout belongs to another track", () => {
    const c = at({ Track: "ks_brands_hatch", TrackLayout: "ks_black_cat_county:layout_int" })
    const f = runLayouts(c, BRANDS).findings.find((x) => x.code === "content.track-layout-unknown")
    expect(f?.severity).toBe("WARN")
    expect(f?.message).toContain("isn't one ks_brands_hatch has")
    expect(f?.data).toMatchObject({ layout: "ks_black_cat_county:layout_int" })
  })

  /**
   * A single-layout track with a layout set is wrong too, and it was the
   * shape sitting on a real round: the index has nothing to compare against,
   * so an "is it one of the track's layouts?" test alone said nothing.
   */
  it("warns about a layout on a track that has none", () => {
    const f = runLayouts(
      at({ Track: "spa", TrackLayout: "ks_black_cat_county:layout_int" }),
      BRANDS,
    ).findings.find((x) => x.code === "content.track-layout-unknown")
    expect(f?.severity).toBe("WARN")
    expect(f?.message).toContain("offers no layouts for spa")
  })

  it("does not block a push", () => {
    // BATL ran a full practice session on a round in this state. Worth saying,
    // not worth refusing a lap-count change over.
    expect(runLayouts(at({ Track: "ks_brands_hatch" }), BRANDS).ok).toBe(true)
  })
})

describe("installed cars", () => {
  it("is quiet when every class model is installed", () => {
    expect(contentCodes(championship(), stubContent(suzukaInstalled))).not.toContain(
      "content.car-missing",
    )
  })

  it("errors on a class model the server doesn't have", () => {
    const f = runContent(championship(), stubContent({ tracks: { suzuka: [""] } })).findings.find(
      (x) => x.code === "content.car-missing",
    )
    expect(f?.severity).toBe("ERROR")
    expect(f?.message).toContain("rss_formula_hybrid_2021")
    expect(f?.data).toMatchObject({ models: ["rss_formula_hybrid_2021"] })
  })

  it("counts the spectator car, which nobody remembers to install", () => {
    const c = championship({
      SpectatorCarEnabled: true,
      SpectatorCar: { Model: "ford_transit", PitBox: 29, Name: "Spectator" },
    })
    const f = runContent(c, stubContent(suzukaInstalled)).findings.find(
      (x) => x.code === "content.car-missing",
    )
    expect(f?.message).toContain("ford_transit")
  })
})

describe("installed skins", () => {
  const withSkin = (skin: string) =>
    championship({
      Events: [raceEvent({ EntryList: entryList([driver("alice", { Skin: skin })]) })],
      Classes: [championshipClass({ Entrants: entryList(emptySlots(1)) })],
    })

  it("is quiet when the skin folder exists", () => {
    expect(contentCodes(withSkin("alice_01"), stubContent(suzukaInstalled))).not.toContain(
      "content.skin-missing",
    )
  })

  it("warns and names the driver when the skin isn't on the server", () => {
    // The driver silently falls back to a default livery mid-session, which
    // ruins the broadcast overlay and the results screenshots.
    const f = runContent(withSkin("alice_99"), stubContent(suzukaInstalled)).findings.find(
      (x) => x.code === "content.skin-missing",
    )
    expect(f?.severity).toBe("WARN")
    expect(f?.message).toContain("alice is set to the alice_99 skin")
    expect(f?.message).toContain("suzuka (round 1)")
    expect(f?.data).toMatchObject({ model: "rss_formula_hybrid_2021", skin: "alice_99" })
  })

  it("leaves an unknown model to the car check instead of blaming the skin", () => {
    const c = championship({
      Classes: [
        championshipClass({ AvailableCars: ["mystery_car"], Entrants: entryList(emptySlots(1)) }),
      ],
      Events: [raceEvent({ EntryList: entryList([driver("alice", { Model: "mystery_car" })]) })],
    })
    expect(contentCodes(c, stubContent(suzukaInstalled))).not.toContain("content.skin-missing")
  })

  it("ignores unclaimed slots, which carry the sentinel model", () => {
    const c = championship({
      Events: [raceEvent({ EntryList: entryList([{ Skin: "nobody_01" }]) })],
    })
    expect(contentCodes(c, stubContent(suzukaInstalled))).not.toContain("content.skin-missing")
  })
})

describe("pit counts", () => {
  it("is quiet on a verified track", () => {
    expect(contentCodes(championship())).not.toContain("content.pit-count-unknown")
  })

  it("warns when the table has never heard of the track, and says what it can't check", () => {
    // Unknown pit counts are what silently disable the grid checks, so the
    // silence itself has to be visible.
    const c = championship({
      Events: [
        raceEvent({
          RaceSetup: { MaxClients: 18 },
          EntryList: entryList([{ ...driver("late"), PitBox: 21 }]),
        }),
      ],
      Classes: [championshipClass({ Entrants: entryList(emptySlots(1)) })],
    })
    const f = runContent(c, undefined, pitTable()).findings.find(
      (x) => x.code === "content.pit-count-unknown",
    )
    expect(f?.severity).toBe("WARN")
    expect(f?.message).toContain("how many pit boxes suzuka has")
    expect(f?.message).toContain("whether 22 cars fit")
    expect(f?.data).toMatchObject({ track: "suzuka", needed: 22 })
  })

  it("reports an unknown track once, not once per round", () => {
    const c = championship({ Events: [raceEvent(), raceEvent()] })
    const found = runContent(c, undefined, pitTable()).findings.filter(
      (x) => x.code === "content.pit-count-unknown",
    )
    expect(found).toHaveLength(1)
  })

  it("warns on a count nobody has verified, naming where it came from", () => {
    const pits = pitTable([{ track: "suzuka", layout: "", pitboxes: 30, source: "acsm" }])
    const f = runContent(championship(), undefined, pits).findings.find(
      (x) => x.code === "content.pit-count-unverified",
    )
    expect(f?.severity).toBe("WARN")
    expect(f?.message).toContain("suzuka's pit count of 30 came from acsm")
    expect(f?.data).toMatchObject({ pitboxes: 30, source: "acsm" })
  })
})
