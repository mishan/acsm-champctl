/**
 * Reading a livery pack, and refusing the ones that shouldn't be uploaded.
 *
 * A pack is a zip of zips:
 *
 *     rss_formula_hybrid_2021/Misha.zip
 *     rss_formula_hybrid_2021/postaL.zip
 *     ford_transit/someone.zip
 *
 * The outer directory is the **car model**, which is what
 * `POST /car/{model}/skin` needs, and each inner zip is one driver's skin
 * folder. The inner zip's filename minus `.zip` is both the driver name to
 * match against the entry list and the skin folder to create.
 *
 * **Everything in here is untrusted.** Today a person hands Misha a zip; the
 * plan is for a Discord bot to take them straight from drivers, at which point
 * whatever arrives goes to the server with no human between. So this module's
 * job is not "unpack a zip", it is "decide whether this is a livery" — and it
 * fails the whole pack rather than uploading a subset, because a livery drop
 * that half-happened is worse to unpick than one that didn't.
 *
 * The specific thing ACSM does with what we send, from `CarManager.UploadSkin`:
 *
 *     content/cars/{car}/skins/<filepath.Dir(header.Filename)>/<filepath.Base(...)>
 *
 * `filepath.Dir` is not sanitised there, so a filename carrying `..` writes
 * outside the skins directory — on the league's game server, as whatever user
 * runs it. champctl builds those filenames, so this is the module that has to
 * be sure of them.
 */

import { unzipSync } from "fflate"

export class LiveryPackError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LiveryPackError"
  }
}

/**
 * What an Assetto Corsa skin folder is allowed to contain.
 *
 * An allowlist rather than a blocklist of `.psd` and friends: the interesting
 * case is not the file type someone forgot to delete, it is the one nobody
 * thought of. `.dds` is the livery, `.png`/`.jpg` the preview, `.json` the
 * `ui_skin.json`, `.ini` a `skin.ini`, `.txt` a readme nobody reads.
 */
export const ALLOWED_SKIN_EXTENSIONS: ReadonlySet<string> = new Set([
  ".dds",
  ".png",
  ".jpg",
  ".jpeg",
  ".json",
  ".ini",
  ".txt",
])

/**
 * Extensions worth naming in the refusal rather than lumping in with "not
 * allowed", because they are the ones people actually leave behind and the
 * message may be read by a driver rather than by an admin.
 */
const EXPLAINED_EXTENSIONS: Record<string, string> = {
  ".psd": "a Photoshop source file",
  ".xcf": "a GIMP source file",
  ".ai": "an Illustrator source file",
  ".tif": "an uncompressed source image",
  ".tiff": "an uncompressed source image",
  ".zip": "another zip",
  ".rar": "an archive",
  ".7z": "an archive",
  ".exe": "an executable",
  ".dll": "an executable",
  ".bat": "a script",
  ".cmd": "a script",
  ".sh": "a script",
  ".ps1": "a script",
}

export interface PackLimits {
  /** One file inside a skin. Default 24 MB — a 4K DDS with mipmaps fits. */
  maxFileBytes: number
  /** One driver's whole skin folder. Default 64 MB. */
  maxSkinBytes: number
  /** Everything, uncompressed. The zip-bomb ceiling. Default 512 MB. */
  maxTotalBytes: number
  /** Files in one skin folder. Default 40. */
  maxFilesPerSkin: number
  /** Skins in one pack. Default 100. */
  maxSkins: number
}

export const DEFAULT_LIMITS: PackLimits = {
  maxFileBytes: 24 * 1024 * 1024,
  maxSkinBytes: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxFilesPerSkin: 40,
  maxSkins: 100,
}

export interface SkinFile {
  /** Base name only. No directory component, ever — see `assertSafeName`. */
  name: string
  bytes: Uint8Array
}

export interface Livery {
  /** The outer directory: the ACSM car model this skin belongs to. */
  carModel: string
  /** The inner zip's name without `.zip`. Matched against the entrant Name. */
  driverName: string
  /** The skin folder to create under `content/cars/{carModel}/skins/`. */
  skinFolder: string
  files: SkinFile[]
  totalBytes: number
}

export interface LiveryPack {
  liveries: Livery[]
  totalBytes: number
}

