import { describe, expect, it } from "vitest"

import { unbelievable } from "../src/acsm/installed-content.js"

const list = (cars: number, tracks = 2) => ({
  cars: Array.from({ length: cars }, (_, i) => ({ id: `c${i}`, name: `Car ${i}` })),
  tracks: Array.from({ length: tracks }, (_, i) => ({ id: `t${i}`, name: `Track ${i}` })),
})

describe("which reads of what's installed to believe", () => {
  // A listing that fails reads as an empty one: Server Manager down for a
  // moment mustn't leave a week of empty pickers.
  it.each([
    ["the first read", list(0, 0), undefined, undefined],
    ["a car installed", list(11), list(10), undefined],
    ["a few cars removed", list(7), list(10), undefined],
    ["no cars where there were some", list(0), list(10), /cars/],
    ["no tracks where there were some", list(10, 0), list(10), /tracks/],
    ["more than half the cars gone", list(4), list(10), /cars/],
  ])("%s", (_, next, held, refused) => {
    const why = unbelievable(next, held)
    if (refused) expect(why).toMatch(refused)
    else expect(why).toBeUndefined()
  })
})
