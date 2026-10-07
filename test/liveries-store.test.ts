import { describe, expect, it } from "vitest"

import type { Livery, SkinFile } from "../src/liveries/pack.js"
import { LIBRARY, SqliteLiveryStore, liveryDigest } from "../src/liveries/store.js"

const CAR = "rss_formula_hybrid_2021"
const CHAMP = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
const OTHER = "11111111-2222-3333-4444-555555555555"

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)
const text = (b: Uint8Array): string => new TextDecoder().decode(b)

const file = (name: string, body = "dds"): SkinFile => ({ name, bytes: bytes(body) })

const livery = (
  driverName: string,
  files: SkinFile[] = [file("livery.dds")],
  carModel = CAR,
): Livery => ({
  carModel,
  driverName,
  skinFolder: driverName,
  files,
  totalBytes: files.reduce((n, f) => n + f.bytes.length, 0),
})

const open = () => SqliteLiveryStore.open(":memory:")
const at = (iso: string) => new Date(iso)
const MARCH = at("2026-03-04T20:00:00.000Z")
const APRIL = at("2026-04-01T20:00:00.000Z")

describe("liveryDigest", () => {
  it("ignores the order the files arrived in", () => {
    const a = [file("a.dds", "one"), file("b.json", "two")]
    expect(liveryDigest(a)).toBe(liveryDigest([...a].reverse()))
  })

  it("changes when a file's contents change", () => {
    expect(liveryDigest([file("a.dds", "one")])).not.toBe(liveryDigest([file("a.dds", "two")]))
  })

  it("changes when a file is renamed", () => {
    // A renamed .dds is a different skin as far as the game is concerned, and a
    // carset that shrugged would leave everyone holding a stale one.
    expect(liveryDigest([file("a.dds", "x")])).not.toBe(liveryDigest([file("b.dds", "x")]))
  })

  it("does not confuse a rearrangement of the same bytes", () => {
    // "ab" + "c" against "a" + "bc": identical if you concatenate bodies, which
    // is why the digest is built from per-file digests instead.
    const left = [file("1", "ab"), file("2", "c")]
    const right = [file("1", "a"), file("2", "bc")]
    expect(liveryDigest(left)).not.toBe(liveryDigest(right))
  })
})