/**
 * A path component ACSM can be handed without it meaning something else.
 *
 * `..` and `/` are the ones that matter — those reach `filepath.Dir` and write
 * outside the skins directory. The rest is a narrower rule than the filesystem
 * would enforce, on purpose: these names are chosen by whoever zipped the file,
 * and a driver name is going to be a driver name.
 */
const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9 ._'()#+-]{0,63}$/

function assertSafeName(kind: string, value: string, where: string): void {
  if (value === "." || value === "..") {
    throw new LiveryPackError(`${where}: "${value}" is not a usable ${kind}.`)
  }
  if (!SAFE_COMPONENT.test(value)) {
    throw new LiveryPackError(
      `${where}: "${value}" is not a usable ${kind}. It has to start with a letter or digit and ` +
        `hold only letters, digits, spaces and . _ ' ( ) # + - — champctl builds a file path out ` +
        `of it and hands that to the game server.`,
    )
  }
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".")
  return dot <= 0 ? "" : name.slice(dot).toLowerCase()
}

/**
 * Splits a zip entry path, rejecting anything that isn't a plain relative path.
 *
 * Backslashes count as separators. Some Windows zip tools write them, and a
 * name like `..\evil.dds` is one separator away from a traversal — Go's
 * `filepath.Dir` on Linux would leave it as a single filename, but the check is
 * cheap and the failure is not.
 */
function splitEntryPath(path: string): string[] {
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    throw new LiveryPackError(`Refusing "${path}": absolute paths are not allowed in a pack.`)
  }
  const parts = path.split(/[/\\]/).filter((p) => p !== "" && p !== ".")
  if (parts.some((p) => p === "..")) {
    throw new LiveryPackError(
      `Refusing "${path}": it climbs out of the pack with "..". ACSM writes an uploaded skin to ` +
        `a path built from this name and does not sanitise it.`,
    )
  }
  return parts
}

/** `unzipSync`, with its failures turned into something a person can act on. */
function unzip(bytes: Uint8Array, what: string): Record<string, Uint8Array> {
  try {
    return unzipSync(bytes)
  } catch (e) {
    throw new LiveryPackError(
      `${what} could not be read as a zip: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}

/**
 * Reads a pack, or explains why it isn't one.
 *
 * Throws on the first problem rather than collecting them. Two reasons: the
 * upload is all-or-nothing anyway, and a driver reading "your livery was
 * rejected" wants the reason, not a report.
 */
export function readLiveryPack(
  packBytes: Uint8Array,
  limits: PackLimits = DEFAULT_LIMITS,
): LiveryPack {
  const outer = unzip(packBytes, "The pack")
  const liveries: Livery[] = []
  let totalBytes = 0

  // Sorted, so a pack produces the same plan whatever order the zip happens to
  // list its entries in. A preview that reorders between runs is one nobody
  // reads twice.
  for (const path of Object.keys(outer).sort()) {
    const bytes = outer[path]
    if (!bytes) continue
    const parts = splitEntryPath(path)
    // A directory entry, which zips carry as a zero-length name ending in "/".
    if (parts.length === 0 || path.endsWith("/")) continue

    if (parts.length !== 2) {
      throw new LiveryPackError(
        `Refusing "${path}": a pack holds car_model/driverName.zip and nothing else. ` +
          `${parts.length === 1 ? "This is at the top level rather than inside a car folder." : "This is nested too deeply."}`,
      )
    }

    const [carModel, fileName] = parts as [string, string]
    if (extensionOf(fileName) !== ".zip") {
      throw new LiveryPackError(
        `Refusing "${path}": every entry inside a car folder has to be a driver's zip. ` +
          `Put the skin's files in <driver>.zip rather than loose in the folder.`,
      )
    }

    const driverName = fileName.slice(0, -".zip".length)
    assertSafeName("car model", carModel, `in "${path}"`)
    assertSafeName("driver name", driverName, `in "${path}"`)

    if (liveries.length >= limits.maxSkins) {
      throw new LiveryPackError(
        `Refusing the pack: more than ${limits.maxSkins} liveries in one file.`,
      )
    }

    const livery = readOneLivery(carModel, driverName, bytes, limits, path)
    totalBytes += livery.totalBytes
    if (totalBytes > limits.maxTotalBytes) {
      throw new LiveryPackError(
        `Refusing the pack: it unpacks to more than ${mb(limits.maxTotalBytes)}, which is a lot ` +
          `more than a set of liveries and is what a zip bomb looks like.`,
      )
    }
    liveries.push(livery)
  }

  if (liveries.length === 0) {
    throw new LiveryPackError(
      `No liveries in the pack. It should hold car_model/driverName.zip entries, for example ` +
        `rss_formula_hybrid_2021/Misha.zip.`,
    )
  }

  const duplicate = firstDuplicate(liveries.map((l) => `${l.carModel}/${l.driverName}`))
  if (duplicate) {
    throw new LiveryPackError(`Refusing the pack: ${duplicate} appears more than once.`)
  }

  return { liveries, totalBytes }
}

