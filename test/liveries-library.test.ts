import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { zipSync } from "fflate"
import { afterEach, describe, expect, it } from "vitest"

import {
  dirSource,
  type Imported,
  importSkins,
  type SkinSource,
  stockFrom,
  zipSource,
} from "../src/liveries/library.js"
import { DEFAULT_LIMITS } from "../src/liveries/pack.js"

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)
const CAR = "ac_legends_gt_nissan_gtr"

const skin = { "livery.dds": bytes("DDS"), "ui_skin.json": bytes("{}") }

/** What an import came to, one line per skin. */
async function outcomes(source: SkinSource, stock?: Map<string, Set<string>>) {
  const out: string[] = []
  for await (const r of importSkins(source, stock)) out.push(describeOne(r))
  return out
}

function describeOne(r: Imported): string {
  if (r.kind === "livery") {
    const files = r.livery.files.map((f) => f.name).join(",")
    return `${r.livery.carModel}/${r.livery.skinFolder}: ${files}`
  }
  return `${r.skin.carModel}/${r.skin.skinFolder}: ${r.kind}`
}

describe("importing a zip of skins", () => {
  // The shape a shared folder downloads as: one wrapping folder, then cars.
  const collection = zipSync({
    "acl skins/": new Uint8Array(0),
    [`acl skins/${CAR}/skins/669_Slipshod/livery.dds`]: bytes("DDS"),
    [`acl skins/${CAR}/skins/669_Slipshod/ui_skin.json`]: bytes("{}"),
    [`acl skins/${CAR}/skins/669_Slipshod/desktop.ini`]: bytes("[x]"),
    [`acl skins/${CAR}/skins/669_Slipshod/work.psd`]: bytes("PSD"),
    [`acl skins/${CAR}/skins/21New/livery.dds`]: bytes("DDS"),
    [`acl skins/${CAR}/skins/21New/ui_skin.json`]: bytes("{}"),
    [`acl skins/${CAR}/skins/broken/readme.txt`]: bytes("hi"),
    [`acl skins/ks_other/skins/Mine/livery.dds`]: bytes("DDS"),
    [`acl skins/ks_other/skins/Mine/ui_skin.json`]: bytes("{}"),
  })

  it("reads each skin folder on its own, through an upload's checks", async () => {
    expect(await outcomes(zipSource(collection))).toEqual([
      `${CAR}/21New: livery.dds,ui_skin.json`,
      `${CAR}/669_Slipshod: livery.dds,ui_skin.json`,
      `${CAR}/broken: refused`,
      "ks_other/Mine: livery.dds,ui_skin.json",
    ])
  })

  it("leaves out what came with a car, and a car it has no original for", async () => {
    const stock = new Map([[CAR, new Set(["21New"])]])
    expect(await outcomes(zipSource(collection), stock)).toEqual([
      `${CAR}/21New: stock`,
      `${CAR}/669_Slipshod: livery.dds,ui_skin.json`,
      `${CAR}/broken: refused`,
      "ks_other/Mine: no original",
    ])
  })
})

describe("importing a folder of skins", () => {
  let root: string | undefined
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  })

  const put = async (path: string, body: Uint8Array) => {
    const full = join(root!, path)
    await mkdir(join(full, ".."), { recursive: true })
    await writeFile(full, body)
  }

  it("finds <car>/skins/<folder> under an install's content/cars", async () => {
    root = await mkdtemp(join(tmpdir(), "champctl-library-"))
    for (const [name, body] of Object.entries(skin)) {
      await put(`content/cars/${CAR}/skins/Buckmark/${name}`, body)
    }
    await put(`content/cars/${CAR}/skins/Buckmark/4K/livery.dds`, bytes("DDS"))
    await put(`content/cars/${CAR}/data.acd`, bytes("car"))
    await put(`content/cars/${CAR}/skins/MISF1T/livery.dds`, bytes("DDS"))
    await put(`content/cars/${CAR}/skins/MISF1T/ui_skin.json`, bytes("{}"))
    await put(`content/cars/${CAR}/skins/MISF1T/notes.psd`, bytes("PSD"))

    expect(await outcomes(await dirSource(root))).toEqual([
      // A skin folder is flat, on disk as in a zip.
      `${CAR}/Buckmark: refused`,
      `${CAR}/MISF1T: livery.dds,ui_skin.json`,
    ])
  })

  it("takes the stock list from the cars' original downloads", async () => {
    root = await mkdtemp(join(tmpdir(), "champctl-library-"))
    await mkdir(join(root, `${CAR}/skins/21New`), { recursive: true })
    await mkdir(join(root, `${CAR}/skins/39New`), { recursive: true })
    await put(`${CAR}/data.acd`, bytes("car"))
    expect(await stockFrom(root)).toEqual(new Map([[CAR, new Set(["21New", "39New"])]]))
  })
})

