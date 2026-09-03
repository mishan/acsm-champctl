import { zipSync } from "fflate"
import { describe, expect, it } from "vitest"

import {
  DEFAULT_LIMITS,
  LiveryPackError,
  type PackLimits,
  readLiveryPack,
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
    expect(() => readLiveryPack(p, small)).toThrowError(/more than 2 liveries/)
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
