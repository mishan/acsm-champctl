import { unzipSync } from "fflate"
import { describe, expect, it } from "vitest"

import {
  buildCarset,
  carsetDigest,
  carsetFilename,
  carsetManifest,
  carsetZip,
  skinPath,
} from "../src/liveries/carset.js"
import type { SkinFile } from "../src/liveries/pack.js"
import { SqliteLiveryStore } from "../src/liveries/store.js"
import type { StoredLiveryWithFiles } from "../src/liveries/store.js"

const CAR = "rss_formula_hybrid_2021"
const CHAMP = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)
const text = (b: Uint8Array): string => new TextDecoder().decode(b)
const file = (name: string, body = "dds"): SkinFile => ({ name, bytes: bytes(body) })

const stored = (
  driverName: string,
  files: SkinFile[] = [file("livery.dds"), file("preview.jpg")],
  carModel = CAR,
  skinFolder = driverName,
): StoredLiveryWithFiles => ({
  championshipId: CHAMP,
  carModel,
  driverName,
  skinFolder,
  digest: "unused",
  bytes: files.reduce((n, f) => n + f.bytes.length, 0),
  fileCount: files.length,
  source: "zip",
  firstAppliedAt: "2026-03-04T20:00:00.000Z",
  appliedAt: "2026-03-04T20:00:00.000Z",
  files,
})

describe("skinPath", () => {
  it("is where Assetto Corsa keeps a car skin", () => {
    // The one thing in this module a driver's install depends on.
    expect(skinPath(CAR, "Misha")).toBe(`content/cars/${CAR}/skins/Misha`)
  })
})

describe("buildCarset", () => {
  it("lays every skin out under content/cars", async () => {
    const carset = buildCarset(CHAMP, [stored("Misha")])
    expect(carset.skins[0]?.path).toBe(`content/cars/${CAR}/skins/Misha`)
  })

  /**
   * The property the whole feature rests on.
   *
   * ACSM creates the skin folder from the driver's name, `Entrant.Skin` is set
   * to that same string, and the carset writes it a third time. If they ever
   * disagree, every driver installs successfully and still sees the default
   * livery, because the game looks in a folder that does not exist — and
   * nothing anywhere produces an error.
   */
  it("uses the skin folder ACSM was given, not the driver name", async () => {
    const carset = buildCarset(CHAMP, [stored("Misha", undefined, CAR, "Misha [BATL]")])
    expect(carset.skins[0]?.path).toBe(`content/cars/${CAR}/skins/Misha [BATL]`)
  })

  it("sorts by path, so two carsets with the same skins are the same carset", () => {
    const a = buildCarset(CHAMP, [stored("Zed"), stored("Ann")])
    const b = buildCarset(CHAMP, [stored("Ann"), stored("Zed")])
    expect(a.skins.map((s) => s.driverName)).toEqual(["Ann", "Zed"])
    expect(a.digest).toBe(b.digest)
  })

  it("lists the distinct cars", () => {
    const carset = buildCarset(CHAMP, [
      stored("Ann"),
      stored("Bob"),
      stored("Cat", [file("a.dds")], "ford_transit"),
    ])
    expect(carset.cars).toEqual(["ford_transit", CAR])
  })

  it("keeps liveries for drivers who have left the entry list", () => {
    // Someone watching a replay or racing an old server still needs the car to
    // look right, and a carset that shed skins as the roster churned would be a
    // support question every month.
    const carset = buildCarset(CHAMP, [stored("Departed")])
    expect(carset.skins).toHaveLength(1)
  })

  it("names the skins that will show blank in Content Manager", () => {
    const carset = buildCarset(CHAMP, [
      stored("Ann"),
      stored("Bob", [file("livery.dds")]),
      stored("Cat", [file("livery.dds"), file("PREVIEW.JPG", "jpeg")]),
    ])
    // Case-insensitively: AC does not care and neither should the warning.
    expect(carset.missingPreviews).toEqual(["Bob"])
  })

  it("sums the bytes across every skin", () => {
    const carset = buildCarset(CHAMP, [stored("Ann", [file("a.dds", "12345")])])
    expect(carset.bytes).toBe(5)
  })

  it("carries the championship name when it has one", () => {
    expect(buildCarset(CHAMP, [], { championshipName: "September 2026" })).toMatchObject({
      championshipName: "September 2026",
      skins: [],
      cars: [],
    })
  })
})

describe("carsetDigest", () => {
  it("changes when a livery's artwork changes", () => {
    const before = buildCarset(CHAMP, [stored("Ann", [file("livery.dds", "v1")])])
    const after = buildCarset(CHAMP, [stored("Ann", [file("livery.dds", "v2")])])
    expect(before.digest).not.toBe(after.digest)
  })

  it("changes when a skin moves, because everyone has to re-install", () => {
    // A driver renamed in the entry list gets a new folder, and the old one is
    // the folder AC will stop looking in.
    const before = buildCarset(CHAMP, [stored("Ann", undefined, CAR, "Ann")])
    const after = buildCarset(CHAMP, [stored("Ann", undefined, CAR, "Ann2")])
    expect(before.digest).not.toBe(after.digest)
  })

  it("changes when a driver is added", () => {
    const before = buildCarset(CHAMP, [stored("Ann")])
    const after = buildCarset(CHAMP, [stored("Ann"), stored("Bob")])
    expect(before.digest).not.toBe(after.digest)
  })

  it("does not change on a rebuild", () => {
    // The reason the digest is over the manifest rather than the archive: zip
    // bytes carry DOS timestamps written from local-time getters, so hashing
    // the archive would answer "yes, it changed" to a rebuild that changed
    // nothing — and look like a new carset to everyone holding the old one.
    const skins = [stored("Ann"), stored("Bob")]
    expect(carsetDigest(buildCarset(CHAMP, skins).skins)).toBe(
      carsetDigest(buildCarset(CHAMP, skins).skins),
    )
  })

  it("is not moved by the championship name", () => {
    const a = buildCarset(CHAMP, [stored("Ann")], { championshipName: "September" })
    const b = buildCarset(CHAMP, [stored("Ann")], { championshipName: "October" })
    expect(a.digest).toBe(b.digest)
  })
})