describe("importing awkward sources", () => {
  let root: string | undefined
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  })

  it("reads a folder and not its sibling with a longer name", async () => {
    const zip = zipSync({
      [`${CAR}/skins/Foo/livery.dds`]: bytes("DDS"),
      [`${CAR}/skins/Foo/ui_skin.json`]: bytes("{}"),
      [`${CAR}/skins/Foobar/livery.dds`]: bytes("DDS"),
      [`${CAR}/skins/Foobar/preview.jpg`]: bytes("JPG"),
    })
    expect(await outcomes(zipSource(zip))).toEqual([
      `${CAR}/Foo: livery.dds,ui_skin.json`,
      `${CAR}/Foobar: livery.dds,preview.jpg`,
    ])
  })

  it("refuses a skin found in two places rather than picking one", async () => {
    const zip = zipSync({
      [`2025/${CAR}/skins/Same/livery.dds`]: bytes("old"),
      [`2025/${CAR}/skins/Same/ui_skin.json`]: bytes("{}"),
      [`2026/${CAR}/skins/Same/livery.dds`]: bytes("new"),
      [`2026/${CAR}/skins/Same/ui_skin.json`]: bytes("{}"),
    })
    expect(await outcomes(zipSource(zip))).toEqual([`${CAR}/Same: refused`])
  })

  it("carries on past a folder it can't read, and says it skipped it", async () => {
    // A name that isn't UTF-8, as years of a Windows install accumulate:
    // Node can list it but not open it.
    root = await mkdtemp(join(tmpdir(), "champctl-library-"))
    const skins = join(root, CAR, "skins")
    await mkdir(join(skins, "Good"), { recursive: true })
    await writeFile(join(skins, "Good", "livery.dds"), bytes("DDS"))
    await writeFile(join(skins, "Good", "ui_skin.json"), bytes("{}"))
    const bad = Buffer.concat([
      Buffer.from(`${skins}/Ricky H`),
      Buffer.from([0xe4]),
      Buffer.from("kkinen"),
    ])
    await mkdir(bad)
    await writeFile(Buffer.concat([bad, Buffer.from("/livery.dds")]), bytes("DDS"))

    const source = await dirSource(root)
    expect(await outcomes(source)).toEqual([
      `${CAR}/Good: livery.dds,ui_skin.json`,
      `${CAR}/Ricky H�kkinen: refused`,
    ])
  })

  it("drops the resource forks a Mac leaves beside files on a shared disk", async () => {
    root = await mkdtemp(join(tmpdir(), "champctl-library-"))
    const folder = join(root, CAR, "skins", "Mac")
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, "livery.dds"), bytes("DDS"))
    await writeFile(join(folder, "._livery.dds"), bytes("fork"))
    await writeFile(join(folder, "ui_skin.json"), bytes("{}"))
    expect(await outcomes(await dirSource(root))).toEqual([`${CAR}/Mac: livery.dds,ui_skin.json`])
  })

  it("refuses a file over the limit", async () => {
    root = await mkdtemp(join(tmpdir(), "champctl-library-"))
    const folder = join(root, CAR, "skins", "Big")
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, "livery.dds"), new Uint8Array(2048))
    await writeFile(join(folder, "ui_skin.json"), bytes("{}"))
    const out: Imported[] = []
    for await (const r of importSkins(await dirSource(root), undefined, {
      ...DEFAULT_LIMITS,
      maxFileBytes: 1024,
    })) {
      out.push(r)
    }
    expect(out[0]).toMatchObject({ kind: "refused", reason: expect.stringMatching(/livery\.dds/) })
  })
})
