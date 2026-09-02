import { describe, expect, it } from "vitest"

import {
  comparePitBoxes,
  describeControls,
  internalUuidJoin,
  isLegacyVersion,
  majorVersion,
  raggedKeys,
  redactBaseUrl,
  stableSource,
  stableUrl,
  summariseControls,
} from "../scripts/recon/report.js"
import type { Entrant, EntryList } from "../src/acsm/types.js"
import { championship, championshipClass, driver, entryList, raceEvent } from "./support/build.js"

describe("raggedKeys", () => {
  /** The shape of a real 24-entrant 1.7.9 event form. */
  const realShape = {
    "EntryList.Name": 24,
    "EntryList.GUID": 24,
    "EntryList.Car": 24,
    "EntryList.NumEntrants": 1,
    "EntryList.OverwriteAllEvents": 1,
    "EntryList.TransferTeamPoints": 1,
    Track: 1,
    MaxClients: 1,
  }

  it("says nothing about a well-formed event form", () => {
    // NumEntrants and the two unpaired checkboxes all sit at 1 against 24
    // entrants. Reporting them would drown the list in things that are fine.
    expect(raggedKeys(realShape, 24)).toEqual([])
  })

  it("reports an array that really is short", () => {
    expect(raggedKeys({ ...realShape, "EntryList.GUID": 23 }, 24)).toEqual(["EntryList.GUID=23"])
  })

  it("reports an unrecognised key, which is the one worth seeing", () => {
    expect(raggedKeys({ ...realShape, "EntryList.SomethingNew": 1 }, 24)).toEqual([
      "EntryList.SomethingNew=1",
    ])
  })

  it("ignores fields outside the entry list", () => {
    expect(raggedKeys({ Track: 1, "Sessions.Race.Laps": 1 }, 24)).toEqual([])
  })
})

describe("comparePitBoxes", () => {
  /**
   * `undefined` means the entrant has no `PitBox` key at all, which is what a
   * real export looks like when the field was never set — not a PitBox holding
   * some sentinel value.
   */
  const withBoxes = (boxes: (number | undefined)[]) => {
    const list: EntryList = {}
    boxes.forEach((box, i) => {
      const e: Entrant = { ...driver(`d${i}`) }
      if (box === undefined) delete e.PitBox
      else e.PitBox = box
      list[`CAR_${i}`] = e
    })
    return championship({ Events: [raceEvent({ EntryList: list })] })
  }

  it("finds genuine duplicates", () => {
    const c = withBoxes([0, 1, 1, 3, 3])
    expect(comparePitBoxes(c, c).sentDuplicates).toEqual([1, 3])
  })

  it("does not treat missing pit boxes as sharing one", () => {
    // Folding these into a -1 sentinel made them collide with each other and
    // reported "duplicate pit boxes at -1", which says nothing true.
    const c = withBoxes([undefined, undefined, undefined])
    expect(comparePitBoxes(c, c).sentDuplicates).toEqual([])
    expect(comparePitBoxes(c, c).sentWithoutPitBox).toBe(3)
  })

  it("separates real duplicates from missing ones", () => {
    const c = withBoxes([0, 1, 1, undefined, undefined])
    const r = comparePitBoxes(c, c)
    expect(r.sentDuplicates).toEqual([1])
    expect(r.sentWithoutPitBox).toBe(2)
  })

  it("counts entrants lost across the round trip", () => {
    // The AddInPitBox question: two entrants at box 1, one comes back.
    const sent = withBoxes([0, 1, 1])
    const returned = withBoxes([0, 1])
    const r = comparePitBoxes(sent, returned)
    expect(r.sentCount).toBe(3)
    expect(r.returnedCount).toBe(2)
    expect(r.entrantsLost).toBe(1)
  })

  it("reports nothing lost when everything survives", () => {
    const c = withBoxes([0, 1, 2])
    const r = comparePitBoxes(c, c)
    expect(r.entrantsLost).toBe(0)
    expect(r.sentDuplicates).toEqual([])
    expect(r.sentWithoutPitBox).toBe(0)
  })

  it("copes with a championship that has no events", () => {
    const empty = championship({ Events: [] })
    expect(comparePitBoxes(empty, empty)).toMatchObject({ sentCount: 0, returnedCount: 0 })
  })
})

