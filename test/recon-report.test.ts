import { describe, expect, it } from "vitest"

import { comparePitBoxes, raggedKeys } from "../scripts/recon/report.js"
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