describe("SqliteLiveryStore", () => {
  it("records a livery and reads its files back intact", async () => {
    const store = await open()
    const result = await store.record(
      CHAMP,
      [livery("Misha", [file("livery.dds", "pixels")])],
      MARCH,
      "zip",
    )
    expect(result).toEqual({ stored: 1, unchanged: 0 })

    const [stored] = await store.read(CHAMP)
    expect(stored).toMatchObject({
      championshipId: CHAMP,
      carModel: CAR,
      driverName: "Misha",
      skinFolder: "Misha",
      fileCount: 1,
      source: "zip",
      appliedAt: MARCH.toISOString(),
    })
    expect(stored?.files.map((f) => f.name)).toEqual(["livery.dds"])
    expect(text(stored?.files[0]?.bytes ?? new Uint8Array())).toBe("pixels")
    store.close()
  })

  it("reports the same artwork applied twice as unchanged", async () => {
    const store = await open()
    await store.record(CHAMP, [livery("Misha")], MARCH, "zip")
    const again = await store.record(CHAMP, [livery("Misha")], APRIL, "discord")
    expect(again).toEqual({ stored: 0, unchanged: 1 })
    store.close()
  })

  it("keeps first_applied_at across a change of livery", async () => {
    // The only record of when a driver's livery actually arrived. Resetting it
    // on every re-upload would make the store unable to answer the one
    // historical question anybody asks of it.
    const store = await open()
    await store.record(CHAMP, [livery("Misha", [file("livery.dds", "v1")])], MARCH, "zip")
    await store.record(CHAMP, [livery("Misha", [file("livery.dds", "v2")])], APRIL, "discord")

    const [stored] = await store.list(CHAMP)
    expect(stored?.firstAppliedAt).toBe(MARCH.toISOString())
    expect(stored?.appliedAt).toBe(APRIL.toISOString())
    store.close()
  })

  it("replaces a livery rather than accumulating one per upload", async () => {
    const store = await open()
    await store.record(CHAMP, [livery("Misha", [file("livery.dds", "v1")])], MARCH, "zip")
    await store.record(CHAMP, [livery("Misha", [file("livery.dds", "v2")])], APRIL, "zip")

    const all = await store.read(CHAMP)
    expect(all).toHaveLength(1)
    expect(text(all[0]?.files[0]?.bytes ?? new Uint8Array())).toBe("v2")
    store.close()
  })

  it("leaves no orphaned files behind when a livery is replaced", async () => {
    // The cascade is doing this, and the cascade is off by default in SQLite.
    // An orphan here is a file that reappears in every carset built after,
    // under a skin folder whose other files have moved on.
    const store = await open()
    await store.record(CHAMP, [livery("Misha", [file("old.dds"), file("gone.json")])], MARCH, "zip")
    await store.record(CHAMP, [livery("Misha", [file("new.dds")])], APRIL, "zip")

    const [stored] = await store.read(CHAMP)
    expect(stored?.files.map((f) => f.name)).toEqual(["new.dds"])
    store.close()
  })

  it("keeps one livery per driver per car, not per driver", async () => {
    const store = await open()
    await store.record(
      CHAMP,
      [livery("Misha"), livery("Misha", [file("a.dds")], "ford_transit")],
      MARCH,
      "zip",
    )
    expect(await store.list(CHAMP)).toHaveLength(2)
    store.close()
  })

  it("keeps championships apart", async () => {
    const store = await open()
    await store.record(CHAMP, [livery("Misha")], MARCH, "zip")
    await store.record(OTHER, [livery("postaL")], MARCH, "zip")

    expect((await store.list(CHAMP)).map((l) => l.driverName)).toEqual(["Misha"])
    expect((await store.list(OTHER)).map((l) => l.driverName)).toEqual(["postaL"])
    store.close()
  })

  it("orders by car then driver, the way the carset lays them out", async () => {
    const store = await open()
    await store.record(
      CHAMP,
      [livery("Zed"), livery("Ann"), livery("Bob", [file("a.dds")], "ford_transit")],
      MARCH,
      "zip",
    )
    expect((await store.list(CHAMP)).map((l) => `${l.carModel}/${l.driverName}`)).toEqual([
      "ford_transit/Bob",
      `${CAR}/Ann`,
      `${CAR}/Zed`,
    ])
    store.close()
  })

  it("attaches each file to the right livery when several are recorded at once", async () => {
    const store = await open()
    await store.record(
      CHAMP,
      [livery("Ann", [file("ann.dds", "a")]), livery("Bob", [file("bob.dds", "b")])],
      MARCH,
      "zip",
    )
    const all = await store.read(CHAMP)
    expect(all.map((l) => l.files.map((f) => f.name))).toEqual([["ann.dds"], ["bob.dds"]])
    store.close()
  })

  it("writes a set all at once or not at all", async () => {
    // A carset built mid-drain should see every livery from that drain or none,
    // never a grid where half the cars updated.
    const store = await open()
    const bad = {
      ...livery("Bob"),
      files: [{ name: "x.dds", bytes: null as unknown as Uint8Array }],
    }
    await expect(store.record(CHAMP, [livery("Ann"), bad], MARCH, "zip")).rejects.toThrow()
    expect(await store.list(CHAMP)).toEqual([])
    store.close()
  })

  it("reads an unknown championship as empty rather than throwing", async () => {
    const store = await open()
    expect(await store.read(CHAMP)).toEqual([])
    expect(await store.list(CHAMP)).toEqual([])
    store.close()
  })

  it("forgets a championship and reports how many it dropped", async () => {
    const store = await open()
    await store.record(CHAMP, [livery("Ann"), livery("Bob")], MARCH, "zip")
    await store.record(OTHER, [livery("Cat")], MARCH, "zip")

    expect(await store.forget(CHAMP)).toBe(2)
    expect(await store.read(CHAMP)).toEqual([])
    expect(await store.list(OTHER)).toHaveLength(1)
    store.close()
  })

  it("records a source it does not recognise as unknown rather than as itself", async () => {
    // Rows outlive the version that wrote them. A future source name reading
    // back as a `LiverySource` it isn't would type-check and then fail
    // somewhere further away.
    const store = await open()
    await store.record(CHAMP, [livery("Misha")], MARCH, "future" as "zip")
    expect((await store.list(CHAMP))[0]?.source).toBe("unknown")
    store.close()
  })
})

