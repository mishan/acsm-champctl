import { describe, expect, it } from "vitest"

import { carCoverage, parseCarSkins, racedCars, renderCoverage } from "../src/liveries/coverage.js"
import type { StoredLivery } from "../src/liveries/store.js"
import { championship, championshipClass, entryList } from "./support/build.js"

const CAR = "ac_legends_gt_nissan_gtr"

const stored = (skinFolder: string, carModel = CAR): StoredLivery => ({
  championshipId: "library",
  carModel,
  driverName: skinFolder,
  skinFolder,
  digest: "d",
  bytes: 1,
  fileCount: 1,
  source: "import",
  firstAppliedAt: "",
  appliedAt: "",
})

describe("parseCarSkins", () => {
  it("reads the skin folders off a car page, names with spaces included", () => {
    // As ACSM 2.4.15 renders /car/<model>.
    const html = `
      <div class="car-skin">
        <img class="img img-fluid car-image" src="/content/cars/${CAR}/skins/21New%20-%20RyanG/preview.jpg"
             alt="skin 21New - RyanG" data-skin="21New - RyanG" data-toggle="tooltip"/>
      </div>
      <div class="car-skin">
        <img class="img img-fluid car-image" src="/content/cars/${CAR}/skins/Buckmark/preview.jpg"
             data-skin="Buckmark"/>
      </div>`
    expect(parseCarSkins(html)).toEqual(["21New - RyanG", "Buckmark"])
  })
})

describe("carCoverage", () => {
  it("counts a custom skin the carset lacks, and not one that came with the car", () => {
    const coverage = carCoverage(
      CAR,
      ["21New", "669_Slipshod", "Buckmark", "MISF1T_Halloween"],
      [stored("Buckmark"), stored("669_Slipshod", "ks_other"), stored("Gone")],
      new Set(["21New"]),
    )
    expect(coverage).toMatchObject({
      onServer: 4,
      missing: ["669_Slipshod", "MISF1T_Halloween"],
      notOnServer: ["Gone"],
      stockKnown: true,
    })
  })
})

describe("renderCoverage", () => {
  it("prints names off the server's disk without their control characters", () => {
    const out = renderCoverage([
      { carModel: CAR, onServer: 1, missing: ["\u001b[2Jevil"], notOnServer: [], stockKnown: true },
    ])
    expect(out).toContain("evil")
    expect(out).not.toContain("\u001b")
  })
})

describe("racedCars", () => {
  it("takes what the classes allow and what the entrants drive, without the any-car marker", () => {
    const c = championship({
      Classes: [
        championshipClass({
          AvailableCars: [CAR, "ac_legends_gt_bmw_csl"],
          Entrants: entryList([{ Model: "ford_transit" }, { Model: "any_car_model" }, {}]),
        }),
      ],
    })
    expect(racedCars(c)).toEqual(["ac_legends_gt_bmw_csl", CAR, "ford_transit"])
  })
})
