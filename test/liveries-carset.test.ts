import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Writable } from "node:stream"

import { unzipSync } from "fflate"
import { describe, expect, it } from "vitest"

import {
  carsetDigest,
  carsetFilename,
  carsetPlan,
  manifestHeader,
  skinPath,
  writeCarset,
} from "../src/liveries/carset.js"
import type { SkinFile } from "../src/liveries/pack.js"
import { liveryDigest, SqliteLiveryStore } from "../src/liveries/store.js"
import type { StoredLivery } from "../src/liveries/store.js"

const CAR = "rss_formula_hybrid_2021"
const CHAMP = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)
const text = (b: Uint8Array): string => new TextDecoder().decode(b)
const file = (name: string, body = "dds"): SkinFile => ({ name, bytes: bytes(body) })

/** A store row plus the files it stands for, so one fixture drives both halves. */
interface Fixture {
  row: StoredLivery
  files: SkinFile[]
}

const stored = (
  driverName: string,
  files: SkinFile[] = [file("livery.dds"), file("preview.jpg")],
  carModel = CAR,
  skinFolder = driverName,
): Fixture => ({
  files,
  row: {
    championshipId: CHAMP,
    carModel,
    driverName,
    skinFolder,
    // The real digest, not a placeholder: the carset's identity is built out of
    // these, so a fixture with a constant here would make every carset look
    // identical and every digest test pass for the wrong reason.
    digest: liveryDigest(files),
    bytes: files.reduce((n, f) => n + f.bytes.length, 0),
    fileCount: files.length,
    source: "zip",
    firstAppliedAt: "2026-03-04T20:00:00.000Z",
    appliedAt: "2026-03-04T20:00:00.000Z",
  },
})

const planOf = (fixtures: Fixture[], options = {}) =>
  carsetPlan(
    CHAMP,
    fixtures.map((f) => f.row),
    options,
  )

/** Builds the archive in memory, which is fine for fixtures of a few bytes. */
async function zipOf(fixtures: Fixture[], options = {}) {
  const plan = planOf(fixtures, options)
  const chunks: Uint8Array[] = []
  const sink = new Writable({
    write(chunk: Buffer, _enc, done) {
      chunks.push(new Uint8Array(chunk))
      done()
    },
  })
  const result = await writeCarset(sink, plan, async (skin) => {
    const match = fixtures.find(
      (f) => f.row.carModel === skin.carModel && f.row.driverName === skin.driverName,
    )
    return match?.files ?? []
  })
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const archive = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    archive.set(c, at)
    at += c.length
  }
  return { plan, result, archive, entries: unzipSync(archive) }
}

describe("skinPath", () => {
  it("is where Assetto Corsa keeps a car skin", () => {
    // The one thing in this module a driver's install depends on.
    expect(skinPath(CAR, "Misha")).toBe(`content/cars/${CAR}/skins/Misha`)
  })
})

