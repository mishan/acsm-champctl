/**
 * Skins collected before champctl, read into its store.
 *
 * Leagues have kept these by hand: a shared folder of past seasons' liveries,
 * or a player's own Assetto Corsa install. Either is a tree with
 * `<car>/skins/<folder>/` somewhere in it, as a zip or on disk. Each skin goes
 * through the same checks as a driver's upload.
 *
 * Such a tree also holds the skins that came with each car, which drivers
 * already have and which would multiply the carset several times over. Nothing
 * in a skin says which it is, so the car's original download is the reference:
 * a folder in it is stock, and a car with no original to compare against is
 * left out rather than guessed at.
 */

import { readdir, readFile } from "node:fs/promises"
import { extname, join, relative, sep } from "node:path"
import { unzipSync, zipSync, type Zippable } from "fflate"

import {
  ALLOWED_SKIN_EXTENSIONS,
  DEFAULT_LIMITS,
  type Livery,
  LiveryPackError,
  type PackLimits,
  readSingleLivery,
} from "./pack.js"

export interface FoundSkin {
  carModel: string
  skinFolder: string
}

export interface SkinSource {
  skins: FoundSkin[]
  read(skin: FoundSkin, limits: PackLimits): Promise<Livery>
}

/** `<car>/skins/<folder>` out of a path, wherever in it they are. */
function skinIn(parts: readonly string[]): (FoundSkin & { depth: number }) | undefined {
  const at = parts.lastIndexOf("skins", parts.length - 2)
  if (at < 1) return undefined
  return { carModel: parts[at - 1]!, skinFolder: parts[at + 1]!, depth: at + 2 }
}

const key = (s: FoundSkin) => `${s.carModel}/${s.skinFolder}`

/** A zip of skins, read one skin at a time so the whole collection is never unpacked at once. */
export function zipSource(bytes: Uint8Array): SkinSource {
  const prefixes = new Map<string, string>()
  const found = new Map<string, FoundSkin>()
  unzipSync(bytes, {
    filter: (file) => {
      const parts = file.name.split("/")
      const skin = skinIn(parts)
      // A file inside the folder, not the folder's own entry.
      if (skin && parts.length > skin.depth && parts[skin.depth] !== "") {
        const s = { carModel: skin.carModel, skinFolder: skin.skinFolder }
        found.set(key(s), s)
        prefixes.set(key(s), `${parts.slice(0, skin.depth).join("/")}/`)
      }
      return false
    },
  })
  return {
    skins: [...found.values()].sort((a, b) => key(a).localeCompare(key(b))),
    read: async (skin, limits) =>
      readSingleLivery(
        bytes,
        { carModel: skin.carModel, driverName: skin.skinFolder },
        limits,
        prefixes.get(key(skin)),
      ),
  }
}

/** Skin folders under a directory, and where each is, without reading any of their files. */
export async function skinFolders(root: string): Promise<(FoundSkin & { path: string })[]> {
  const found = new Map<string, FoundSkin & { path: string }>()
  const walk = async (dir: string, depth: number): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(dir, entry.name)
      if (entry.name === "skins" && depth > 0) {
        const carModel = dir.split(sep).pop()!
        for (const folder of await readdir(path, { withFileTypes: true })) {
          if (!folder.isDirectory()) continue
          const s = { carModel, skinFolder: folder.name, path: join(path, folder.name) }
          found.set(key(s), s)
        }
      } else if (depth < 4) {
        await walk(path, depth + 1)
      }
    }
  }
  await walk(root, 0)
  return [...found.values()].sort((a, b) => key(a).localeCompare(key(b)))
}

/** A directory of skins, such as an install's `content/cars`. */
export async function dirSource(root: string): Promise<SkinSource> {
  const found = await skinFolders(root)
  const where = new Map(found.map((s) => [key(s), s.path]))
  return {
    skins: found.map(({ carModel, skinFolder }) => ({ carModel, skinFolder })),
    read: async (skin, limits) => {
      const folder = where.get(key(skin))!
      // Zipped so the folder goes through exactly the checks an upload does.
      // Files a skin doesn't use are entered empty rather than read: they are
      // left out either way, and some are hundreds of megabytes of .psd.
      const files: Zippable = {}
      for (const entry of await readdir(folder, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue
        const path = join(entry.parentPath, entry.name)
        const name = relative(folder, path).split(sep).join("/")
        const used = ALLOWED_SKIN_EXTENSIONS.has(extname(entry.name).toLowerCase())
        files[name] = [used ? await readFile(path) : new Uint8Array(0), { level: 0 }]
      }
      return readSingleLivery(
        zipSync(files),
        { carModel: skin.carModel, driverName: skin.skinFolder },
        limits,
      )
    },
  }
}

export type Imported =
  | { kind: "livery"; livery: Livery }
  | { kind: "stock"; skin: FoundSkin }
  | { kind: "no original"; skin: FoundSkin }
  | { kind: "refused"; skin: FoundSkin; reason: string }

/**
 * Each skin in a source, read or set aside.
 *
 * `stock` maps a car to the folders its original download has. When it is
 * given, a car missing from it is set aside: there is nothing to say which of
 * its skins came with it.
 */
export async function* importSkins(
  source: SkinSource,
  stock?: ReadonlyMap<string, ReadonlySet<string>>,
  limits: PackLimits = DEFAULT_LIMITS,
): AsyncGenerator<Imported> {
  for (const skin of source.skins) {
    const original = stock?.get(skin.carModel)
    if (stock && !original) {
      yield { kind: "no original", skin }
    } else if (original?.has(skin.skinFolder)) {
      yield { kind: "stock", skin }
    } else {
      try {
        yield { kind: "livery", livery: await source.read(skin, limits) }
      } catch (e) {
        if (!(e instanceof LiveryPackError)) throw e
        yield { kind: "refused", skin, reason: e.message }
      }
    }
  }
}

/** Each car's original skin folders, from a directory of original car downloads. */
export async function stockFrom(root: string): Promise<Map<string, Set<string>>> {
  const stock = new Map<string, Set<string>>()
  for (const skin of await skinFolders(root)) {
    const set = stock.get(skin.carModel) ?? new Set<string>()
    set.add(skin.skinFolder)
    stock.set(skin.carModel, set)
  }
  return stock
}
