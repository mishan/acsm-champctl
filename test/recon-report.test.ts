import { describe, expect, it } from "vitest"

import {
  comparePitBoxes,
  isLegacyVersion,
  majorVersion,
  raggedKeys,
  redactBaseUrl,
  stableSource,
  stableUrl,
} from "../scripts/recon/report.js"
import type { Entrant, EntryList } from "../src/acsm/types.js"
import { championship, driver, raceEvent } from "./support/build.js"

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
      stableUrl("http://192.168.2.4:8772/championship/b3607ce3-cb71-48e0-a335-ed09b8ce377e/event/submit"),
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
    expect(stableSource("copy of championship b3607ce3-cb71-48e0-a335-ed09b8ce377e on this server"))
      .toBe("copy of championship {id} on this server")
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
