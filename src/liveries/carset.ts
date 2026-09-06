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
 * `carsetDigest` hashes what is in the archive rather than the archive. A zip's
 * own bytes depend on the order entries were added and on the builder's
 * timezone, since DOS timestamps are written from local-time getters — so
 * hashing the archive would make "has the carset changed" answer yes after a
 * rebuild that changed nothing. Hashing the content is stable against both,
 * which is what makes it usable as an ETag and what stops a rebuild looking
 * like a new carset to everyone holding the old one.
 *
 * It is also computed from *metadata alone*: the store already holds a content
 * digest per livery, so `carsetPlan` can answer "which carset is this" without
 * reading a single blob. That is the difference between a cache hit costing a
 * `stat` and costing four hundred megabytes of SQLite reads and a SHA-256 pass,
 * on every request, including the 304s.
 *
 * ## Building never holds the archive
 *
 * `writeCarset` streams: one livery's files are read, pushed into the zip and
 * dropped before the next livery is fetched. Thirty drivers is a few hundred
 * megabytes and the old builder held all of it, plus a second copy as the
 * assembled archive, before writing a byte.
 */

import { createHash } from "node:crypto"
import type { Writable } from "node:stream"
import { PassThrough } from "node:stream"
import { pipeline } from "node:stream/promises"

import { Zip, ZipPassThrough } from "fflate"

import type { SkinFile } from "./pack.js"
import type { StoredLivery } from "./store.js"

/**
 * The timestamp every entry in a carset carries.
 *
 * Fixed, so that rebuilding an unchanged carset produces the same bytes and a
 * driver who re-downloads gets the file they already have. What it does not buy
 * is byte-identity across machines: fflate writes the DOS date from local-time
 * getters, so an operator in London and one in Melbourne still produce
 * different archives from the same store. That is why identity is the content
 * digest and not a hash of the file — see the module header. Mid-1980 so that
 * no timezone can push it below the 1980 floor a DOS timestamp can represent.
 */
const CARSET_MTIME = new Date("1980-06-15T12:00:00Z")

/** One skin in the carset, as the driver will see it on disk. */
export interface CarsetSkinRef {
  carModel: string
  skinFolder: string
  driverName: string
  /** `content/cars/<model>/skins/<folder>`, the path inside the archive. */
  path: string
  /** The store's content digest for this livery. */
  digest: string
  bytes: number
  fileCount: number
}

export interface CarsetPlan {
  championshipId: string
  championshipName?: string
  /** Ordered by car then driver — the store's own order, and the archive's. */
  skins: CarsetSkinRef[]
  /** Distinct car models, in the order they appear. */
  cars: string[]
  bytes: number
  /** Content digest. Stable across rebuilds, and readable without the blobs. */
  digest: string
}

