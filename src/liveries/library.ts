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

import { readdir, readFile, stat } from "node:fs/promises"
import { extname, join, relative, sep } from "node:path"
import { unzipSync, zipSync, type Zippable } from "fflate"

import {
  ALLOWED_SKIN_EXTENSIONS,
  DEFAULT_LIMITS,
  forMessage,
  type Livery,
  LiveryPackError,
  type PackLimits,
  readSingleLivery,
  usableAsFolder,
} from "./pack.js"

export interface FoundSkin {
  carModel: string
  skinFolder: string
}

export interface SkinSource {
  skins: FoundSkin[]
  read(skin: FoundSkin, limits: PackLimits): Promise<Livery>
  /** Folders that couldn't be listed, so whatever skins they hold weren't seen. */
  unreadable: string[]
}

/** `<car>/skins/<folder>` out of a path, wherever in it they are. */
function skinIn(parts: readonly string[]): (FoundSkin & { depth: number }) | undefined {
  const at = parts.lastIndexOf("skins", parts.length - 2)
  if (at < 1) return undefined
  return { carModel: parts[at - 1]!, skinFolder: parts[at + 1]!, depth: at + 2 }
}

const key = (s: FoundSkin) => `${s.carModel}/${s.skinFolder}`

/**
 * Where a skin is, refusing one found in two places. A collection of several
 * seasons' folders holds the same car and folder twice, and which copy is the
 * right one isn't something to pick by listing order.
 */
function onlyPlace(skin: FoundSkin, places: ReadonlySet<string> | undefined): string {
  const [first, second] = [...(places ?? [])]
  if (second !== undefined) {
    throw new LiveryPackError(
      `Refusing ${forMessage(key(skin))}: it is in the source twice, at ` +
        `${forMessage(first!)} and ${forMessage(second)}. Remove one and import again.`,
    )
  }
  return first!
}

function addPlace(map: Map<string, Set<string>>, skin: FoundSkin, place: string): void {
  const set = map.get(key(skin)) ?? new Set<string>()
  set.add(place)
  map.set(key(skin), set)
}

/** A zip of skins, read one skin at a time so the whole collection is never unpacked at once. */
export function zipSource(bytes: Uint8Array): SkinSource {
  const prefixes = new Map<string, Set<string>>()
  const found = new Map<string, FoundSkin>()
  unzipSync(bytes, {
    filter: (file) => {
      const parts = file.name.split("/")
      const skin = skinIn(parts)
      // A file inside the folder, not the folder's own entry.
      if (skin && parts.length > skin.depth && parts[skin.depth] !== "") {
        const s = { carModel: skin.carModel, skinFolder: skin.skinFolder }
        found.set(key(s), s)
        addPlace(prefixes, s, `${parts.slice(0, skin.depth).join("/")}/`)
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
        onlyPlace(skin, prefixes.get(key(skin))),
      ),
    unreadable: [],
  }
}

/**
 * Skin folders under a directory, and where each is, without reading any of
 * their files.
 *
 * A folder that can't be listed is noted and passed over rather than ending
 * the walk. Node can't even name one whose name isn't UTF-8, and a player's
 * install collected over years has a few.
 */
export async function skinFolders(root: string): Promise<{
  skins: FoundSkin[]
  places: Map<string, Set<string>>
  unreadable: string[]
}> {
  const found = new Map<string, FoundSkin>()
  const places = new Map<string, Set<string>>()
  const unreadable: string[] = []
  const list = async (dir: string) => {
    try {
      return await readdir(dir, { withFileTypes: true })
    } catch {
      unreadable.push(dir)
      return []
    }
  }
  const walk = async (dir: string, depth: number): Promise<void> => {
    for (const entry of await list(dir)) {
      if (!entry.isDirectory()) continue
      const path = join(dir, entry.name)
      if (entry.name === "skins" && depth > 0) {
        const carModel = dir.split(sep).pop()!
        for (const folder of await list(path)) {
          if (!folder.isDirectory()) continue
          const s = { carModel, skinFolder: folder.name }
          found.set(key(s), s)
          addPlace(places, s, join(path, folder.name))
        }
      } else if (depth < 4) {
        await walk(path, depth + 1)
      }
    }
  }
  await walk(root, 0)
  const skins = [...found.values()].sort((a, b) => key(a).localeCompare(key(b)))
  return { skins, places, unreadable }
}

/** A directory of skins, such as an install's `content/cars`. */
export async function dirSource(root: string): Promise<SkinSource> {
  const { skins, places, unreadable } = await skinFolders(root)
  return {
    skins,
    unreadable,
    read: async (skin, limits) => {
      const folder = onlyPlace(skin, places.get(key(skin)))
      // Zipped so the folder goes through exactly the checks an upload does.
      // Files a skin doesn't use are entered empty rather than read: they are
      // left out either way, and some are hundreds of megabytes of .psd. A
      // file over the limit is refused before it is read, for the same reason.
      const files: Zippable = {}
      try {
        for (const entry of await readdir(folder, { recursive: true, withFileTypes: true })) {
          if (!entry.isFile()) continue
          const path = join(entry.parentPath, entry.name)
          const name = relative(folder, path).split(sep).join("/")
          const used = ALLOWED_SKIN_EXTENSIONS.has(extname(entry.name).toLowerCase())
          if (used && (await stat(path)).size > limits.maxFileBytes) {
            throw new LiveryPackError(
              `Refusing ${forMessage(key(skin))}: "${forMessage(name)}" is over the ` +
                `${Math.round(limits.maxFileBytes / 2 ** 20)} MB limit for one file.`,
            )
          }
          files[name] = [used ? await readFile(path) : new Uint8Array(0), { level: 0 }]
        }
      } catch (e) {
        if (e instanceof LiveryPackError) throw e
        throw new LiveryPackError(
          `Refusing ${forMessage(key(skin))}: couldn't read ${forMessage(folder)} ` +
            `(${(e as NodeJS.ErrnoException).code ?? String(e)}).`,
        )
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
    if (![skin.carModel, skin.skinFolder].every((n) => usableAsFolder(n.normalize("NFC")))) {
      // Said here, because the upload path's refusal blames the entry list.
      yield {
        kind: "refused",
        skin,
        reason:
          `Refusing ${forMessage(key(skin))}: champctl can't make that a folder on the server. ` +
          `Rename it and import again.`,
      }
    } else if (stock && !original) {
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
  for (const skin of (await skinFolders(root)).skins) {
    const set = stock.get(skin.carModel) ?? new Set<string>()
    set.add(skin.skinFolder)
    stock.set(skin.carModel, set)
  }
  return stock
}
