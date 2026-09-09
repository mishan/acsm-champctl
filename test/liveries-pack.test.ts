import { zipSync } from "fflate"
import { describe, expect, it } from "vitest"

import {
  DEFAULT_LIMITS,
  LiveryPackError,
  liveryPack,
  type PackLimits,
  readLiveryPack,
  readSingleLivery,
} from "../src/liveries/pack.js"

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

/** The minimum that counts as a livery: a .dds and nothing objectionable. */
const skin = (extra: Record<string, Uint8Array> = {}): Uint8Array =>
  zipSync({ "livery.dds": bytes("DDS pixels"), "ui_skin.json": bytes("{}"), ...extra })

const pack = (entries: Record<string, Uint8Array>): Uint8Array => zipSync(entries)

const CAR = "rss_formula_hybrid_2021"

const onePack = (extra: Record<string, Uint8Array> = {}) =>
  pack({ [`${CAR}/Misha.zip`]: skin(extra) })

describe("readLiveryPack", () => {
  it("reads car model, driver and files out of the nested zips", () => {
    const result = readLiveryPack(pack({ [`${CAR}/Misha.zip`]: skin() }))
    expect(result.liveries).toHaveLength(1)
    expect(result.liveries[0]).toMatchObject({
      carModel: CAR,
      driverName: "Misha",
      // The skin folder ACSM will create is the driver's name, which is what
      // makes a re-upload land on the same folder rather than accumulating one
      // per week.
      skinFolder: "Misha",
    })
    expect(result.liveries[0]?.files.map((f) => f.name).sort()).toEqual([
      "livery.dds",
      "ui_skin.json",
    ])
  })

  it("keeps the file bytes intact", () => {
    const result = readLiveryPack(onePack())
    const dds = result.liveries[0]?.files.find((f) => f.name === "livery.dds")
    expect(new TextDecoder().decode(dds?.bytes)).toBe("DDS pixels")
  })

  it("orders liveries the same way whatever order the zip lists them", () => {
    // A preview that reorders between runs is one nobody reads twice.
    const forwards = readLiveryPack(
      pack({ [`${CAR}/Ann.zip`]: skin(), [`${CAR}/Bob.zip`]: skin() }),
    )
    const backwards = readLiveryPack(
      pack({ [`${CAR}/Bob.zip`]: skin(), [`${CAR}/Ann.zip`]: skin() }),
    )
    expect(forwards.liveries.map((l) => l.driverName)).toEqual(["Ann", "Bob"])
    expect(backwards.liveries.map((l) => l.driverName)).toEqual(["Ann", "Bob"])
  })

  it("reads several cars in one pack", () => {
    const result = readLiveryPack(
      pack({ [`${CAR}/Misha.zip`]: skin(), "ford_transit/Stream.zip": skin() }),
    )
    expect(result.liveries.map((l) => `${l.carModel}/${l.driverName}`)).toEqual([
      "ford_transit/Stream",
      `${CAR}/Misha`,
    ])
  })

  it("unwraps a skin whose files sit in one folder inside the zip", () => {
    // Both shapes turn up depending on how the person zipped it.
    const wrapped = zipSync({
      "Misha/livery.dds": bytes("x"),
      "Misha/ui_skin.json": bytes("{}"),
    })
    const result = readLiveryPack(pack({ [`${CAR}/Misha.zip`]: wrapped }))
    expect(result.liveries[0]?.files.map((f) => f.name).sort()).toEqual([
      "livery.dds",
      "ui_skin.json",
    ])
  })
})