export interface CarsetResult {
  digest: string
  /** The archive's size, once written. */
  bytes: number
  skins: number
  /**
   * Drivers whose skin has no `preview.jpg`.
   *
   * Not an error. A livery without a preview races perfectly well; it just
   * shows as a blank tile in Content Manager's skin list, which looks like a
   * broken download to whoever installed it. Worth saying once at build time
   * rather than fielding the question later.
   *
   * Only knowable from the files, so it comes out of a build and never out of a
   * plan.
   */
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
export function carsetDigest(skins: readonly CarsetSkinRef[]): string {
  const hash = createHash("sha256")
  for (const skin of skins) {
    hash.update(`${skin.path}\u0000${skin.digest}\n`)
  }
  return hash.digest("hex")
}

export interface BuildCarsetOptions {
  championshipName?: string
}

/**
 * What the carset would contain, from metadata only.
 *
 * Deliberately does no filtering. Everything the store holds for a championship
 * goes in, including liveries for drivers who have since left — someone
 * watching a replay or racing an old server still needs those cars to look
 * right, and a carset that quietly shed skins as the entry list churned would
 * be a support question every month.
 *
 * Order is the store's: car, then driver. Both this and `writeCarset` walk it,
 * so the digest describes the archive that would be built from the same rows.
 */
export function carsetPlan(
  championshipId: string,
  liveries: readonly StoredLivery[],
  options: BuildCarsetOptions = {},
): CarsetPlan {
  const skins: CarsetSkinRef[] = liveries.map((livery) => ({
    carModel: livery.carModel,
    skinFolder: livery.skinFolder,
    driverName: livery.driverName,
    path: skinPath(livery.carModel, livery.skinFolder),
    digest: livery.digest,
    bytes: livery.bytes,
    fileCount: livery.fileCount,
  }))

  return {
    championshipId,
    ...(options.championshipName !== undefined
      ? { championshipName: options.championshipName }
      : {}),
    skins,
    cars: [...new Set(skins.map((s) => s.carModel))],
    bytes: skins.reduce((n, s) => n + s.bytes, 0),
    digest: carsetDigest(skins),
  }
}

/**
 * The header of the plain-text list shipped inside the archive.
 *
 * Content Manager's install is not guaranteed to replace a file that is already
 * there, and the failure looks like nothing at all: a driver re-installs, keeps
 * the old artwork, and sees a stale car. The manifest gives them something to
 * check by hand — and gives whoever is answering the question in Discord
 * something to ask for.
 *
 * Outside `content/` so CM has no reason to install it anywhere.
 */
export function manifestHeader(plan: CarsetPlan): string[] {
  return [
    `# ${plan.championshipName ?? plan.championshipId}`,
    `# ${plan.skins.length} liveries across ${plan.cars.length} cars`,
    `# carset ${plan.digest}`,
    "#",
    "# Extract over your Assetto Corsa folder, or drop this zip on Content Manager.",
    "# If a livery looks out of date after installing, delete that skin folder and",
    "# install again — the digests below are what you should have.",
    "",
  ]
}

/** Lets the sink catch up before the next livery is pulled out of the store. */
async function drained(stream: PassThrough): Promise<void> {
  if (!stream.writableNeedDrain) return
  await new Promise<void>((resolve) => stream.once("drain", resolve))
}

/**
 * Writes the archive, one livery at a time.
 *
 * `filesFor` is called per skin and its result is dropped as soon as it has
 * been pushed, so the high-water mark is one driver's files rather than the
 * whole carset. A thirty-driver pack is a few hundred megabytes; one held in
 * the heap per request is how a league's VPS dies on the evening everyone
 * downloads at once.
 *
 * Stored, not deflated. Every meaningful byte in here is a `.dds` or a `.jpg`,
 * both already compressed, so deflate would spend CPU on a rebuild of a few
 * hundred megabytes to save approximately nothing. The one exception is the
 * manifest, which is too small to matter — and which is written last, because
 * it lists digests only known once the files have been read.
 */
export async function writeCarset(
  destination: Writable,
  plan: CarsetPlan,
  filesFor: (skin: CarsetSkinRef) => Promise<SkinFile[]>,
): Promise<CarsetResult> {
  const out = new PassThrough()
  const finished = pipeline(out, destination)

  let bytes = 0
  const zip = new Zip((err, chunk, final) => {
    if (err) {
      out.destroy(err)
      return
    }
    bytes += chunk.length
    out.write(chunk)
    if (final) out.end()
  })

  const missingPreviews: string[] = []
  const manifest = manifestHeader(plan)

  try {
    for (const skin of plan.skins) {
      const files = [...(await filesFor(skin))].sort(byName)
      if (!files.some((f) => f.name.toLowerCase() === "preview.jpg")) {
        missingPreviews.push(skin.driverName)
      }
      for (const file of files) {
        manifest.push(`${digestOf(file.bytes)}  ${skin.path}/${file.name}`)
        const entry = new ZipPassThrough(`${skin.path}/${file.name}`)
        entry.mtime = CARSET_MTIME
        zip.add(entry)
        entry.push(file.bytes, true)
      }
      await drained(out)
    }

    const notes = new ZipPassThrough("carset.txt")
    notes.mtime = CARSET_MTIME
    zip.add(notes)
    notes.push(new TextEncoder().encode(`${manifest.join("\n")}\n`), true)
    zip.end()
  } catch (e) {
    out.destroy(e instanceof Error ? e : new Error(String(e)))
    throw e
  }

  await finished
  return { digest: plan.digest, bytes, skins: plan.skins.length, missingPreviews }
}

/** A filename a driver can tell apart from last month's. */
export function carsetFilename(plan: CarsetPlan): string {
  const name = (plan.championshipName ?? "carset")
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
  return `${name || "carset"}-${plan.digest.slice(0, 8)}.zip`
}
