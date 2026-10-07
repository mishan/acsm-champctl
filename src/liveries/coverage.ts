/**
 * Which skins the server offers that drivers can't get from the carset.
 *
 * A skin assigned on the server and missing from the carset is a car everyone
 * else sees in the default livery, and nothing says so until race night. The
 * server's list comes off its public car page, which shows every skin folder
 * it has for the car:
 *
 *     <img class="... car-image" src="/content/cars/<car>/skins/<skin>/preview.jpg"
 *          data-skin="<skin>" ...>
 *
 * Skins that came with the car are left out: every driver has those.
 */

import * as cheerio from "cheerio"

import { ANY_CAR_MODEL, type Championship } from "../acsm/types.js"
import { availableCars, classes, slots } from "../acsm/view.js"
import type { StoredLivery } from "./store.js"

/** Every car a championship can be raced in: what its classes allow and what its entrants drive. */
export function racedCars(championship: Championship): string[] {
  const cars = availableCars(championship)
  for (const cls of classes(championship)) {
    for (const { entrant } of slots(cls.Entrants)) {
      const model = (entrant.Model ?? "").trim()
      if (model) cars.add(model)
    }
  }
  cars.delete(ANY_CAR_MODEL)
  return [...cars].sort()
}

/** The skin folders a car page lists. */
export function parseCarSkins(html: string): string[] {
  const $ = cheerio.load(html)
  const skins = $("img[data-skin]")
    .toArray()
    .map((img) => $(img).attr("data-skin") ?? "")
  return [...new Set(skins.filter(Boolean))].sort()
}

export interface CarCoverage {
  carModel: string
  onServer: number
  /** On the server, not stock, and not in the carset. */
  missing: string[]
  /** In the carset but not on the server, so nobody can be assigned it. */
  notOnServer: string[]
  /** False when nothing says which skins came with the car, so `missing` counts those too. */
  stockKnown: boolean
}

export function carCoverage(
  carModel: string,
  serverSkins: readonly string[],
  carset: readonly StoredLivery[],
  stock: ReadonlySet<string>,
): CarCoverage {
  const packed = new Set(carset.filter((l) => l.carModel === carModel).map((l) => l.skinFolder))
  const onServer = new Set(serverSkins)
  return {
    carModel,
    onServer: onServer.size,
    missing: serverSkins.filter((s) => !stock.has(s) && !packed.has(s)),
    notOnServer: [...packed].filter((s) => !onServer.has(s)).sort(),
    stockKnown: stock.size > 0,
  }
}

export function renderCoverage(cars: readonly CarCoverage[]): string {
  const lines: string[] = []
  for (const car of cars) {
    lines.push(
      `${car.carModel}: ${car.onServer} on the server, ${car.missing.length} missing from the carset`,
    )
    if (!car.stockKnown && car.missing.length > 0) {
      lines.push(`  (no record of which skins came with this car, so those are counted too)`)
    }
    if (car.missing.length > 0) lines.push(`  missing: ${car.missing.join(", ")}`)
    if (car.notOnServer.length > 0) {
      lines.push(`  in the carset but not on the server: ${car.notOnServer.join(", ")}`)
    }
  }
  const missing = cars.reduce((n, c) => n + c.missing.length, 0)
  lines.push("")
  lines.push(
    missing === 0
      ? "Every custom skin on the server is in the carset."
      : `${missing} custom skin${missing === 1 ? " is" : "s are"} on the server but not in the ` +
          `carset. Import them with --import, or ask whoever made them for a copy.`,
  )
  return lines.join("\n")
}
