import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { JournalWriter, readJournal, type JournalRecord } from "../src/spectator/journal.js"

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "journal-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const lap = (n: number): JournalRecord => ({
  t: "lap",
  at: n,
  carId: 1,
  lapMs: 90_000 + n,
  cuts: 0,
})

async function readAll(path: string): Promise<JournalRecord[]> {
  const out: JournalRecord[] = []
  for await (const r of readJournal(path)) out.push(r)
  return out
}

describe("journal", () => {
  it("reads back what was written", async () => {
    const w = new JournalWriter(join(dir, "s.ndjson.gz"))
    for (let i = 0; i < 3; i++) w.write(lap(i))
    await w.close()
    expect(await readAll(w.path)).toEqual([lap(0), lap(1), lap(2)])
  })

  it("keeps everything before the point a crashed recorder stopped", async () => {
    const whole = gzipSync(`${[0, 1, 2].map((n) => JSON.stringify(lap(n))).join("\n")}\n`)
    const path = join(dir, "cut.ndjson.gz")
    await writeFile(path, whole.subarray(0, whole.length - 12))
    const got = await readAll(path)
    expect(got.length).toBeGreaterThan(0)
    expect(got).toEqual([lap(0), lap(1), lap(2)].slice(0, got.length))
  })

  it("refuses a journal that is unreadable before its last line", async () => {
    const path = join(dir, "bad.ndjson.gz")
    await writeFile(path, gzipSync(`${JSON.stringify(lap(0))}\n{oops\n${JSON.stringify(lap(1))}\n`))
    await expect(readAll(path)).rejects.toThrow(/unreadable journal line/)
  })

  it("closes promptly after the file has already failed", async () => {
    const w = new JournalWriter(join(dir, "missing-dir", "s.ndjson.gz"))
    while (!w.error) await new Promise((r) => setTimeout(r, 5))
    await expect(w.close()).rejects.toThrow(/ENOENT/)
  })

  it("rejects, rather than throwing out of band, when the journal is missing", async () => {
    await expect(readAll(join(dir, "nope.ndjson.gz"))).rejects.toThrow(/ENOENT/)
  })

  it("closes the file when a reader stops early", async () => {
    // Big enough that the file is still being read when the reader stops.
    const w = new JournalWriter(join(dir, "big.ndjson.gz"))
    for (let i = 0; i < 80_000; i++)
      w.write({ t: "lap", at: i, carId: 1, lapMs: Math.random(), cuts: 0 })
    await w.close()
    const open = async (): Promise<number> => {
      await new Promise((r) => setTimeout(r, 20))
      return (await readdir("/proc/self/fd")).length
    }
    const before = await open()
    for (let i = 0; i < 5; i++) for await (const _ of readJournal(w.path)) break
    expect(await open()).toBe(before)
  })

  it("will not overwrite a journal that already exists", async () => {
    const path = join(dir, "s.ndjson.gz")
    await writeFile(path, "keep")
    const w = new JournalWriter(path)
    await expect(w.close()).rejects.toThrow(/EEXIST/)
    expect(await readFile(path, "utf8")).toBe("keep")
  })
})
