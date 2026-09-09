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
  /** One file inside a skin. */
  maxFileBytes: number
  /** One driver's whole skin folder. */
  maxSkinBytes: number
  /** Everything, uncompressed. The zip-bomb ceiling. */
  maxTotalBytes: number
  /** Files in one skin folder. */
  maxFilesPerSkin: number
  /** Skins in one pack. */
  maxSkins: number
}

/**
 * Sized from what BATL's drivers actually submit, not from what a livery needs.
 *
 * The first numbers here were the second: 24 MB a file and 64 MB a skin, which
 * is generous for a 4K DDS with mipmaps and a preview. A real pack refused two
 * of its liveries on the first run — one skin over 64 MB, and a 32 MB
 * `Alpha for carbon.png` inside another.
 *
 * That file is the tell. It is a working layer somebody left in, and it is
 * `.png`, so the extension allowlist passes it; Assetto Corsa will never read
 * it. The honest reading is that these limits are catching *tidiness*, which is
 * not what they are for — the checks that matter are the traversal, the
 * extension allowlist and the zip bomb, and those are unchanged. A size cap
 * only has to stop somebody filling the game server's disk.
 *
 * So they are doubled rather than tuned. If a real pack trips one again, double
 * it again; the number that would actually be worth defending is a disk-usage
 * budget for the server's skins directories, and nobody has one.
 *
 * The per-file limit is not free above about 48 MB: see `uploadTimeoutMs` in
 * `apply.ts`, which is what stops a big upload dying on the request timeout.
 */
export const DEFAULT_LIMITS: PackLimits = {
  maxFileBytes: 48 * 1024 * 1024,
  maxSkinBytes: 128 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
  maxFilesPerSkin: 40,
  maxSkins: 100,
}

/**
 * How much bigger than the skin inside it a driver's zip may be.
 *
 * The outer entry is a container, so bounding it by `maxSkinBytes` alone bounds
 * the wrong number: a zip of files totalling exactly the skin limit is larger
 * than that limit by its own headers — a local header, a central-directory
 * record and two copies of the filename per file, plus the end-of-central
 * directory. This is that overhead, rounded up without apology. The outer check
 * exists to catch an entry claiming gigabytes before anything inflates it, not
 * to be tight; the honest per-skin number is `maxSkinBytes`, measured on the
 * unpacked bytes one level down.
 */
const ZIP_CONTAINER_OVERHEAD_PER_FILE = 512
const ZIP_CONTAINER_OVERHEAD = 4096

/** The largest a zip holding `contentBytes` across `files` files can claim to be. */
function containerCeiling(contentBytes: number, files: number): number {
  return contentBytes + files * ZIP_CONTAINER_OVERHEAD_PER_FILE + ZIP_CONTAINER_OVERHEAD
}

/**
 * The most one driver's zip may weigh on the wire.
 *
 * `maxTotalBytes` is the zip-bomb ceiling for a whole pack of a hundred skins,
 * measured on the *inflated* bytes. Using it to size a transport buffer let an
 * anonymous POST make the upload server hold a gigabyte before it had so much
 * as looked at the token, and it made the Discord pre-download gate a number
 * Discord's own limit could never reach. One skin is what either path is
 * actually receiving, so one skin — plus the container it arrives in — is the
 * number.
 */