describe("names from an actual entry list", () => {
  // "Ricky Häkkinen" is a real BATL driver, and the first version of this rule
  // refused him because it was an ASCII allowlist. The property worth checking
  // was never the alphabet.
  const namesThatAreJustNames = [
    "Ricky Häkkinen",
    "Kimi Räikkönen",
    "Sébastien Loeb",
    "Ayrton Senna",
    "Даниил Квят",
    "山本 尚貴",
    "Πέτρος",
    "postaL",
    "R1cky [BATL]",
    "Bob & Sons",
    "O'Neill",
    "some.one",
    "driver_42",
    "no1!",
    "at@sign",
    "a+b",
    "Mr (Fast)",
    "#7 Racing",
  ]

  it.each(namesThatAreJustNames)("accepts %s", (name) => {
    const result = readLiveryPack(pack({ [`${CAR}/${name}.zip`]: skin() }))
    expect(result.liveries[0]?.driverName).toBe(name)
  })

  it("treats a decomposed name as the same name", () => {
    // macOS writes zip entries decomposed, so an ä from a Mac is "a" + U+0308
    // where a Windows entry list holds U+00E4. Same text, different bytes, and
    // an exact match on the raw strings misses.
    // Written as escapes on purpose: typed as literals these are the same
    // source text, and the test would pass with the normalising removed.
    const decomposed = "Ricky Ha\u0308kkinen"
    const precomposed = "Ricky H\u00e4kkinen"
    expect(decomposed).not.toBe(precomposed)
    expect([...decomposed]).toHaveLength([...precomposed].length + 1)

    const result = readLiveryPack(pack({ [`${CAR}/${decomposed}.zip`]: skin() }))
    expect(result.liveries[0]?.driverName).toBe(precomposed)
    expect(result.liveries[0]?.skinFolder).toBe(precomposed)
  })

  it("normalises file names inside the skin too", () => {
    const result = readLiveryPack(
      pack({ [`${CAR}/Misha.zip`]: zipSync({ "he\u0301llo.dds": bytes("x") }) }),
    )
    expect(result.liveries[0]?.files.map((f) => f.name)).toEqual(["h\u00e9llo.dds"])
  })
})

