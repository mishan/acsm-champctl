/**
 * The drag arithmetic, against measurements written down here.
 *
 * These are the tests that can say a row landed at round 3 rather than round 5.
 * jsdom performs no layout, so a drag driven through a rendered list measures
 * every row at zero and can only distinguish "upwards" from "downwards" — see
 * the note on the DOM test in `NewChampionship.test.tsx`.
 *
 * The geometry throughout is four rows 40px tall with a 10px gap, so centres
 * sit at 20, 70, 120 and 170 and a slot is 50px.
 */

import { describe, expect, it } from "vitest"

import { dropTarget, moveItem, movedPositions, slideBy } from "./reorder"

const CENTRES = [20, 70, 120, 170]
/** Centre to centre. A row that moves one place moves by exactly this. */
const SLOT = 50

describe("moveItem", () => {
  it("moves a row later, closing the gap behind it", () => {
    expect(moveItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"])
  })

  it("moves a row earlier", () => {
    expect(moveItem(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"])
  })

  it("copies rather than mutating", () => {
    const before = ["a", "b"]
    expect(moveItem(before, 0, 1)).toEqual(["b", "a"])
    expect(before).toEqual(["a", "b"])
  })

  it("leaves the list alone for an index off either end", () => {
    // A caller can hand this a computed target without checking it first,
    // which is the whole reason it is total rather than throwing.
    expect(moveItem(["a", "b"], 0, 5)).toEqual(["a", "b"])
    expect(moveItem(["a", "b"], -1, 0)).toEqual(["a", "b"])
    expect(moveItem(["a", "b"], 1, 1)).toEqual(["a", "b"])
  })
})

describe("movedPositions", () => {
  /**
   * The rule a "may this move?" check has to apply. A move is not a swap: the
   * row is lifted out and the others close up, so everything between the ends
   * changes hands too.
   */
  it("covers both ends and everything between", () => {
    expect(movedPositions(4, 3, 0)).toEqual([0, 1, 2, 3])
    expect(movedPositions(4, 0, 3)).toEqual([0, 1, 2, 3])
    expect(movedPositions(4, 1, 2)).toEqual([1, 2])
  })

  it("disturbs nothing when nothing moves", () => {
    // Matching moveItem, which returns the list unchanged for each of these.
    expect(movedPositions(4, 2, 2)).toEqual([])
    expect(movedPositions(4, -1, 2)).toEqual([])
    expect(movedPositions(4, 2, 4)).toEqual([])
    expect(movedPositions(0, 0, 0)).toEqual([])
  })
})

describe("dropTarget", () => {
  it("stays put until the held row passes its neighbour's centre", () => {
    // Half a slot down is an overlap, not a displacement. A row that reordered
    // on the first pixel of movement would reorder on a tremor.
    expect(dropTarget(CENTRES, 0, SLOT / 2 - 1)).toBe(0)
    expect(dropTarget(CENTRES, 0, SLOT + 1)).toBe(1)
  })

  it("counts every neighbour a long drag passes", () => {
    expect(dropTarget(CENTRES, 0, 2 * SLOT + 1)).toBe(2)
    expect(dropTarget(CENTRES, 0, 10 * SLOT)).toBe(3)
  })

  it("works upwards the same way", () => {
    expect(dropTarget(CENTRES, 3, -(SLOT / 2 - 1))).toBe(3)
    expect(dropTarget(CENTRES, 3, -(SLOT + 1))).toBe(2)
    expect(dropTarget(CENTRES, 3, -10 * SLOT)).toBe(0)
  })

  it("cannot be dragged off either end", () => {
    expect(dropTarget(CENTRES, 0, -1000)).toBe(0)
    expect(dropTarget(CENTRES, 3, 1000)).toBe(3)
  })

  it("handles rows of different heights", () => {
    // A round whose name has wrapped onto a second line is taller than the
    // ones around it, so the distance to displace it is not a constant.
    const uneven = [20, 100, 160]
    expect(dropTarget(uneven, 0, 79)).toBe(0)
    expect(dropTarget(uneven, 0, 81)).toBe(1)
    expect(dropTarget(uneven, 0, 141)).toBe(2)
  })
})

describe("slideBy", () => {
  it("moves nothing while the held row is over its own slot", () => {
    for (let i = 0; i < CENTRES.length; i++) expect(slideBy(CENTRES, 1, 1, i)).toBe(0)
  })

  it("pushes the rows a downward drag passes upwards by one slot", () => {
    // Holding round 1 over round 3: rounds 2 and 3 come up one each, round 4
    // is past the drag and does not move.
    expect(slideBy(CENTRES, 0, 2, 1)).toBe(-SLOT)
    expect(slideBy(CENTRES, 0, 2, 2)).toBe(-SLOT)
    expect(slideBy(CENTRES, 0, 2, 3)).toBe(0)
    // The held row is positioned by the pointer, not by this.
    expect(slideBy(CENTRES, 0, 2, 0)).toBe(0)
  })

  it("pushes the rows an upward drag passes downwards by one slot", () => {
    expect(slideBy(CENTRES, 3, 1, 1)).toBe(SLOT)
    expect(slideBy(CENTRES, 3, 1, 2)).toBe(SLOT)
    expect(slideBy(CENTRES, 3, 1, 0)).toBe(0)
    expect(slideBy(CENTRES, 3, 1, 3)).toBe(0)
  })

  it("slides an uneven row by the distance to the slot it is taking", () => {
    // Not by a row height: the figure has to include the gap, and the rows
    // either side of a wrapped one are different sizes.
    const uneven = [20, 100, 160]
    expect(slideBy(uneven, 0, 2, 1)).toBe(-80)
    expect(slideBy(uneven, 0, 2, 2)).toBe(-60)
  })
})
