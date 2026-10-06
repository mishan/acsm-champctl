/**
 * A finished championship's top three, as ACSM shows them.
 *
 * Read off the championship's public page rather than worked out from the
 * standings: ACSM renders a row of cards for every finisher once the last round
 * has results — the car's skin preview, "1st Place", the driver — and that row
 * is what the league screenshots for its trophy channel. Taking it from there
 * means the image says what ACSM says, ties and all.
 *
 * Measured on BATL's manager (2.4.15) across its finished championships:
 *
 *     <div class="car-skin-overview-container">
 *       <div class="entrant-car">
 *         <div class="card" style="background: #00cc00">          ← multi-class only
 *           <img src="/content/cars/<car>/skins/<skin>/preview.jpg">
 *           <div class="card-body">
 *             <small>Platinum</small><br>                          ← multi-class only
 *             1st Place
 *             <p><small>Driver Name<br></small></p>
 *
 * One row holds every class, in standings order within each; a single-class
 * championship has no class label and no card color. A championship nobody has
 * finished renders no row at all.
 */

import * as cheerio from "cheerio"

export interface PodiumPlace {
  /** 1-based, as ACSM numbered it. */
  place: number
  driver: string
  /** Path of the car's skin preview on the manager, e.g. `/content/cars/…/preview.jpg`. */
  preview: string
}

export interface PodiumClass {
  /** Empty for a single-class championship. */
  name: string
  /** The card color ACSM gives this class, when it gives one. */
  color?: string
  /** The top three, in order. Fewer when fewer finished. */
  places: PodiumPlace[]
}

/**
 * The podium per class, or why there isn't one.
 *
 * `absent`: no finishers row, which is a championship not yet finished.
 * `unrecognised`: a row that doesn't read as the layout above. Posting a
 * guessed podium to a trophy channel is worse than posting none.
 */
export function parsePodium(html: string): PodiumClass[] | "absent" | "unrecognised" {
  const $ = cheerio.load(html)
  const rows = $(".car-skin-overview-container")
  if (rows.length === 0) return "absent"
  if (rows.length !== 1) return "unrecognised"

  const classes: PodiumClass[] = []
  for (const card of rows.find(".entrant-car").toArray()) {
    const body = $(card).find(".card-body").first()
    const preview = $(card).find("img").first().attr("src") ?? ""
    const driver = body.find("p small").first().text().trim()
    const className = body.children("small").first().text().trim()
    const place = /(\d+)(?:st|nd|rd|th) Place/.exec(body.text())
    if (!place || !driver || !preview.startsWith("/content/")) return "unrecognised"

    let cls = classes.find((c) => c.name === className)
    if (!cls) {
      const color = /background:\s*(#[0-9a-fA-F]{3,8})/.exec(
        $(card).find(".card").first().attr("style") ?? "",
      )?.[1]
      cls = { name: className, ...(color ? { color } : {}), places: [] }
      classes.push(cls)
    }
    cls.places.push({ place: Number(place[1]), driver, preview })
  }
  if (classes.length === 0) return "unrecognised"

  for (const cls of classes) {
    cls.places.sort((a, b) => a.place - b.place)
    // A class whose places don't start at first is a row read wrongly.
    if (cls.places[0]?.place !== 1) return "unrecognised"
    cls.places = cls.places.filter((p) => p.place <= 3)
  }
  return classes
}