describe("a championship's carset", () => {
  const folders = (list: { carModel: string; skinFolder: string; championshipId: string }[]) =>
    list.map((l) => `${l.carModel}/${l.skinFolder}@${l.championshipId}`)

  it("takes every season's and the library's skins for the cars it races, and no others", async () => {
    const store = await open()
    await store.record(OTHER, [livery("Old")], MARCH, "discord")
    await store.record(
      LIBRARY,
      [livery("Collected"), livery("Elsewhere", undefined, "ks_other")],
      MARCH,
      "import",
    )
    await store.setCars(CHAMP, [CAR])

    expect(folders(await store.carset(CHAMP))).toEqual([
      `${CAR}/Collected@${LIBRARY}`,
      `${CAR}/Old@${OTHER}`,
    ])
  })

  it("keeps one skin per folder: this season's, then the newest, then an import", async () => {
    const store = await open()
    await store.record(LIBRARY, [livery("A"), livery("B"), livery("C")], APRIL, "import")
    await store.record(OTHER, [livery("A"), livery("B")], MARCH, "discord")
    await store.record(CHAMP, [livery("A")], MARCH, "discord")
    await store.setCars(CHAMP, [CAR])

    expect(folders(await store.carset(CHAMP))).toEqual([
      `${CAR}/A@${CHAMP}`,
      `${CAR}/B@${OTHER}`,
      `${CAR}/C@${LIBRARY}`,
    ])
  })

  it("keeps its own liveries for a car that has since left the entry list", async () => {
    const store = await open()
    await store.record(CHAMP, [livery("Alice"), livery("Bob", undefined, "ks_other")], MARCH, "zip")
    await store.setCars(CHAMP, [CAR])
    expect(folders(await store.carset(CHAMP))).toEqual([
      `ks_other/Bob@${CHAMP}`,
      `${CAR}/Alice@${CHAMP}`,
    ])
  })

  it("falls back to its own liveries' cars when none are recorded", async () => {
    const store = await open()
    await store.record(CHAMP, [livery("Misha")], MARCH, "discord")
    await store.record(
      LIBRARY,
      [livery("Collected"), livery("X", undefined, "ks_other")],
      MARCH,
      "import",
    )
    expect(folders(await store.carset(CHAMP))).toEqual([
      `${CAR}/Collected@${LIBRARY}`,
      `${CAR}/Misha@${CHAMP}`,
    ])
  })

  it("leaves out an import of a skin that came with the car, but not a season's upload", async () => {
    const store = await open()
    await store.record(LIBRARY, [livery("21New"), livery("Custom")], MARCH, "import")
    await store.record(CHAMP, [livery("44New")], MARCH, "discord")
    await store.setStock(CAR, ["21New", "44New"])
    await store.setCars(CHAMP, [CAR])
    expect(folders(await store.carset(CHAMP))).toEqual([
      `${CAR}/44New@${CHAMP}`,
      `${CAR}/Custom@${LIBRARY}`,
    ])
  })
})
