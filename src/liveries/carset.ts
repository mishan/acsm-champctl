/**
 * The carset: every livery champctl has applied to a championship, as one
 * archive a driver can drop on Content Manager
 * (docs/discord-livery-upload.md §6).
 *
 * A livery on the server is half the job. Everyone else on the grid needs the
 * files too, or they see the default skin where a car should be — which is why
 * leagues maintain a carset archive by hand, and why champctl keeping the bytes
 * is only useful if it can hand them back in the shape the game expects.
 *
 * ## The layout is the whole feature
 *
 * ```
 * content/cars/<car_model>/skins/<skin_folder>/livery.dds
 * ```
 *
 * Top-level `content/`, so Content Manager can drop the tree onto the Assetto
 * Corsa root — and so that a driver whose CM install misbehaves can extract the
 * same archive over their AC directory by hand and get an identical result. It
 * is the shape leagues already distribute carsets in.
 *
 * `skinFolder` is load-bearing three times over: ACSM creates the folder from
 * it, `Entrant.Skin` is set to it, and the carset writes it here. If this one
 * disagreed with the other two, every driver would install successfully and
 * still see the default livery, because the game would be looking in a folder
 * that does not exist — a failure with no error message anywhere in it.
 *
 * ## Identity is content, not bytes
 *
 * `carsetDigest` hashes the manifest rather than the archive. A zip's own bytes
 * depend on the order entries were added and on the builder's timezone, since
 * DOS timestamps are written from local-time getters — so hashing the archive
 * would make "has the carset changed" answer yes after a rebuild that changed
 * nothing. The manifest is stable against both, which is what makes it usable
 * as an ETag and what stops a rebuild looking like a new carset to everyone
 * holding the old one.
 */

import { createHash } from "node:crypto"
import { zipSync } from "fflate"
import type { SkinFile } from "./pack.js"
import type { StoredLiveryWithFiles } from "./store.js"

/** One skin in the carset, as the driver will see it on disk. */
export interface CarsetSkin {
  carModel: string
  skinFolder: string
  driverName: string
  /** `content/cars/<model>/skins/<folder>`, the path inside the archive. */
  path: string
  files: SkinFile[]
  bytes: number
  /**
   * True when the skin has no `preview.jpg`.
   *
   * Not an error. A livery without a preview races perfectly well; it just
   * shows as a blank tile in Content Manager's skin list, which looks like a
   * broken download to the driver who installed it. Worth saying once at build
   * time rather than fielding the question later.
   */
  missingPreview: boolean
}

export interface Carset {
  championshipId: string
  championshipName?: string
  skins: CarsetSkin[]
  /** Distinct car models, in the order they appear. */
  cars: string[]
  bytes: number
  /** Content digest — see the module header. Stable across rebuilds. */
  digest: string
  /** Skins with no `preview.jpg`, by driver name. */
  missingPreviews: string[]
}

/** Where AC expects a car skin to live, relative to the game root. */
export function skinPath(carModel: string, skinFolder: string): string {
  return `content/cars/${carModel}/skins/${skinFolder}`
}

const byName = (a: SkinFile, b: SkinFile) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

function digestOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/**
 * The carset's identity.
 *
 * Built from the archive paths rather than from car and driver separately, so
 * that a change which only moves a skin — a driver renamed in the entry list,
 * say — still reads as a different carset. It is: every other driver has to
 * re-install to get the folder AC will now look for.
 */
export function carsetDigest(skins: readonly CarsetSkin[]): string {
  const hash = createHash("sha256")
  for (const skin of skins) {
    for (const file of [...skin.files].sort(byName)) {
      hash.update(`${skin.path}/${file.name}\u0000${digestOf(file.bytes)}\n`)
    }
  }
  return hash.digest("hex")
}

export interface BuildCarsetOptions {
  championshipName?: string
}

/**
 * Arranges stored liveries into a carset.
 *
 * Deliberately does no filtering. Everything the store holds for a championship
 * goes in, including liveries for drivers who have since left — someone
 * watching a replay or racing an old server still needs those cars to look
 * right, and a carset that quietly shed skins as the entry list churned would
 * be a support question every month.
 */
export function buildCarset(
  championshipId: string,
  liveries: readonly StoredLiveryWithFiles[],
  options: BuildCarsetOptions = {},
): Carset {
  // Sorted by where the files land, not by when they were applied. Two carsets
  // holding the same skins are then the same carset whatever order the store
  // returned them in, which is what `digest` needs to be worth anything.
  const skins: CarsetSkin[] = liveries
    .map((livery) => {
      const files = [...livery.files].sort(byName)
      return {
        carModel: livery.carModel,
        skinFolder: livery.skinFolder,
        driverName: livery.driverName,
        path: skinPath(livery.carModel, livery.skinFolder),
        files,
        bytes: files.reduce((n, f) => n + f.bytes.length, 0),
        missingPreview: !files.some((f) => f.name.toLowerCase() === "preview.jpg"),
      }
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  return {
    championshipId,
    ...(options.championshipName !== undefined
      ? { championshipName: options.championshipName }
      : {}),
    skins,
    cars: [...new Set(skins.map((s) => s.carModel))],
    bytes: skins.reduce((n, s) => n + s.bytes, 0),
    digest: carsetDigest(skins),
    missingPreviews: skins.filter((s) => s.missingPreview).map((s) => s.driverName),
  }
}

/**
 * A plain-text list of what is in the archive, shipped inside it.
 *
 * Content Manager's install is not guaranteed to replace a file that is already
 * there, and the failure looks like nothing at all: a driver re-installs, keeps
 * the old artwork, and sees a stale car. The manifest gives them something to
 * check by hand — and gives whoever is answering the question in Discord
 * something to ask for.
 *
 * Outside `content/` so CM has no reason to install it anywhere.
 */
export function carsetManifest(carset: Carset): string {
  const lines = [
    `# ${carset.championshipName ?? carset.championshipId}`,
    `# ${carset.skins.length} liveries across ${carset.cars.length} cars`,
    `# carset ${carset.digest}`,
    "#",
    "# Extract over your Assetto Corsa folder, or drop this zip on Content Manager.",
    "# If a livery looks out of date after installing, delete that skin folder and",
    "# install again — the digests below are what you should have.",
    "",
  ]
  for (const skin of carset.skins) {
    for (const file of skin.files) {
      lines.push(`${digestOf(file.bytes)}  ${skin.path}/${file.name}`)
    }
  }
  return `${lines.join("\n")}\n`
}

/**
 * The archive itself.
 *
 * `level: 0`. Every meaningful byte in here is a `.dds` or a `.jpg`, both
 * already compressed, so deflate spends CPU on a rebuild of a few hundred
 * megabytes to save approximately nothing. The one exception is the manifest,
 * which is too small to matter.
 */
export function carsetZip(carset: Carset): Uint8Array {
  const entries: Record<string, Uint8Array> = {}
  for (const skin of carset.skins) {
    for (const file of skin.files) {
      entries[`${skin.path}/${file.name}`] = file.bytes
    }
  }
  entries["carset.txt"] = new TextEncoder().encode(carsetManifest(carset))
  return zipSync(entries, { level: 0 })
}

/** A filename a driver can tell apart from last month's. */
export function carsetFilename(carset: Carset): string {
  const name = (carset.championshipName ?? "carset")
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
  return `${name || "carset"}-${carset.digest.slice(0, 8)}.zip`
}