describe("masking for committed artefacts", () => {
  it("keeps scheme and port but drops the host", () => {
    expect(redactBaseUrl("http://192.168.2.4:8772")).toBe("http://<redacted>:8772")
    expect(redactBaseUrl("https://ac.batlracing.com")).toBe("https://<redacted>")
    expect(redactBaseUrl("not a url")).toBe("<redacted>")
  })

  it("reduces a form action to a path with ids masked", () => {
    // Actions resolve to absolute URLs, so they carry the host; the ids are
    // new on every run, so leaving them makes every capture differ.
    expect(
      stableUrl(
        "http://192.168.2.4:8772/championship/b3607ce3-cb71-48e0-a335-ed09b8ce377e/event/submit",
      ),
    ).toBe("/championship/{id}/event/submit")
  })

  it("masks Steam GUIDs in entrant links", () => {
    expect(stableUrl("/championship/x/entrant/76561198012345678")).toBe(
      "/championship/x/entrant/{guid}",
    )
  })

  it("makes an absolute fixture path repo-relative", () => {
    // Resolved at load time it carries somebody's home directory, and these
    // files are committed and public.
    const abs = `${process.cwd()}/fixtures/synthetic/recon-seed.json`
    expect(stableSource(abs)).toBe("fixtures/synthetic/recon-seed.json")
  })

  it("keeps only the filename for a path outside the repo", () => {
    expect(stableSource("/etc/somewhere/else/export.json")).toBe("export.json")
  })

  it("leaves a relative path alone", () => {
    expect(stableSource("fixtures/synthetic/recon-seed.json")).toBe(
      "fixtures/synthetic/recon-seed.json",
    )
  })

  it("masks ids in a provenance sentence without mangling it", () => {
    // stableUrl would percent-encode the spaces into nonsense; this is prose,
    // not a URL.
    expect(
      stableSource("copy of championship b3607ce3-cb71-48e0-a335-ed09b8ce377e on this server"),
    ).toBe("copy of championship {id} on this server")
  })
})

describe("version gating", () => {
  it("recognises 1.x however the version was spelled", () => {
    // /healthcheck.json reports "v1.7.9"; the footer scrape drops the v and
    // reports "1.7.9". The caveat this gates has to appear for both — a
    // provisional answer presented without its caveat is the bad outcome.
    for (const v of ["1.7.9", "v1.7.9", "V1.7.9", " v1.7.8 ", "1.10.0"]) {
      expect(isLegacyVersion(v), v).toBe(true)
    }
  })

  it("does not warn for the version BATL actually runs", () => {
    for (const v of ["2.4.5", "v2.4.5", "10.0.0", "v11.2.0"]) {
      expect(isLegacyVersion(v), v).toBe(false)
    }
  })

  it("does not warn when the version is unknown", () => {
    // An unknown version already prints as "unknown"; claiming it is 1.x would
    // be inventing a fact.
    for (const v of [undefined, "", "unknown", "premium"]) {
      expect(isLegacyVersion(v), String(v)).toBe(false)
    }
  })

  it("parses the major on its own", () => {
    expect(majorVersion("v2.4.5")).toBe(2)
    expect(majorVersion("1.7.9")).toBe(1)
    expect(majorVersion("nonsense")).toBeUndefined()
    // Not a prefix match: 12.x must not read as 1.x.
    expect(majorVersion("12.0.1")).toBe(12)
    expect(isLegacyVersion("12.0.1")).toBe(false)
  })
})