describe("carsetZip", () => {
  const entriesOf = (carset: ReturnType<typeof buildCarset>) => unzipSync(carsetZip(carset))

  it("writes each file where Assetto Corsa expects it", () => {
    const entries = entriesOf(buildCarset(CHAMP, [stored("Misha", [file("livery.dds", "pixels")])]))
    expect(Object.keys(entries)).toContain(`content/cars/${CAR}/skins/Misha/livery.dds`)
    expect(text(entries[`content/cars/${CAR}/skins/Misha/livery.dds`] ?? new Uint8Array())).toBe(
      "pixels",
    )
  })

  it("keeps cars apart in the tree", () => {
    const entries = entriesOf(
      buildCarset(CHAMP, [stored("Ann"), stored("Bob", [file("b.dds")], "ford_transit")]),
    )
    expect(Object.keys(entries)).toEqual(
      expect.arrayContaining([
        `content/cars/${CAR}/skins/Ann/livery.dds`,
        "content/cars/ford_transit/skins/Bob/b.dds",
      ]),
    )
  })

  it("ships the manifest outside content/, so CM has no reason to install it", () => {
    const entries = entriesOf(buildCarset(CHAMP, [stored("Ann")]))
    expect(Object.keys(entries)).toContain("carset.txt")
    expect(Object.keys(entries).filter((k) => k.startsWith("content/")).length).toBeGreaterThan(0)
  })

  it("round-trips an empty carset rather than producing a broken zip", () => {
    expect(Object.keys(entriesOf(buildCarset(CHAMP, [])))).toEqual(["carset.txt"])
  })
})

describe("carsetManifest", () => {
  it("lists a digest against every path in the archive", () => {
    const manifest = carsetManifest(buildCarset(CHAMP, [stored("Ann", [file("livery.dds", "x")])]))
    expect(manifest).toMatch(
      new RegExp(`^[0-9a-f]{64}  content/cars/${CAR}/skins/Ann/livery.dds$`, "m"),
    )
  })

  it("tells the driver what to do when a livery looks stale", () => {
    // Content Manager may decline to replace a file that is already there, and
    // the failure looks like nothing at all.
    expect(carsetManifest(buildCarset(CHAMP, [stored("Ann")]))).toMatch(
      /delete that skin folder and\n# install again/,
    )
  })

  it("names the championship when it has one", () => {
    expect(
      carsetManifest(buildCarset(CHAMP, [stored("Ann")], { championshipName: "September 2026" })),
    ).toContain("September 2026")
  })
})

describe("carsetFilename", () => {
  it("is the championship and enough digest to tell two apart", () => {
    const carset = buildCarset(CHAMP, [stored("Ann")], { championshipName: "September 2026" })
    expect(carsetFilename(carset)).toBe(`september-2026-${carset.digest.slice(0, 8)}.zip`)
  })

  it("survives a championship name that is all punctuation", () => {
    const carset = buildCarset(CHAMP, [stored("Ann")], { championshipName: "!!!" })
    expect(carsetFilename(carset)).toBe(`carset-${carset.digest.slice(0, 8)}.zip`)
  })

  it("has no name to work with and still produces one", () => {
    expect(carsetFilename(buildCarset(CHAMP, [stored("Ann")]))).toMatch(/^carset-[0-9a-f]{8}\.zip$/)
  })
})

describe("the store and the carset together", () => {
  it("builds an installable tree out of what was actually applied", async () => {
    // The end to end of §6: apply, keep, hand back. Through the real store,
    // because the shape the store returns is the one thing the builder trusts.
    const store = await SqliteLiveryStore.open(":memory:")
    await store.record(
      CHAMP,
      [
        {
          carModel: CAR,
          driverName: "Misha",
          skinFolder: "Misha",
          files: [file("livery.dds", "pixels"), file("preview.jpg", "jpeg")],
          totalBytes: 10,
        },
      ],
      new Date("2026-03-04T20:00:00.000Z"),
      "discord",
    )

    const carset = buildCarset(CHAMP, await store.read(CHAMP), { championshipName: "March 2026" })
    expect(carset.skins).toHaveLength(1)
    expect(carset.missingPreviews).toEqual([])

    const entries = unzipSync(carsetZip(carset))
    expect(text(entries[`content/cars/${CAR}/skins/Misha/livery.dds`] ?? new Uint8Array())).toBe(
      "pixels",
    )
    store.close()
  })
})