export function maxSubmissionBytes(limits: PackLimits = DEFAULT_LIMITS): number {
  return containerCeiling(limits.maxSkinBytes, limits.maxFilesPerSkin)
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
 * outside the skins directory.
 *
 * **This was `[A-Za-z0-9 ._'()#+-]` and refused a real driver.** "Ricky
 * Häkkinen" is a driver name, not an attack; so are Cyrillic, Greek and CJK
 * ones, and a league that runs anywhere but the anglosphere would have hit this
 * on its first pack. ASCII was never the property worth checking for.
 *
 * What is worth checking for is that the name cannot *mean* something to the
 * code it passes through, and an allowlist of Unicode categories gives that
 * without an alphabet in it:
 *
 * - `\p{L}\p{M}\p{N}` — letters, combining marks and digits in any script. The
 *   marks matter on their own: macOS stores filenames decomposed, so the ä in a
 *   zip made there is `a` followed by U+0308 rather than one code point.
 * - The punctuation below, which is what turns up in gamer tags.
 *
 * And the exclusions fall out of it rather than needing to be listed. `/` and
 * `\` are not in the set, so no component can be a path. Neither is `"`, which
 * delimits the filename in the multipart header this ends up in. Nor is
 * anything in `\p{C}`: NUL, newlines, terminal escape sequences, and the
 * right-to-left overrides that make a filename render as something other than
 * what it is.
 *
 * Deliberately not blocked: shell metacharacters. Nothing here reaches a shell
 * — Go's `os.MkdirAll` and `os.Create` do not interpret them — and pretending
 * otherwise would refuse a name for a danger that isn't on this path.
 *
 * The first character is restricted only where it changes the name's meaning: a
 * leading `.` is a hidden file and the first step towards `.` and `..`, a
 * leading `-` reads as an option to anything that later globs the directory,
 * and a leading space is invisible. Requiring a *letter or digit* there was the
 * lazy version of that and refused `#7 Racing`, which is a team name.
 */
const SAFE_COMPONENT = /^(?![.\-\s])[\p{L}\p{M}\p{N} ._'()[\]#+&,!@-]{1,64}$/u

/**
 * The same text always compares equal to itself.
 *
 * "Häkkinen" has two valid encodings — precomposed (U+00E4) and decomposed (`a`
 * + U+0308) — and they are different strings. macOS writes zip entries
 * decomposed while ACSM will almost certainly hold the precomposed form, so an
 * exact match between a zip made on a Mac and a Windows entry list fails on a
 * name both sides would print identically.
 *
 * NFC everywhere fixes that, and it is not a loosening of the exact-name rule:
 * case and stray whitespace still miss, deliberately. This only stops two
 * spellings of one character being treated as two characters.
 */
function normalise(value: string): string {
  return value.normalize("NFC")
}

function assertSafeName(kind: string, value: string, where: string): void {
  if (value === "." || value === "..") {
    throw new LiveryPackError(`${where}: "${value}" is not a usable ${kind}.`)
  }
  if (!SAFE_COMPONENT.test(value)) {
    throw new LiveryPackError(
      `${where}: "${value}" is not a usable ${kind}. Letters in any script, digits, spaces and ` +
        `. _ ' ( ) [ ] # + - & , ! @ are fine, up to 64 characters, but it can't start with a ` +
        `dot, a dash or a space. champctl builds a file path out of it and hands that to the ` +
        `game server, so a name that could be read as a path or as terminal control is refused.`,
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

/**
 * Zip entries the archiver added, which the person who zipped never saw.
 *
 * macOS's Archive Utility writes a parallel `__MACOSX/` tree of resource forks
 * beside the real files, and Finder leaves a `.DS_Store` in any folder it has
 * opened; Windows Explorer leaves `Thumbs.db`. None of the three are visible
 * where the zip was made.
 *
 * They used to be refused, and the refusal was unanswerable: a driver who
 * zipped a flat skin folder on a Mac was told `__MACOSX/._livery.dds` "is in a
 * subfolder. An Assetto Corsa skin is a flat folder of files", and went looking
 * for a subfolder Finder does not show them. Because a pack fails whole, one
 * Mac submission blocked the entire league's drop. `.DS_Store` failed a step
 * earlier, as a name that "is not a usable file name" for its leading dot.
 *
 * Dropped rather than refused because they carry nothing to refuse: `__MACOSX`
 * holds resource forks for files that are already in the zip, and the other two
 * are window state. Every unarchiver a driver would otherwise use drops them
 * silently, which is why nobody knows they are in there.
 *
 * Three names and not a pattern, deliberately. Anything else unexpected is
 * still refused by name and by extension — this is not a general "ignore what
 * we don't recognise" rule, which is how an allowlist quietly turns into a
 * blocklist.
 */
function isArchiverJunk(path: string): boolean {
  const parts = path.split(/[/\\]/)
  if (parts.includes("__MACOSX")) return true
  const base = parts[parts.length - 1] ?? ""
  return base === ".DS_Store" || base === "Thumbs.db"
}

/**
 * An entry name, made safe to print.
 *
 * These come out of an untrusted zip and go into a message on somebody's
 * terminal. `assertSafeName` refuses a name carrying `\p{C}` — the
 * right-to-left overrides that make a refusal name a different file than the
 * one refused, and the escape sequences that rewrite the line above it — but
 * only once an entry has got that far, and the size refusals below happen
 * first.
 *
 * Exported for the drain, which prints driver names read back out of the queue
 * database. Those passed `SAFE_COMPONENT` when they were submitted, but the
 * drain is the point at which a stored row is treated as untrusted again.
 */
export function forMessage(name: string): string {
  const clean = name.replace(/\p{C}/gu, "\uFFFD")
  return clean.length > 120 ? `${clean.slice(0, 117)}...` : clean
}

/**
 * What a zip is allowed to be, decided before any of it is inflated.
 *
 * The messages belong to the caller rather than to this type: a refusal naming
 * the pack and one naming a driver's zip are read by different people.
 */
interface UnzipBudget {
  maxEntries: number
  maxEntryBytes: number
  maxTotalBytes: number
  tooManyEntries: () => string
  entryTooBig: (name: string, claimedBytes: number) => string
  tooBigInTotal: () => string
  impossibleSize: (name: string, claimedBytes: number, compressedBytes: number) => string
}

/**
 * A claimed size the compressed bytes could not have come from.
 *
 * Deflate does not expand. Its worst case is a run of stored blocks, which
 * costs about five bytes per 64 KB — so an entry holding substantially *more*
 * compressed bytes than the size it claims to inflate to is describing
 * something that cannot happen.
 *
 * Worth catching, because fflate will not: it sizes its output buffer from the
 * claim and stops there, verifying no CRC and reporting no error, so an entry
 * claiming 100 bytes over 64 MB of deflate comes back as exactly 100 bytes.
 * Comparing the result against the claim cannot find that — the truncation
 * makes them agree. Without some check here, a hand-edited header puts a
 * half-written `livery.dds` on the game server with every size limit below
 * satisfied, because a truncated file is a small one.
 *
 * **What this does and does not bound.** It catches a claim that has fallen
 * below roughly the compressed size, which is where a claim of 2 or 40 bytes
 * for a real livery lands. It does *not* catch a claim above that: a 4 MB
 * `.dds` deflating to 39 KB can be re-declared as 40 KB and still pass, and
 * fflate will hand back those 40 KB. Closing that needs the central
 * directory's CRC-32 verified against the inflated bytes, and fflate neither
 * does that nor exposes the stored CRC through `filter`, so it would mean
 * parsing the central directory here. That is a real gap and it is worth
 * knowing it is one; what makes it survivable is that it takes a deliberately
 * edited header rather than a damaged file, and what it costs is a car that
 * renders wrong, not a server that does.
 *
 * The slack is loose on purpose — the ratio, plus a flat allowance for the
 * per-entry overhead that dominates a small file — because the job is catching
 * a header that is wrong by orders of magnitude, not auditing deflate.
 */
function impossibleClaim(compressedBytes: number, claimedBytes: number): boolean {
  return compressedBytes > claimedBytes + Math.ceil(claimedBytes / 16) + 64
}

/**
 * `unzipSync`, with the limits applied *before* anything is decompressed.
 *
 * This was a bare `unzipSync(bytes)` with every limit checked on the result,
 * which is the wrong way round: by the time `maxFileBytes` was consulted, the
 * file it was about had already been inflated into memory. A 2 MB pack holding
 * one entry that expands to 8 GiB took the process out with a V8 OOM that never
 * reaches the CLI's error handling — so the ceiling documented here as the
 * zip-bomb defence was doing none of that work, and doubling the limits only
 * widened the window.
 *
 * fflate calls `filter` with each entry's central-directory record before its
 * stream is touched, so refusing there is refusing before the allocation.
 *
 * `originalSize` is the zip's *claim* about an entry rather than a measurement,
 * so on its own it would be a check whose answer the zip gets to write. Two
 * things close that, in opposite directions. Claiming more than the budget is
 * refused on the claim. Claiming less buys nothing, because fflate sizes its
 * output buffer from that same number and stops there: an entry claiming 100
 * bytes over 64 MB of deflate arrives as 100 bytes — truncated, not expanded.
 * That truncation is silently wrong on its own terms — it would upload half a
 * livery — so `impossibleClaim` refuses the headers that produce it.
 *
 * Between the two — refusing an over-claim outright, and refusing an under-claim
 * the compressed bytes could not have produced (`impossibleClaim`) — the claim
 * is held close enough to the truth to decide on before inflating. The checks
 * on the inflated bytes further down stay where they are regardless.
 *
 * A breach is recorded and thrown afterwards rather than thrown from inside the
 * callback, so it arrives as a `LiveryPackError` naming the limit instead of as
 * a zip parse failure.
 */
function unzip(bytes: Uint8Array, what: string, budget: UnzipBudget): Record<string, Uint8Array> {
  let entries = 0
  let claimedTotal = 0
  let refusal: string | undefined

  const refuse = (message: string): boolean => {
    refusal ??= message
    return false
  }

  let unzipped: Record<string, Uint8Array>
  try {
    unzipped = unzipSync(bytes, {
      filter: (file) => {
        if (refusal !== undefined) return false
        if (file.name.endsWith("/")) return false
        if (isArchiverJunk(file.name)) return false

        entries += 1
        if (entries > budget.maxEntries) return refuse(budget.tooManyEntries())
        if (file.originalSize > budget.maxEntryBytes) {
          return refuse(budget.entryTooBig(forMessage(file.name), file.originalSize))
        }
        if (impossibleClaim(file.size, file.originalSize)) {
          return refuse(budget.impossibleSize(forMessage(file.name), file.originalSize, file.size))
        }
        claimedTotal += file.originalSize
        if (claimedTotal > budget.maxTotalBytes) return refuse(budget.tooBigInTotal())
        return true
      },
    })
  } catch (e) {
    throw new LiveryPackError(
      `${what} could not be read as a zip: ${e instanceof Error ? e.message : String(e)}`,
    )
  }

  if (refusal !== undefined) throw new LiveryPackError(refusal)
  return unzipped
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
  const outer = unzip(packBytes, "The pack", {
    maxEntries: limits.maxSkins,
    // A driver's zip is a container for their skin folder, so the unpacked-skin
    // ceiling is the honest bound on it: a zip larger than what it unpacks to is
    // not a skin somebody assembled.
    maxEntryBytes: containerCeiling(limits.maxSkinBytes, limits.maxFilesPerSkin),
    // Both numbers here are about *zips*, where `maxTotalBytes` is about the
    // files inside them, so the ceiling carries the same container allowance.
    // This is an early, loose bound and is meant to be: what actually enforces
    // `maxTotalBytes` is the running total in the loop below, on the bytes as
    // they come out.
    maxTotalBytes: containerCeiling(limits.maxTotalBytes, limits.maxSkins * limits.maxFilesPerSkin),
    // Every entry, not every *livery*: this is counted before anything looks at
    // an entry's shape, so a pack padded with a thousand stray files is refused
    // here rather than one refusal at a time. Worded to match.
    tooManyEntries: () =>
      `Refusing the pack: more than ${limits.maxSkins} entries in it. A pack holds one zip per ` +
      `driver, and nothing else.`,
    entryTooBig: (name, claimed) =>
      `Refusing the pack: "${name}" is ${mb(claimed)}, which is more than a zip of a ` +
      `${mb(limits.maxSkinBytes)} skin folder can be.`,
    tooBigInTotal: () =>
      `Refusing the pack: it unpacks to more than ${mb(limits.maxTotalBytes)}, which is a lot ` +
      `more than a set of liveries and is what a zip bomb looks like.`,
    impossibleSize: (name, claimed, compressed) =>
      `Refusing the pack: its directory says "${name}" is ${claimed} bytes, but it holds ` +
      `${compressed} compressed bytes, which cannot unpack to that. The zip has been damaged or ` +
      `edited by hand, and what champctl would get back from it is a truncated file.`,
  })
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

    const [rawCarModel, rawFileName] = parts as [string, string]
    // Normalised before anything looks at them, so the name that is validated,
    // matched against the entry list and sent to ACSM as a folder is one form
    // rather than whichever the zipping machine happened to write.
    const carModel = normalise(rawCarModel)
    const fileName = normalise(rawFileName)
    if (extensionOf(fileName) !== ".zip") {
      throw new LiveryPackError(
        `Refusing "${path}": every entry inside a car folder has to be a driver's zip. ` +
          `Put the skin's files in <driver>.zip rather than loose in the folder.`,
      )
    }

    const driverName = fileName.slice(0, -".zip".length)
    assertSafeName("car model", carModel, `in "${path}"`)
    assertSafeName("driver name", driverName, `in "${path}"`)

    const livery = readOneLivery(carModel, driverName, bytes, limits, path)
    // The inner zip is now unpacked into `livery.files`, and keeping the
    // compressed copy as well doubles what a pack costs in memory for the rest
    // of the loop — while `maxTotalBytes` is written as though it were the whole
    // budget.
    delete outer[path]
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

  return liveryPack(liveries, limits)
}

/**
 * One driver's skin zip, when champctl already knows whose it is.
 *
 * The Discord path. A driver sends `my_livery.zip` with the files loose inside
 * it: no car folder, and a filename that is whatever they called it. Neither
 * absence matters, because both are known *better* elsewhere — the driver name
 * comes from the identity mapping and the car model from that entrant's
 * `Model` in the entry list, so nothing here is taken from a name the
 * submitter chose. The attachment's filename is used for nothing at all.
 *
 * Every check `readLiveryPack` runs, runs here: same traversal guard, same
 * extension allowlist, same flat-folder rule, same caps, same
 * there-must-be-a-.dds test. That is the reason this is four lines in `pack.ts`
 * rather than a reader of its own in the bot. This module's header says
 * everything in it is untrusted *because* a Discord bot was coming; the bot
 * arriving should not be the moment a second code path appears.
 */
export function readSingleLivery(
  zipBytes: Uint8Array,
  identity: { carModel: string; driverName: string },
  limits: PackLimits = DEFAULT_LIMITS,
): Livery {
  const carModel = normalise(identity.carModel)
  const driverName = normalise(identity.driverName)

  assertUsableAsFolder("car model", carModel, identity.carModel)
  assertUsableAsFolder("driver name", driverName, identity.driverName)

  const livery = readOneLivery(carModel, driverName, zipBytes, limits, `${carModel}/${driverName}`)
  if (livery.totalBytes > limits.maxTotalBytes) {
    throw new LiveryPackError(
      `Refusing ${carModel}/${driverName}: it unpacks to more than ` +
        `${mb(limits.maxTotalBytes)}, which is what a zip bomb looks like.`,
    )
  }
  return livery
}

/**
 * Several liveries as one pack, with the whole-pack checks applied.
 *
 * Both callers need these and neither should be trusted to remember them: the
 * `--zip` path builds a pack out of a zip, and the drain builds one out of a
 * queue. The duplicate check is the one that matters for the second — two
 * queued submissions for the same driver would upload the dead one first and
 * then overwrite it, which works by luck and reads as a bug the week it
 * doesn't.
 */
export function liveryPack(
  liveries: readonly Livery[],
  limits: PackLimits = DEFAULT_LIMITS,
): LiveryPack {
  if (liveries.length === 0) {
    throw new LiveryPackError(
      `No liveries in the pack. It should hold car_model/driverName.zip entries, for example ` +
        `rss_formula_hybrid_2021/Misha.zip.`,
    )
  }
  if (liveries.length > limits.maxSkins) {
    throw new LiveryPackError(
      `Refusing the pack: more than ${limits.maxSkins} liveries in one file.`,
    )
  }

  const duplicate = firstDuplicate(liveries.map((l) => `${l.carModel}/${l.driverName}`))
  if (duplicate) {
    throw new LiveryPackError(`Refusing the pack: ${duplicate} appears more than once.`)
  }

  const totalBytes = liveries.reduce((total, l) => total + l.totalBytes, 0)
  if (totalBytes > limits.maxTotalBytes) {
    throw new LiveryPackError(
      `Refusing the pack: it unpacks to more than ${mb(limits.maxTotalBytes)}, which is a lot ` +
        `more than a set of liveries and is what a zip bomb looks like.`,
    )
  }

  return { liveries: [...liveries], totalBytes }
}

/**
 * `assertSafeName` for a name that came from ACSM rather than from a zip.
 *
 * Same rule, different reader. `SAFE_COMPONENT` is narrower than what ACSM will
 * store in `Entrant.Name` — a name leading with a dot, or carrying a slash,
 * saves fine there and is refused here — so on this path the refusal is not
 * "your zip is wrong", it is "this driver cannot upload at all, ever, and only
 * an admin can fix it". Saying that to a driver in the CLI's words would send
 * them re-zipping a file that was never the problem.
 */
export function usableAsFolder(normalised: string): boolean {
  return normalised !== "." && normalised !== ".." && SAFE_COMPONENT.test(normalised)
}

function assertUsableAsFolder(kind: string, normalised: string, asGiven: string): void {
  if (!usableAsFolder(normalised)) {
    throw new LiveryPackError(
      `Can't upload for ${kind} ${JSON.stringify(asGiven)}: champctl turns it into a folder on ` +
        `the game server and that name can't be one. This is an entry list problem rather than ` +
        `anything wrong with the zip — an admin has to change the name in ACSM before this ` +
        `driver can submit a livery.`,
    )
  }
}

function readOneLivery(
  carModel: string,
  driverName: string,
  innerBytes: Uint8Array,
  limits: PackLimits,
  where: string,
): Livery {
  const inner = unzip(innerBytes, `"${where}"`, {
    maxEntries: limits.maxFilesPerSkin,
    maxEntryBytes: limits.maxFileBytes,
    maxTotalBytes: limits.maxSkinBytes,
    tooManyEntries: () =>
      `Refusing ${carModel}/${driverName}: more than ${limits.maxFilesPerSkin} files. A skin is ` +
      `a livery, a preview and a couple of small text files.`,
    entryTooBig: (name, claimed) =>
      `Refusing ${carModel}/${driverName}: "${name}" is ${mb(claimed)}, over the ` +
      `${mb(limits.maxFileBytes)} limit for one file.`,
    tooBigInTotal: () =>
      `Refusing ${carModel}/${driverName}: it unpacks to more than ${mb(limits.maxSkinBytes)}.`,
    impossibleSize: (name, claimed, compressed) =>
      `Refusing ${carModel}/${driverName}: its directory says "${name}" is ${claimed} bytes, but ` +
      `it holds ${compressed} compressed bytes, which cannot unpack to that. The zip has been ` +
      `damaged or edited by hand, and what champctl would get back from it is a truncated file.`,
  })
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
    const name = normalise(parts[0]!)
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