describe("describeControls", () => {
  const SUBMIT = "/championships/new/submit"

  // Both attributes on the wrapper, rather than a class beside a class it
  // already has: two `class` attributes on one element is not "both", it is the
  // first and the second silently discarded, which is how this fixture first
  // reported that `d-none` went unrecognised when it doesn't.
  const HIDDEN = 'class="entrant-template" style="display: none"'

  /**
   * The shape the championship form is suspected of having: real entrant rows
   * plus a hidden row ACSM's "add entrant" button clones. That would explain
   * `OverwriteAllEvents` at 8 for 6 entrants without anything being wrong.
   */
  const page = (entrantRows: number, hiddenRows: number, hiddenMarkup = HIDDEN) => {
    const row = (klass: string) => `
      <div class="entrant ${klass}">
        <input type="text" name="EntryList.Name" value="someone">
        <select name="EntryList.Skin"><option value="a">a</option></select>
        <input type="checkbox" name="EntryList.OverwriteAllEvents">
      </div>`
    return `
      <html><body>
        <form action="/search"><input name="q"></form>
        <form action="${SUBMIT}" method="post">
          ${Array.from({ length: entrantRows }, () => row("live")).join("")}
          <div ${hiddenMarkup}>
            ${Array.from({ length: hiddenRows }, () => row("template")).join("")}
          </div>
        </form>
      </body></html>`
  }

  it("reads the championship form, not the navbar search form", () => {
    // Every ACSM page carries a search form, and "the first form" is that one —
    // the same trap that made recon report fileField=NOT FOUND on the import
    // page (docs/acsm-write-path.md §9).
    const sites = describeControls(page(3, 0), SUBMIT, ["EntryList.Name", "q"])
    expect(sites["EntryList.Name"]).toHaveLength(3)
    expect(sites["q"]).toEqual([])
  })

  it("returns nothing when no form has that action", () => {
    expect(describeControls(page(3, 0), "/nowhere", ["EntryList.Name"])).toEqual({})
  })

  it("records the control type, so a checkbox is not mistaken for a select", () => {
    const sites = describeControls(page(1, 0), SUBMIT, [
      "EntryList.Skin",
      "EntryList.OverwriteAllEvents",
    ])
    expect(sites["EntryList.Skin"]?.[0]).toMatchObject({ tag: "select", type: "select" })
    expect(sites["EntryList.OverwriteAllEvents"]?.[0]).toMatchObject({
      tag: "input",
      type: "checkbox",
    })
  })

  it("separates a hidden template row from the real entrants", () => {
    // This is the whole point: the count alone says 4, and 4 is indistinguishable
    // from a fourth driver until you know one of them is a clone-me template.
    const sites = describeControls(page(3, 1), SUBMIT, ["EntryList.OverwriteAllEvents"])
    expect(sites["EntryList.OverwriteAllEvents"]).toHaveLength(4)
    expect(sites["EntryList.OverwriteAllEvents"]?.filter((s) => s.hidden)).toHaveLength(1)
  })

  it("recognises the three ways ACSM's markup hides a row", () => {
    const variants = [
      'class="entrant-template" style="display:none"',
      'class="entrant-template d-none"',
      'class="entrant-template" hidden',
    ]
    for (const markup of variants) {
      const sites = describeControls(page(2, 1, markup), SUBMIT, ["EntryList.Name"])
      expect(
        sites["EntryList.Name"]?.filter((s) => s.hidden),
        markup,
      ).toHaveLength(1)
    }
  })

  it("summarises occurrences by shape rather than listing thirty of them", () => {
    const sites = describeControls(page(3, 1), SUBMIT, ["EntryList.Name"])
    const summary = summariseControls(sites["EntryList.Name"] ?? [])
    // Two shapes, not four rows: three live and one hidden.
    expect(Object.keys(summary)).toHaveLength(2)
    expect(Object.values(summary).sort()).toEqual([1, 3])
  })

  it("masks ids in the ancestor classes it reports", () => {
    // These artefacts are committed and public, and ACSM puts entrant UUIDs in
    // markup — an ancestor class is not obviously safe just because it is not a
    // value.
    const html = `<form action="${SUBMIT}"><div class="row entrant-b3607ce3-cb71-48e0-a335-ed09b8ce377e">
      <input name="EntryList.Name"></div></form>`
    const sites = describeControls(html, SUBMIT, ["EntryList.Name"])
    expect(sites["EntryList.Name"]?.[0]?.ancestors).toEqual(["row entrant-{id}"])
  })
})

