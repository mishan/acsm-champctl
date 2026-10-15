/**
 * The fonts champctl draws with, for the trophy images and the incident videos.
 */

import { createRequire } from "node:module"
import { dirname, join } from "node:path"

import { GlobalFonts } from "@napi-rs/canvas"

let fontsLoaded = false

/**
 * Roboto, from the npm package, in the scripts names are written in. Registered
 * under one family so a name in Cyrillic or Greek still draws, rather than as
 * boxes.
 */
export function loadFonts(): void {
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