function readOneLivery(
  carModel: string,
  driverName: string,
  innerBytes: Uint8Array,
  limits: PackLimits,
  where: string,
): Livery {
  const inner = unzip(innerBytes, `"${where}"`)
  const files: SkinFile[] = []
  let totalBytes = 0

  // A skin folder is flat. Both shapes turn up in practice — the files at the
  // root of the zip, or wrapped in one folder because of how the person zipped
  // it — so a single common root directory is stripped and anything deeper is
  // refused. Guessing further would mean deciding which of several folders is
  // the skin, and the answer to that is "ask, don't guess".
  const entries = Object.entries(inner)
    .filter(([path, bytes]) => !path.endsWith("/") && bytes.length >= 0)
    .map(([path, bytes]) => ({ parts: splitEntryPath(path), bytes, path }))
    .filter((e) => e.parts.length > 0)
    .sort((a, b) => a.path.localeCompare(b.path))

  const roots = new Set(entries.filter((e) => e.parts.length > 1).map((e) => e.parts[0]!))
  const wrapped = entries.length > 0 && entries.every((e) => e.parts.length > 1) && roots.size === 1

  for (const entry of entries) {
    const parts = wrapped ? entry.parts.slice(1) : entry.parts
    if (parts.length !== 1) {
      throw new LiveryPackError(
        `Refusing ${carModel}/${driverName}: "${entry.path}" is in a subfolder. An Assetto Corsa ` +
          `skin is a flat folder of files.`,
      )
    }
    const name = parts[0]!
    assertSafeName("file name", name, `in ${carModel}/${driverName}`)

    const ext = extensionOf(name)
    if (!ALLOWED_SKIN_EXTENSIONS.has(ext)) {
      const explained = EXPLAINED_EXTENSIONS[ext]
      throw new LiveryPackError(
        `Refusing ${carModel}/${driverName}: "${name}" is ${explained ?? `not something a skin needs`}. ` +
          `A skin folder holds ${[...ALLOWED_SKIN_EXTENSIONS].join(", ")} files — delete the rest ` +
          `and zip it again.`,
      )
    }

    if (entry.bytes.length > limits.maxFileBytes) {
      throw new LiveryPackError(
        `Refusing ${carModel}/${driverName}: "${name}" is ${mb(entry.bytes.length)}, over the ` +
          `${mb(limits.maxFileBytes)} limit for one file.`,
      )
    }

    files.push({ name, bytes: entry.bytes })
    totalBytes += entry.bytes.length

    if (files.length > limits.maxFilesPerSkin) {
      throw new LiveryPackError(
        `Refusing ${carModel}/${driverName}: more than ${limits.maxFilesPerSkin} files. A skin is ` +
          `a livery, a preview and a couple of small text files.`,
      )
    }
    if (totalBytes > limits.maxSkinBytes) {
      throw new LiveryPackError(
        `Refusing ${carModel}/${driverName}: it unpacks to more than ${mb(limits.maxSkinBytes)}.`,
      )
    }
  }

  // The one positive test, and the reason the rest of the checks aren't enough:
  // everything above establishes that nothing bad is in the zip, and none of it
  // establishes that a livery is. An empty zip, or one holding only a readme,
  // passes every check up to here and uploads a skin folder that makes the car
  // invisible.
  if (!files.some((f) => extensionOf(f.name) === ".dds")) {
    throw new LiveryPackError(
      `Refusing ${carModel}/${driverName}: there is no .dds file in it, so it isn't a livery. ` +
        `Assetto Corsa reads the car's texture from a .dds — usually livery.dds.`,
    )
  }

  return { carModel, driverName, skinFolder: driverName, files, totalBytes }
}

function firstDuplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>()
  for (const v of values) {
    if (seen.has(v)) return v
    seen.add(v)
  }
  return undefined
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