describe("internalUuidJoin", () => {
  const withUuid = (name: string, uuid: string) => driver(name, { InternalUUID: uuid })
  const A = "11111111-1111-1111-1111-111111111111"
  const B = "22222222-2222-2222-2222-222222222222"

  it("finds every class entrant when the UUIDs line up", () => {
    const roster = [withUuid("alice", A), withUuid("bob", B)]
    const c = championship({
      Classes: [championshipClass({ Entrants: entryList(roster) })],
      Events: [
        raceEvent({ EntryList: entryList(roster) }),
        raceEvent({ EntryList: entryList(roster) }),
      ],
    })
    expect(internalUuidJoin(c)).toMatchObject({
      classEntrants: 2,
      matchedPerRound: [2, 2],
      matchedEverywhere: 2,
    })
  })

  it("finds nothing when each list has its own UUIDs", () => {
    // Plan §5.5's claim. If this is what a real export looks like, ticking
    // OverwriteAllEvents reaches no round and says nothing — ACSM's
    // FindEntrantByInternalUUID returns an empty Entrant and the copy is
    // discarded.
    const c = championship({
      Classes: [
        championshipClass({ Entrants: entryList([withUuid("alice", A), withUuid("bob", B)]) }),
      ],
      Events: [
        raceEvent({
          EntryList: entryList([
            withUuid("alice", "33333333-3333-3333-3333-333333333333"),
            withUuid("bob", "44444444-4444-4444-4444-444444444444"),
          ]),
        }),
      ],
    })
    expect(internalUuidJoin(c)).toMatchObject({ matchedPerRound: [0], matchedEverywhere: 0 })
  })

  it("counts a round with no entry list as reaching everyone", () => {
    // CombineEntryLists returns the class list unchanged for those, so there is
    // nothing to overwrite and nothing missed. Counting them as a miss would
    // report a problem that does not exist.
    const roster = [withUuid("alice", A)]
    const c = championship({
      Classes: [championshipClass({ Entrants: entryList(roster) })],
      Events: [raceEvent({ EntryList: {} }), raceEvent({ EntryList: entryList(roster) })],
    })
    expect(internalUuidJoin(c)).toMatchObject({
      matchedPerRound: [1, 1],
      roundsWithoutEntryList: [1],
      matchedEverywhere: 1,
    })
  })

  it("counts class entrants with no usable UUID separately", () => {
    // The nil UUID is what an unclaimed sign-up slot carries, and it would
    // otherwise match every other unclaimed slot in every round.
    const c = championship({
      Classes: [
        championshipClass({
          Entrants: entryList([
            withUuid("alice", A),
            withUuid("nobody", "00000000-0000-0000-0000-000000000000"),
            withUuid("blank", ""),
          ]),
        }),
      ],
      Events: [raceEvent({ EntryList: entryList([withUuid("alice", A)]) })],
    })
    expect(internalUuidJoin(c)).toMatchObject({
      classEntrants: 3,
      classEntrantsWithoutUuid: 2,
      matchedPerRound: [1],
      matchedEverywhere: 1,
    })
  })

  it("reports a driver missing from one round of several", () => {
    const c = championship({
      Classes: [
        championshipClass({ Entrants: entryList([withUuid("alice", A), withUuid("bob", B)]) }),
      ],
      Events: [
        raceEvent({ EntryList: entryList([withUuid("alice", A), withUuid("bob", B)]) }),
        raceEvent({ EntryList: entryList([withUuid("alice", A)]) }),
      ],
    })
    expect(internalUuidJoin(c)).toMatchObject({
      matchedPerRound: [2, 1],
      matchedEverywhere: 1,
    })
  })
})