describe("readLiveryPack refusals", () => {
  const refuses = (build: () => Uint8Array, match: RegExp) => {
    expect(() => readLiveryPack(build())).toThrowError(LiveryPackError)
    expect(() => readLiveryPack(build())).toThrowError(match)
  }

  it("refuses a path that climbs out of the pack", () => {
    // ACSM builds the destination with filepath.Dir(header.Filename) and does
    // not sanitise it, so this writes outside the skins directory on the game
    // server. champctl chooses those filenames, so this is where it stops.
    refuses(() => pack({ [`../../etc/Misha.zip`]: skin() }), /climbs out of the pack/)
  })

  it("refuses a traversal inside a driver's zip", () => {
    refuses(
      () => pack({ [`${CAR}/Misha.zip`]: zipSync({ "../evil.dds": bytes("x") }) }),
      /climbs out of the pack/,
    )
  })

  it("refuses a backslash separator, which some Windows zip tools write", () => {
    // Go's filepath.Dir on Linux reads this as one long filename rather than a
    // traversal, so it is not exploitable there — and it is one platform away
    // from being so, for no benefit.
    refuses(
      () => pack({ [`${CAR}/Misha.zip`]: zipSync({ "..\\evil.dds": bytes("x") }) }),
      /climbs out of the pack/,
    )
  })

  it("refuses an absolute path", () => {
    refuses(() => pack({ "/etc/passwd": skin() }), /absolute paths/)
  })

  it("refuses a Photoshop source file by name", () => {
    // The one people actually leave in, and the message is likely to be read by
    // the driver who did it.
    refuses(() => onePack({ "livery.psd": bytes("huge") }), /Photoshop source file/)
  })

  it("refuses an executable", () => {
    refuses(() => onePack({ "readme.exe": bytes("MZ") }), /an executable/)
  })

  it("refuses an extension nobody has thought about", () => {
    // The allowlist is the point: the dangerous file type is the one that isn't
    // on anybody's list of dangerous file types.
    refuses(() => onePack({ "skin.wasm": bytes("\0asm") }), /not something a skin needs/)
  })

  it("refuses a zip with no .dds, which is not a livery", () => {
    // Everything else here establishes that nothing bad is in the zip. Only
    // this establishes that a livery is.
    refuses(
      () => pack({ [`${CAR}/Misha.zip`]: zipSync({ "readme.txt": bytes("hi") }) }),
      /no \.dds file/,
    )
  })

  it("refuses an empty driver zip", () => {
    refuses(() => pack({ [`${CAR}/Misha.zip`]: zipSync({}) }), /no \.dds file/)
  })

  it("refuses a skin in subfolders", () => {
    refuses(
      () =>
        pack({
          [`${CAR}/Misha.zip`]: zipSync({
            "a/livery.dds": bytes("x"),
            "b/other.dds": bytes("x"),
          }),
        }),
      /in a subfolder/,
    )
  })

  it("refuses loose files in a car folder", () => {
    refuses(() => pack({ [`${CAR}/livery.dds`]: bytes("x") }), /has to be a driver's zip/)
  })

  it("refuses a zip at the top level with no car folder", () => {
    refuses(() => pack({ "Misha.zip": skin() }), /at the top level/)
  })

  it("refuses nesting deeper than car_model/driver.zip", () => {
    refuses(() => pack({ [`${CAR}/sub/Misha.zip`]: skin() }), /nested too deeply/)
  })

  it("refuses a driver name that is not a plain name", () => {
    refuses(() => pack({ [`${CAR}/.hidden.zip`]: skin() }), /not a usable driver name/)
  })

  it("refuses a car model that is not a plain name", () => {
    refuses(() => pack({ [`rss;rm -rf/Misha.zip`]: skin() }), /not a usable car model/)
  })

  /**
   * Widening the rule to letters in any script must not widen it to everything.
   * Each of these is a name that means something to code downstream rather than
   * a name.
   */
  it.each([
    ["a leading dash, which globs as an option", "-rf"],
    ["a leading space, which is invisible", " Misha"],
    ["a NUL byte", "Mis\u0000ha"],
    ["a newline, which would split the multipart header", "Mis\nha"],
    ["a carriage return", "Mis\rha"],
    ["a terminal escape sequence", "Mis\u001b[31mha"],
    // U+202E flips rendering, so "Miha‮sdd.yrevil" displays as a .dds.
    // The allowlist excludes every \p{C} character, which covers it — worth a
    // test because it is the one that looks harmless in a diff.
    ["a right-to-left override", "Mis\u202Eha"],
    ["a zero-width space", "Mis\u200Bha"],
    ["a double quote, which delimits the multipart filename", 'Mis"ha'],
    ["a colon and semicolon", "Mis:h;a"],
    ["a name longer than 64 characters", "M".repeat(65)],
  ])("refuses %s", (_why, name) => {
    // Slashes are handled earlier, by the path split, so they are not here.
    expect(() => readLiveryPack(pack({ [`${CAR}/${name}.zip`]: skin() }))).toThrowError(
      /not a usable driver name/,
    )
  })

  it("accepts a name of exactly 64 characters", () => {
    // The boundary in the direction that matters: one too many is refused
    // above, and the limit itself must not be off by one against a long tag.
    const name = "M".repeat(64)
    expect(readLiveryPack(pack({ [`${CAR}/${name}.zip`]: skin() })).liveries[0]?.driverName).toBe(
      name,
    )
  })

  it("refuses the same driver twice for one car", () => {
    // fflate keys by path, so this needs two paths that normalise to one entry.
    refuses(
      () => pack({ [`${CAR}/Misha.zip`]: skin(), [`./${CAR}/Misha.zip`]: skin() }),
      new RegExp(`${CAR}/Misha appears more than once`),
    )
  })

  it("refuses a pack with no liveries at all", () => {
    refuses(() => pack({}), /No liveries in the pack/)
  })

  it("refuses something that is not a zip", () => {
    expect(() => readLiveryPack(bytes("this is not a zip"))).toThrowError(
      /could not be read as a zip/,
    )
  })

  it("names the driver zip that failed to parse, not just 'a zip'", () => {
    refuses(
      () => pack({ [`${CAR}/Misha.zip`]: bytes("not a zip either") }),
      new RegExp(`"${CAR}/Misha.zip" could not be read as a zip`),
    )
  })
})

describe("readLiveryPack and the archiver's own files", () => {
  // Everything here is what a driver on a Mac actually hands over. Finder shows
  // them a flat folder of two files; the zip carries five.
  const MAC = {
    "__MACOSX/._livery.dds": bytes("resource fork"),
    "__MACOSX/._ui_skin.json": bytes("resource fork"),
    ".DS_Store": bytes("Finder window position"),
  }

  it("accepts a skin zipped by macOS Archive Utility", () => {
    // This used to be refused with "__MACOSX/._livery.dds is in a subfolder. An
    // Assetto Corsa skin is a flat folder of files" — about a folder Finder
    // does not show them, in a pack that then failed whole.
    const result = readLiveryPack(pack({ [`${CAR}/Misha.zip`]: skin(MAC) }))
    expect(result.liveries[0]?.files.map((f) => f.name).sort()).toEqual([
      "livery.dds",
      "ui_skin.json",
    ])
  })

  it("accepts a pack whose outer zip was made on a Mac too", () => {
    const p = pack({
      [`${CAR}/Misha.zip`]: skin(),
      [`__MACOSX/${CAR}/._Misha.zip`]: bytes("resource fork"),
      ".DS_Store": bytes("Finder window position"),
    })
    expect(readLiveryPack(p).liveries.map((l) => l.driverName)).toEqual(["Misha"])
  })

  it("ignores Thumbs.db, which is the same thing on Windows", () => {
    const p = pack({ [`${CAR}/Misha.zip`]: skin({ "Thumbs.db": bytes("thumbnails") }) })
    expect(
      readLiveryPack(p)
        .liveries[0]?.files.map((f) => f.name)
        .sort(),
    ).toEqual(["livery.dds", "ui_skin.json"])
  })

  it("still refuses a real subfolder, which is not archiver noise", () => {
    // The narrowness is the point: dropping three known names is not the same
    // as ignoring anything unrecognised.
    const p = pack({
      [`${CAR}/Misha.zip`]: zipSync({
        "livery.dds": bytes("DDS"),
        "extra/other.dds": bytes("DDS"),
      }),
    })
    expect(() => readLiveryPack(p)).toThrowError(/is in a subfolder/)
  })
})

describe("readLiveryPack and a zip that lies about its size", () => {
  /**
   * Rewrites every central-directory record's uncompressed-size field.
   *
   * The point of the limits moving ahead of `unzipSync` is that they are read
   * off the central directory rather than off the inflated bytes, so the test
   * for it has to be a zip whose central directory says something the bytes do
   * not. `PK\x01\x02` starts each record; the uncompressed size is four
   * little-endian bytes at offset 24.
   *
   * What this pins is *where the number is read from*. The old code took every
   * size off the inflated bytes, so a directory saying 4 GB over a 1 MB file
   * told it nothing and the pack sailed through; the filter reads the directory
   * and refuses. It does not pin "nothing was inflated" — see the honest bomb
   * below for that, which is the input the filter actually exists for.
   */
  const claimSize = (zip: Uint8Array, claimed: number): Uint8Array => {
    const out = new Uint8Array(zip)
    const view = new DataView(out.buffer)
    for (let i = 0; i + 30 < out.length; i++) {
      if (out[i] === 0x50 && out[i + 1] === 0x4b && out[i + 2] === 0x01 && out[i + 3] === 0x02) {
        view.setUint32(i + 24, claimed, true)
      }
    }
    return out
  }

  // Just under the uint32 ceiling, so it is a plain claim rather than the
  // 0xFFFFFFFF that means "look in the ZIP64 record".
  const FOUR_GB = 0xfffffff0

  it("refuses a file claiming four gigabytes without unpacking it", () => {
    const p = pack({ [`${CAR}/Misha.zip`]: claimSize(skin(), FOUR_GB) })
    expect(() => readLiveryPack(p)).toThrowError(LiveryPackError)
    expect(() => readLiveryPack(p)).toThrowError(/over the 48.0 MB limit for one file/)
  })

  it("refuses a driver's zip claiming four gigabytes", () => {
    const p = claimSize(pack({ [`${CAR}/Misha.zip`]: skin() }), FOUR_GB)
    expect(() => readLiveryPack(p)).toThrowError(
      /which is more than a zip of a 128.0 MB skin folder can be/,
    )
  })

  /** A livery-sized file, so a truncating claim is a lie by orders of magnitude. */
  const realDds = (): Uint8Array => new Uint8Array(1024 * 1024)

  /**
   * Incompressible bytes, for the cases that need the *compressed* size to stay
   * large — a zip of zeros shrinks to a few hundred bytes, which is inside the
   * slack `impossibleClaim` deliberately leaves for small entries.
   */
  const noise = (n: number): Uint8Array => {
    const out = new Uint8Array(n)
    let x = 123456789
    for (let i = 0; i < n; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff
      out[i] = (x >> 16) & 0xff
    }
    return out
  }

  it("refuses a zip whose directory claims less than it holds", () => {
    // Claiming *less* is the other way at the same check, and it does not get
    // through either — but not for the reason you would guess. fflate sizes its
    // output buffer from the claim and stops there, so the entry inflates to
    // exactly the claimed length: no error, no overrun, and a truncated file
    // that every size limit below is delighted with. Comparing the result
    // against the claim cannot catch it, because the truncation makes the two
    // agree. What catches it is that deflate does not expand: those compressed
    // bytes could not have come from two.
    const p = pack({
      [`${CAR}/Misha.zip`]: claimSize(zipSync({ "livery.dds": realDds() }), 2),
    })
    expect(() => readLiveryPack(p)).toThrowError(LiveryPackError)
    expect(() => readLiveryPack(p)).toThrowError(/is 2 bytes, but it holds \d+ compressed bytes/)
  })

  it("refuses a truncating claim on the driver's zip itself", () => {
    // The same lie one level out: the pack's directory understating a driver's
    // zip, which fflate would hand back as a couple of bytes that are then not
    // a zip at all — and, at a friendlier number, as a zip missing its tail.
    const p = claimSize(
      pack({ [`${CAR}/Misha.zip`]: zipSync({ "livery.dds": noise(256 * 1024) }) }),
      40,
    )
    expect(() => readLiveryPack(p)).toThrowError(/is 40 bytes, but it holds \d+ compressed bytes/)
  })

  it("leaves an honest zip alone, including one that compresses very well", () => {
    // The guard rail on the guard: a 1 MB livery of zeros compresses to about a
    // kilobyte, and a ratio check written carelessly would refuse it.
    const p = pack({
      [`${CAR}/Misha.zip`]: zipSync({ "livery.dds": realDds(), "ui_skin.json": bytes("{}") }),
    })
    expect(readLiveryPack(p).liveries[0]?.files.map((f) => f.name)).toContain("livery.dds")
  })
})

describe("readLiveryPack limits", () => {
  const small: PackLimits = {
    ...DEFAULT_LIMITS,
    maxFileBytes: 100,
    maxSkinBytes: 150,
    maxTotalBytes: 200,
    maxFilesPerSkin: 3,
    maxSkins: 2,
  }
  const big = (n: number) => new Uint8Array(n)

  it("refuses an oversized file", () => {
    const p = pack({ [`${CAR}/Misha.zip`]: zipSync({ "livery.dds": big(200) }) })
    expect(() => readLiveryPack(p, small)).toThrowError(/over the .* limit for one file/)
  })

  it("refuses a skin folder that is too big in total", () => {
    const p = pack({
      [`${CAR}/Misha.zip`]: zipSync({ "a.dds": big(90), "b.dds": big(90) }),
    })
    expect(() => readLiveryPack(p, small)).toThrowError(/unpacks to more than/)
  })

  it("refuses too many files in one skin", () => {
    const p = pack({
      [`${CAR}/Misha.zip`]: zipSync({
        "a.dds": bytes("x"),
        "b.dds": bytes("x"),
        "c.dds": bytes("x"),
        "d.dds": bytes("x"),
      }),
    })
    expect(() => readLiveryPack(p, small)).toThrowError(/more than 3 files/)
  })

  it("refuses too many liveries", () => {
    const p = pack({
      [`${CAR}/A.zip`]: skin(),
      [`${CAR}/B.zip`]: skin(),
      [`${CAR}/C.zip`]: skin(),
    })
    expect(() => readLiveryPack(p, small)).toThrowError(/more than 2 entries/)
  })

  it("refuses a pack that unpacks to more than the ceiling", () => {
    // The zip-bomb case, and it has to be tested at a realistic scale: each
    // piece is within its own limit, and the total is not. Zero-filled files
    // compress to almost nothing, so the check has to be on the *unpacked*
    // size — a limit on the file on disk would pass this happily.
    const bomb: PackLimits = { ...DEFAULT_LIMITS, maxTotalBytes: 1024 * 1024 }
    const p = pack({
      [`${CAR}/A.zip`]: zipSync({ "a.dds": big(900 * 1024) }),
      [`${CAR}/B.zip`]: zipSync({ "b.dds": big(900 * 1024) }),
    })
    expect(p.length).toBeLessThan(bomb.maxTotalBytes / 10)
    expect(() => readLiveryPack(p, bomb)).toThrowError(/zip bomb/)
  })

  it("refuses an honest zip bomb on its directory alone", () => {
    // The input the pre-inflation filter exists for, with nothing hand-edited:
    // a well-formed zip whose central directory truthfully says 64 MB, against
    // a limit of one. Zeros deflate about a thousand to one, so the pack on
    // disk is smaller than the limit it breaks — which is why a limit on the
    // file on disk catches nothing.
    //
    // Honest about what this pins: the refusal, on an unedited zip, through the
    // filter. Not "nothing was inflated" — the old code refused this too, after
    // allocating the 64 MB first, and no assertion here can tell those apart.
    // The size at which the difference stops being academic is one no test can
    // allocate on the way to finding out.
    const limits: PackLimits = { ...DEFAULT_LIMITS, maxFileBytes: 1024 * 1024 }
    const p = pack({ [`${CAR}/Misha.zip`]: zipSync({ "livery.dds": big(64 * 1024 * 1024) }) })
    expect(p.length).toBeLessThan(limits.maxFileBytes)
    expect(() => readLiveryPack(p, limits)).toThrowError(/over the 1.0 MB limit for one file/)
  })

  it("keeps terminal control out of a refusal it has to print", () => {
    // A size refusal names the entry, and it happens before assertSafeName has
    // looked at that name — so this is the one place an unvalidated name from
    // an untrusted zip reaches somebody's terminal. A right-to-left override
    // would make the refusal name a different file than the one refused.
    const limits: PackLimits = { ...DEFAULT_LIMITS, maxFileBytes: 1024 }
    const p = pack({
      [`${CAR}/Misha.zip`]: zipSync({ "liv\u202Eery.dds": big(4096), "livery.dds": bytes("x") }),
    })
    let message = ""
    try {
      readLiveryPack(p, limits)
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain("over the")
    expect(message).not.toContain("\u202E")
    expect(message).toContain("\uFFFD")
  })

  it("accepts a realistic livery under the shipped limits", () => {
    // A guard on the guards: limits tuned until the tests pass are limits that
    // reject a real 4K livery on race night.
    const p = pack({
      [`${CAR}/Misha.zip`]: zipSync({
        "livery.dds": big(16 * 1024 * 1024),
        "livery_map.dds": big(4 * 1024 * 1024),
        "preview.jpg": big(200 * 1024),
        "ui_skin.json": bytes('{"skinname":"Misha"}'),
      }),
    })
    expect(readLiveryPack(p).liveries[0]?.files).toHaveLength(4)
  })

  it("accepts the two liveries the first shipped limits refused", () => {
    // Both are real: a 32 MB "Alpha for carbon.png" left in one submission, and
    // another skin totalling more than 64 MB. Written at the sizes that failed,
    // so halving DEFAULT_LIMITS back again fails here rather than on race night.
    const p = pack({
      [`${CAR}/Laplal.zip`]: zipSync({
        "livery.dds": big(20 * 1024 * 1024),
        "Alpha for carbon.png": big(33 * 1024 * 1024),
      }),
      [`${CAR}/ily.zip`]: zipSync({
        "livery.dds": big(40 * 1024 * 1024),
        "livery_map.dds": big(30 * 1024 * 1024),
        "livery_details.dds": big(20 * 1024 * 1024),
      }),
    })
    expect(readLiveryPack(p).liveries.map((l) => l.driverName)).toEqual(["Laplal", "ily"])
  })

  it("still refuses a file past the doubled per-file limit", () => {
    // Doubling is not removing. The cap still has a job: stopping one
    // submission filling the game server's disk.
    const p = pack({
      [`${CAR}/Misha.zip`]: zipSync({ "livery.dds": big(49 * 1024 * 1024) }),
    })
    expect(() => readLiveryPack(p)).toThrowError(/over the 48.0 MB limit for one file/)
  })

  it("still refuses a skin past the doubled folder limit", () => {
    const p = pack({
      [`${CAR}/Misha.zip`]: zipSync({
        "a.dds": big(45 * 1024 * 1024),
        "b.dds": big(45 * 1024 * 1024),
        "c.dds": big(45 * 1024 * 1024),
      }),
    })
    expect(() => readLiveryPack(p)).toThrowError(/unpacks to more than 128.0 MB/)
  })
})

/**
 * The Discord path (docs/discord-livery-upload.md §4).
 *
 * A driver sends a bare skin zip and champctl supplies the two things the CLI
 * reads off the pack's own filenames. The point of these tests is not that
 * `readSingleLivery` works — it is that it refuses everything `readLiveryPack`
 * refuses, since it is about to be handed bytes by a stranger rather than by an
 * operator who looked at them.
 */
describe("readSingleLivery", () => {
  const identity = { carModel: CAR, driverName: "Misha" }

  it("takes the car and driver from the caller, not from the zip", () => {
    const livery = readSingleLivery(skin(), identity)
    expect(livery).toMatchObject({ carModel: CAR, driverName: "Misha", skinFolder: "Misha" })
    expect(livery.files.map((f) => f.name).sort()).toEqual(["livery.dds", "ui_skin.json"])
  })

  it("unwraps a skin whose files sit in one folder inside the zip", () => {
    // The shape you get from zipping the folder rather than its contents, which
    // is what most people do.
    const wrapped = zipSync({
      "MyLivery/livery.dds": bytes("DDS pixels"),
      "MyLivery/ui_skin.json": bytes("{}"),
    })
    expect(
      readSingleLivery(wrapped, identity)
        .files.map((f) => f.name)
        .sort(),
    ).toEqual(["livery.dds", "ui_skin.json"])
  })

  it("refuses a path that climbs out with ..", () => {
    const evil = zipSync({ "livery.dds": bytes("d"), "../evil.dds": bytes("x") })
    expect(() => readSingleLivery(evil, identity)).toThrowError(/climbs out/)
  })

  it("refuses a leftover source file", () => {
    expect(() => readSingleLivery(skin({ "work.psd": bytes("x") }), identity)).toThrowError(
      /Photoshop source file/,
    )
  })

  it("refuses a zip with no .dds in it, so it isn't a livery", () => {
    const notALivery = zipSync({ "readme.txt": bytes("hi") })
    expect(() => readSingleLivery(notALivery, identity)).toThrowError(/no .dds file/)
  })

  it("refuses a file over the per-file cap", () => {
    const huge = zipSync({ "livery.dds": new Uint8Array(49 * 1024 * 1024) })
    expect(() => readSingleLivery(huge, identity)).toThrowError(/over the 48.0 MB limit/)
  })

  it("refuses something that isn't a zip, without leaking the exception", () => {
    expect(() => readSingleLivery(bytes("not a zip at all"), identity)).toThrowError(
      LiveryPackError,
    )
  })

  it("normalises the driver name, so a Mac-made zip still lands on one folder", () => {
    // "Häkkinen" decomposed and precomposed are different strings for the same
    // text. The skin folder has to be one of them, consistently, or a re-upload
    // makes a second folder beside the first.
    const decomposed = "Ha\u0308kkinen"
    const livery = readSingleLivery(skin(), { carModel: CAR, driverName: decomposed })
    expect(livery.skinFolder).toBe("H\u00e4kkinen")
  })

  /**
   * The refusal that is aimed at the operator rather than the driver.
   *
   * ACSM will store an entrant name that champctl cannot turn into a folder, so
   * this is reachable without anybody doing anything wrong — and telling the
   * driver their zip is bad would send them re-zipping a file that was never
   * the problem.
   */
  it("says an unusable entrant name is an entry list problem, not a zip problem", () => {
    const bad = { carModel: CAR, driverName: ".hidden" }
    expect(() => readSingleLivery(skin(), bad)).toThrowError(/entry list problem/)
    expect(() => readSingleLivery(skin(), bad)).toThrowError(/an admin has to change the name/)
  })

  it("refuses an entrant name that could be read as a path", () => {
    expect(() => readSingleLivery(skin(), { carModel: CAR, driverName: "a/b" })).toThrowError(
      /can't be one/,
    )
  })

  it("refuses a car model that could be read as a path", () => {
    expect(() =>
      readSingleLivery(skin(), { carModel: "../etc", driverName: "Misha" }),
    ).toThrowError(/Can't upload for car model/)
  })
})

/**
 * The whole-pack checks, reachable on their own because the drain assembles a
 * pack out of queued submissions rather than out of a zip.
 */
describe("liveryPack", () => {
  const one = (driverName: string, car = CAR) =>
    readSingleLivery(skin(), { carModel: car, driverName })

  it("sums the bytes across liveries", () => {
    const p = liveryPack([one("Ann"), one("Bob")])
    expect(p.liveries).toHaveLength(2)
    expect(p.totalBytes).toBe(one("Ann").totalBytes * 2)
  })

  it("refuses two liveries for the same driver and car", () => {
    // Two queued submissions for one driver would upload the dead one first and
    // then overwrite it — right by luck, and a bug the week it isn't.
    expect(() => liveryPack([one("Ann"), one("Ann")])).toThrowError(/appears more than once/)
  })

  it("allows the same driver in two different cars", () => {
    expect(liveryPack([one("Ann"), one("Ann", "ford_transit")]).liveries).toHaveLength(2)
  })

  it("refuses an empty pack rather than reporting a clean no-op", () => {
    expect(() => liveryPack([])).toThrowError(/No liveries in the pack/)
  })

  it("refuses more liveries than the limit allows", () => {
    const limits: PackLimits = { ...DEFAULT_LIMITS, maxSkins: 2 }
    expect(() => liveryPack([one("Ann"), one("Bob"), one("Cat")], limits)).toThrowError(
      /more than 2 liveries/,
    )
  })

  it("refuses a set that unpacks past the whole-pack ceiling", () => {
    const limits: PackLimits = { ...DEFAULT_LIMITS, maxTotalBytes: 10 }
    expect(() => liveryPack([one("Ann"), one("Bob")], limits)).toThrowError(/zip bomb/)
  })

  it("does not share the array it was given", () => {
    // The drain builds its list incrementally; a pack that aliased it would
    // change under whoever is holding it.
    const liveries = [one("Ann")]
    const p = liveryPack(liveries)
    liveries.push(one("Bob"))
    expect(p.liveries).toHaveLength(1)
  })
})