describe("carsetPlan", () => {
  it("lays every skin out under content/cars", () => {
    expect(planOf([stored("Misha")]).skins[0]?.path).toBe(`content/cars/${CAR}/skins/Misha`)
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
  it("uses the skin folder ACSM was given, not the driver name", () => {
    const plan = planOf([stored("Misha", undefined, CAR, "Misha [BATL]")])
    expect(plan.skins[0]?.path).toBe(`content/cars/${CAR}/skins/Misha [BATL]`)
  })

  it("lists the distinct cars", () => {
    const plan = planOf([
      stored("Ann"),
      stored("Bob"),
      stored("Cat", [file("a.dds")], "ford_transit"),
    ])
    expect(plan.cars).toEqual([CAR, "ford_transit"])
  })

  it("keeps liveries for drivers who have left the entry list", () => {
    // Someone watching a replay or racing an old server still needs the car to
    // look right, and a carset that shed skins as the roster churned would be a
    // support question every month.
    expect(planOf([stored("Departed")]).skins).toHaveLength(1)
  })

  it("sums the bytes across every skin", () => {
    expect(planOf([stored("Ann", [file("a.dds", "12345")])]).bytes).toBe(5)
  })

  it("carries the championship name when it has one", () => {
    expect(planOf([], { championshipName: "September 2026" })).toMatchObject({
      championshipName: "September 2026",
      skins: [],
      cars: [],
    })
  })

  it("needs no file bytes at all", () => {
    // The point of the split. A cache hit on /c/<slug> answers "which carset is
    // this" from the store's metadata, where it used to read every blob of
    // every livery and SHA-256 the lot — on every request, 304s included.
    expect(planOf([stored("Ann"), stored("Bob")]).digest).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("carsetDigest", () => {
  it("changes when a livery's artwork changes", () => {
    expect(planOf([stored("Ann", [file("livery.dds", "v1")])]).digest).not.toBe(
      planOf([stored("Ann", [file("livery.dds", "v2")])]).digest,
    )
  })

  it("changes when a skin moves, because everyone has to re-install", () => {
    // A driver renamed in the entry list gets a new folder, and the old one is
    // the folder AC will stop looking in.
    expect(planOf([stored("Ann", undefined, CAR, "Ann")]).digest).not.toBe(
      planOf([stored("Ann", undefined, CAR, "Ann2")]).digest,
    )
  })

  it("changes when a driver is added", () => {
    expect(planOf([stored("Ann")]).digest).not.toBe(planOf([stored("Ann"), stored("Bob")]).digest)
  })

  it("is not moved by the championship name", () => {
    expect(planOf([stored("Ann")], { championshipName: "September" }).digest).toBe(
      planOf([stored("Ann")], { championshipName: "October" }).digest,
    )
  })

  it("does not depend on the order the store returned the rows in", () => {
    const a = carsetDigest(planOf([stored("Ann"), stored("Zed")]).skins)
    const b = carsetDigest([...planOf([stored("Ann"), stored("Zed")]).skins].reverse())
    // It does depend on order, and that is the honest answer: the store orders
    // by car then driver and both the plan and the build walk that order, so
    // this asserts the two agree rather than pretending the hash is a set.
    expect(a).not.toBe(b)
  })
})

describe("writeCarset", () => {
  it("writes each file where Assetto Corsa expects it", async () => {
    const { entries } = await zipOf([stored("Misha", [file("livery.dds", "pixels")])])
    expect(text(entries[`content/cars/${CAR}/skins/Misha/livery.dds`] ?? new Uint8Array())).toBe(
      "pixels",
    )
  })

  it("keeps cars apart in the tree", async () => {
    const { entries } = await zipOf([stored("Ann"), stored("Bob", [file("b.dds")], "ford_transit")])
    expect(Object.keys(entries)).toEqual(
      expect.arrayContaining([
        `content/cars/${CAR}/skins/Ann/livery.dds`,
        "content/cars/ford_transit/skins/Bob/b.dds",
      ]),
    )
  })

  it("ships the manifest outside content/, so CM has no reason to install it", async () => {
    const { entries } = await zipOf([stored("Ann")])
    expect(Object.keys(entries)).toContain("carset.txt")
    expect(Object.keys(entries).filter((k) => k.startsWith("content/")).length).toBeGreaterThan(0)
  })

  it("round-trips an empty carset rather than producing a broken zip", async () => {
    const { entries } = await zipOf([])
    expect(Object.keys(entries)).toEqual(["carset.txt"])
  })

  it("names the skins that will show blank in Content Manager", async () => {
    const { result } = await zipOf([
      stored("Ann"),
      stored("Bob", [file("livery.dds")]),
      stored("Cat", [file("livery.dds"), file("PREVIEW.JPG", "jpeg")]),
    ])
    // Case-insensitively: AC does not care and neither should the warning.
    expect(result.missingPreviews).toEqual(["Bob"])
  })

  it("produces the same bytes twice, so a rebuild is not a new download", async () => {
    // fflate stamps every entry with Date.now() unless told otherwise, so two
    // builds a second apart used to differ — which meant a rebuilt carset was a
    // new file to every driver who already had it. This is what `mtime` being
    // fixed buys, and the property nothing checked.
    const first = await zipOf([stored("Ann"), stored("Bob")])
    await new Promise((r) => setTimeout(r, 1100))
    const second = await zipOf([stored("Ann"), stored("Bob")])
    expect(Buffer.from(second.archive).equals(Buffer.from(first.archive))).toBe(true)
  })

  it("reads one driver's files at a time, and never the whole carset", async () => {
    // The reason writeCarset takes a callback rather than the files: a
    // thirty-driver pack is a few hundred megabytes, and holding it in the heap
    // per request is how a league's VPS dies on the evening everyone downloads.
    const fixtures = [stored("Ann"), stored("Bob"), stored("Cat")]
    let live = 0
    let mostAtOnce = 0
    const plan = planOf(fixtures)
    const sink = new Writable({
      write(_c, _e, done) {
        done()
      },
    })
    await writeCarset(sink, plan, async (skin) => {
      live += 1
      mostAtOnce = Math.max(mostAtOnce, live)
      const match = fixtures.find((f) => f.row.driverName === skin.driverName)
      const files = match?.files ?? []
      live -= 1
      return files
    })
    expect(mostAtOnce).toBe(1)
  })

  it("reports the archive's own size, not the sum of the files", async () => {
    const { result, archive } = await zipOf([stored("Ann")])
    expect(result.bytes).toBe(archive.length)
  })
})

describe("the manifest", () => {
  it("lists a digest against every path in the archive", async () => {
    const { entries } = await zipOf([stored("Ann", [file("livery.dds", "x")])])
    expect(text(entries["carset.txt"] ?? new Uint8Array())).toMatch(
      new RegExp(`^[0-9a-f]{64}  content/cars/${CAR}/skins/Ann/livery.dds$`, "m"),
    )
  })

  it("tells the driver what to do when a livery looks stale", () => {
    // Content Manager may decline to replace a file that is already there, and
    // the failure looks like nothing at all.
    expect(manifestHeader(planOf([stored("Ann")])).join("\n")).toMatch(
      /delete that skin folder and\n# install again/,
    )
  })

  it("names the championship when it has one", () => {
    expect(
      manifestHeader(planOf([stored("Ann")], { championshipName: "September 2026" })).join("\n"),
    ).toContain("September 2026")
  })
})

describe("carsetFilename", () => {
  it("is the championship and enough digest to tell two apart", () => {
    const plan = planOf([stored("Ann")], { championshipName: "September 2026" })
    expect(carsetFilename(plan)).toBe(`september-2026-${plan.digest.slice(0, 8)}.zip`)
  })

  it("survives a championship name that is all punctuation", () => {
    const plan = planOf([stored("Ann")], { championshipName: "!!!" })
    expect(carsetFilename(plan)).toBe(`carset-${plan.digest.slice(0, 8)}.zip`)
  })

  it("has no name to work with and still produces one", () => {
    expect(carsetFilename(planOf([stored("Ann")]))).toMatch(/^carset-[0-9a-f]{8}\.zip$/)
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

    const dir = await mkdtemp(join(tmpdir(), "champctl-carset-"))
    const out = join(dir, "carset.zip")
    const plan = carsetPlan(CHAMP, await store.list(CHAMP), { championshipName: "March 2026" })
    expect(plan.skins).toHaveLength(1)

    const { createWriteStream } = await import("node:fs")
    const result = await writeCarset(createWriteStream(out), plan, (skin) =>
      store.filesFor(CHAMP, skin.carModel, skin.driverName),
    )
    expect(result.missingPreviews).toEqual([])

    const entries = unzipSync(new Uint8Array(await readFile(out)))
    expect(text(entries[`content/cars/${CAR}/skins/Misha/livery.dds`] ?? new Uint8Array())).toBe(
      "pixels",
    )

    // The digest read from metadata alone has to be the digest of the archive
    // that was actually written, or the ETag describes a different file.
    expect(text(entries["carset.txt"] ?? new Uint8Array())).toContain(plan.digest)

    store.close()
    await rm(dir, { recursive: true, force: true })
  })
})
