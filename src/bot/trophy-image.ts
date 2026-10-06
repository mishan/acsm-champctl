/**
 * The trophy-room image: a class's top three as ACSM's own cards.
 *
 * Drawn rather than screenshotted. A screenshot needs a browser in the image
 * and a page that renders the same tomorrow; this needs the three skin previews
 * ACSM already serves publicly and a font. The look follows the cards on the
 * championship page — the car on a dark card, "1st Place", the driver under it —
 * because that is what the league has been posting by hand.
 */

import { createRequire } from "node:module"
import { dirname, join } from "node:path"

import { createCanvas, GlobalFonts, loadImage, type SKRSContext2D } from "@napi-rs/canvas"

import type { PodiumClass } from "./podium.js"

/** Drawn at twice ACSM's card size, so it stays sharp when Discord scales it. */
const SCALE = 2
const CARD_WIDTH = 250 * SCALE
const IMAGE_HEIGHT = Math.round((CARD_WIDTH * 575) / 1022)
const GAP = 12 * SCALE
const PAD = 12 * SCALE
const RADIUS = 4 * SCALE

/** ACSM's dark card, and the text on it. */
const CARD_COLOR = "#343a40"
const TEXT_COLOR = "#ffffff"
const NO_PREVIEW_COLOR = "#1c1f23"

let fontsLoaded = false

/**
 * Roboto, from the npm package, in the scripts names are written in. Registered
 * under one family so a name in Cyrillic or Greek still draws, rather than as
 * boxes on a trophy.
 */
function loadFonts(): void {
  if (fontsLoaded) return
  const require = createRequire(import.meta.url)
  const files = join(dirname(require.resolve("@fontsource/roboto/package.json")), "files")
  for (const subset of ["latin", "latin-ext", "cyrillic", "cyrillic-ext", "greek", "vietnamese"]) {
    for (const weight of ["400", "500"]) {
      GlobalFonts.registerFromPath(join(files, `roboto-${subset}-${weight}-normal.woff2`), "Roboto")
    }
  }
  fontsLoaded = true
}

function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`
}

/** Text that fits the card, shortened with an ellipsis rather than overrunning it. */
function fit(g: SKRSContext2D, text: string, width: number): string {
  if (g.measureText(text).width <= width) return text
  let s = text
  while (s.length > 1 && g.measureText(`${s}…`).width > width) s = s.slice(0, -1)
  return `${s}…`
}

function roundedRect(g: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath()
  g.moveTo(x + r, y)
  g.arcTo(x + w, y, x + w, y + h, r)
  g.arcTo(x + w, y + h, x, y + h, r)
  g.arcTo(x, y + h, x, y, r)
  g.arcTo(x, y, x + w, y, r)
  g.closePath()
}

/**
 * One class's podium as a PNG.
 *
 * `previews` lines up with `podium.places`; an entry that couldn't be fetched
 * is undefined and drawn as an empty dark panel, so one missing skin doesn't
 * cost the other two drivers their trophy.
 */
export async function renderPodium(
  podium: PodiumClass,
  previews: readonly (Uint8Array | undefined)[],
): Promise<Buffer> {
  loadFonts()
  const labelled = podium.name !== ""
  const lineHeight = 22 * SCALE
  const bodyHeight = PAD + (labelled ? lineHeight * 0.8 : 0) + lineHeight + lineHeight * 0.9 + PAD
  const cardHeight = IMAGE_HEIGHT + bodyHeight
  const count = Math.max(podium.places.length, 1)
  const canvas = createCanvas(count * CARD_WIDTH + (count - 1) * GAP, cardHeight)
  const g = canvas.getContext("2d")

  for (const [i, place] of podium.places.entries()) {
    const x = i * (CARD_WIDTH + GAP)

    g.save()
    roundedRect(g, x, 0, CARD_WIDTH, cardHeight, RADIUS)
    g.clip()
    g.fillStyle = podium.color ?? CARD_COLOR
    g.fillRect(x, 0, CARD_WIDTH, cardHeight)

    const bytes = previews[i]
    const image = bytes ? await loadImage(Buffer.from(bytes)).catch(() => undefined) : undefined
    if (image) {
      g.drawImage(image, x, 0, CARD_WIDTH, IMAGE_HEIGHT)
    } else {
      g.fillStyle = NO_PREVIEW_COLOR
      g.fillRect(x, 0, CARD_WIDTH, IMAGE_HEIGHT)
    }
    g.restore()

    g.fillStyle = TEXT_COLOR
    g.textAlign = "center"
    g.textBaseline = "middle"
    const centre = x + CARD_WIDTH / 2
    const inner = CARD_WIDTH - PAD * 2
    let y = IMAGE_HEIGHT + PAD + lineHeight / 2
    if (labelled) {
      g.font = `${13 * SCALE}px Roboto`
      g.fillText(fit(g, podium.name, inner), centre, y - lineHeight * 0.1)
      y += lineHeight * 0.8
    }
    g.font = `${16 * SCALE}px Roboto`
    g.fillText(`${ordinal(place.place)} Place`, centre, y)
    y += lineHeight * 0.95
    g.font = `500 ${13 * SCALE}px Roboto`
    g.fillText(fit(g, place.driver, inner), centre, y)
  }

  return canvas.toBuffer("image/png")
}
