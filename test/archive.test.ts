import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { AcsmError, type AcsmReader } from "../src/acsm/client.js"
import type { Championship, ChampionshipSummary } from "../src/acsm/types.js"
import { ingest, IngestError, type IngestReport } from "../src/archive/ingest.js"
import {
  UsageError,
  describe as describeOutcome,
  exitCodeFor,
  parseArgs,
  summarise,
} from "../src/cli/archive.js"
import {
  FileArchiveStore,
  UnsafeChampionshipId,
  assertSafeChampionshipId,
  sha256,
  snapshotFileName,
} from "../src/archive/store.js"

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "champctl-archive-"))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const ID = "11111111-2222-3333-4444-555555555555"
const OTHER = "99999999-8888-7777-6666-555555555555"

const at = (iso: string): Date => new Date(iso)

describe("archive store", () => {
  it("stores the body byte for byte", async () => {
    // The archive's whole value is that it is still trustworthy after the
    // source is gone, so it must not normalise anything. This body has key
    // ordering and spacing that JSON.stringify would not reproduce.
    const store = new FileArchiveStore(root)
    const body = '{"Name":"BATL",   "ID":"x",\n "Events":[1.0, 2.50]}'
    const result = await store.put(ID, body, at("2026-08-24T17:00:00Z"))

    const onDisk = await readFile(join(root, ID, result.snapshot.file), "utf8")
    expect(onDisk).toBe(body)
  })

  it("writes one snapshot per change, not per run", async () => {
    const store = new FileArchiveStore(root)
    const body = '{"a":1}'

    const first = await store.put(ID, body, at("2026-08-24T17:00:00Z"))
    const second = await store.put(ID, body, at("2026-08-25T17:00:00Z"))
    const third = await store.put(ID, '{"a":2}', at("2026-08-26T17:00:00Z"))

    expect(first.stored).toBe(true)
    expect(second.stored).toBe(false)
    expect(third.stored).toBe(true)

    const files = (await readdir(join(root, ID))).filter((f) => f !== "index.json")
    expect(files).toHaveLength(2)
  })

  it("records that an unchanged run happened", async () => {
    // Otherwise there is no way to tell "nothing changed" from "the job has
    // been silently failing for a month".
    const store = new FileArchiveStore(root)
    await store.put(ID, '{"a":1}', at("2026-08-24T17:00:00Z"))
    await store.put(ID, '{"a":1}', at("2026-08-25T17:00:00Z"))

    const index = await store.read(ID)
    expect(index?.snapshots).toHaveLength(1)
    expect(index?.lastCheckedAt).toBe("2026-08-25T17:00:00.000Z")
    expect(index?.firstSeen).toBe("2026-08-24T17:00:00.000Z")
  })

  it("keeps the change history in order, with the name at the time", async () => {
    const store = new FileArchiveStore(root)
    await store.put(ID, '{"a":1}', at("2026-08-24T17:00:00Z"), "August")
    await store.put(ID, '{"a":2}', at("2026-09-24T17:00:00Z"), "September")

    const index = await store.read(ID)
    expect(index?.snapshots.map((s) => s.name)).toEqual(["August", "September"])
    expect(index?.snapshots.map((s) => s.fetchedAt)).toEqual([
      "2026-08-24T17:00:00.000Z",
      "2026-09-24T17:00:00.000Z",
    ])
  })

  it("dedupes against the latest snapshot, not any earlier one", async () => {
    // A championship that changes and then reverts should record the revert as
    // its own snapshot; treating it as a duplicate of the older body would
    // lose the fact that it changed twice.
    const store = new FileArchiveStore(root)
    await store.put(ID, '{"a":1}', at("2026-08-24T17:00:00Z"))
    await store.put(ID, '{"a":2}', at("2026-08-25T17:00:00Z"))
    const back = await store.put(ID, '{"a":1}', at("2026-08-26T17:00:00Z"))

    expect(back.stored).toBe(true)
    expect((await store.read(ID))?.snapshots).toHaveLength(3)
  })

  it("keeps championships apart", async () => {
    const store = new FileArchiveStore(root)
    await store.put(ID, '{"a":1}', at("2026-08-24T17:00:00Z"))
    await store.put(OTHER, '{"a":1}', at("2026-08-24T17:00:00Z"))

    expect(await store.list()).toEqual([ID, OTHER].sort())
    // Same body, different championship: both are stored.
    expect((await store.read(OTHER))?.snapshots).toHaveLength(1)
  })

  it("survives an index that is missing or corrupt", async () => {
    // A half-written index must not make a championship permanently
    // un-archivable; the next run should just store a fresh snapshot.
    const store = new FileArchiveStore(root)
    await store.put(ID, '{"a":1}', at("2026-08-24T17:00:00Z"))
    await writeFile(join(root, ID, "index.json"), "{ truncated", "utf8")

    const again = await store.put(ID, '{"a":1}', at("2026-08-25T17:00:00Z"))
    expect(again.stored).toBe(true)
  })

  it("reads a snapshot back unchanged", async () => {
    const store = new FileArchiveStore(root)
    const body = '{"Name":"BATL",   "ID":"x"}'
    const { snapshot } = await store.put(ID, body, at("2026-08-24T17:00:00Z"))
    expect(await store.readSnapshot(ID, snapshot.file)).toBe(body)
  })

  it("records the hash and byte length", async () => {
    const store = new FileArchiveStore(root)
    const body = '{"a":"ä"}' // multi-byte, so bytes !== length
    const { snapshot } = await store.put(ID, body, at("2026-08-24T17:00:00Z"))
    expect(snapshot.sha256).toBe(sha256(body))
    expect(snapshot.bytes).toBe(Buffer.byteLength(body, "utf8"))
    expect(snapshot.bytes).not.toBe(body.length)
  })

  it("returns an empty list rather than throwing on a missing archive", async () => {
    expect(await new FileArchiveStore(join(root, "nope")).list()).toEqual([])
  })
})

describe("championship IDs become path segments", () => {
  it("refuses traversal and absolute paths", async () => {
    // The ID comes off the wire and is about to name a directory.
    for (const bad of [
      "../../etc",
      "..",
      ".",
      "/etc/passwd",
      "a/b",
      "a\\b",
      "",
      "index.json",
      ".hidden",
    ]) {
      expect(() => assertSafeChampionshipId(bad), bad).toThrow(UnsafeChampionshipId)
    }
  })

  it("accepts the UUIDs ACSM actually issues", () => {
    expect(() => assertSafeChampionshipId(ID)).not.toThrow()
  })

  it("refuses to write outside the archive", async () => {
    const store = new FileArchiveStore(root)
    await expect(
      store.put("../escaped", '{"a":1}', at("2026-08-24T17:00:00Z")),
    ).rejects.toThrow(UnsafeChampionshipId)
  })

  it("names snapshot files so they sort chronologically and copy to Windows", () => {
    const early = snapshotFileName(at("2026-08-24T09:00:00Z"))
    const late = snapshotFileName(at("2026-08-24T17:00:00Z"))
    expect([late, early].sort()).toEqual([early, late])
    for (const name of [early, late]) {
      expect(name).not.toMatch(/[:*?"<>|]/)
    }
  })
})

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

interface FakeOptions {
  summaries: ChampionshipSummary[]
  bodies?: Record<string, string>
  fail?: Record<string, string>
  failList?: string
}

function fakeReader(options: FakeOptions): AcsmReader & { fetched: string[] } {
  const fetched: string[] = []
  return {
    fetched,
    async listChampionships() {
      if (options.failList) throw new AcsmError(options.failList)
      return options.summaries
    },
    async exportChampionshipRaw(id: string) {
      fetched.push(id)
      const failure = options.fail?.[id]
      if (failure) throw new AcsmError(failure)
      return options.bodies?.[id] ?? `{"ID":"${id}"}`
    },
    async exportChampionship(id: string) {
      return JSON.parse(await this.exportChampionshipRaw(id)) as Championship
    },
    async standings() {
      throw new AcsmError("not used")
    },
    async healthcheck() {
      return { ok: true }
    },
  }
}

describe("ingest", () => {
  const clock = (iso: string) => () => new Date(iso)

  it("archives every championship the list returns", async () => {
    const store = new FileArchiveStore(root)
    const reader = fakeReader({ summaries: [{ ID: ID, Name: "August" }, { ID: OTHER }] })

    const report = await ingest(reader, store, { now: clock("2026-08-24T17:00:00Z") })

    expect(report.stored).toBe(2)
    expect(report.failed).toBe(0)
    expect(await store.list()).toEqual([ID, OTHER].sort())
  })

  it("keeps going when one championship fails", async () => {
    // The point of a nightly job is that the archive gets no worse. One bad
    // championship must not cost the other thirty.
    const store = new FileArchiveStore(root)
    const reader = fakeReader({
      summaries: [{ ID }, { ID: OTHER, Name: "Second" }],
      fail: { [ID]: "500 Internal Server Error" },
    })

    const report = await ingest(reader, store, { now: clock("2026-08-24T17:00:00Z") })

    expect(report.failed).toBe(1)
    expect(report.stored).toBe(1)
    expect(await store.list()).toEqual([OTHER])
    expect(report.outcomes.find((o) => o.kind === "failed")).toMatchObject({
      championshipId: ID,
      error: expect.stringContaining("500"),
    })
  })

  it("treats a failure to list as fatal", async () => {
    // Without a list there is nothing to iterate, so reporting success here
    // would mean a broken job looks like a clean one forever.
    const store = new FileArchiveStore(root)
    const reader = fakeReader({ summaries: [], failList: "Public Access is off" })
    await expect(ingest(reader, store)).rejects.toBeInstanceOf(IngestError)
  })

  it("reports a list entry with no ID rather than dropping it", async () => {
    const store = new FileArchiveStore(root)
    const reader = fakeReader({ summaries: [{ Name: "Nameless" }, { ID }] })

    const report = await ingest(reader, store, { now: clock("2026-08-24T17:00:00Z") })
    expect(report.failed).toBe(1)
    expect(report.stored).toBe(1)
  })

  it("fetches a duplicated list entry only once", async () => {
    const store = new FileArchiveStore(root)
    const reader = fakeReader({ summaries: [{ ID }, { ID }] })

    const report = await ingest(reader, store, { now: clock("2026-08-24T17:00:00Z") })
    expect(reader.fetched).toEqual([ID])
    expect(report.outcomes).toHaveLength(1)
  })

  it("counts an unchanged championship separately from a stored one", async () => {
    const store = new FileArchiveStore(root)
    const reader = fakeReader({ summaries: [{ ID }] })

    await ingest(reader, store, { now: clock("2026-08-24T17:00:00Z") })
    const second = await ingest(reader, store, { now: clock("2026-08-25T17:00:00Z") })

    expect(second.stored).toBe(0)
    expect(second.unchanged).toBe(1)
  })

  it("can skip championships already checked recently", async () => {
    // So a re-run after a partial failure doesn't refetch everything.
    const store = new FileArchiveStore(root)
    const reader = fakeReader({ summaries: [{ ID }] })
    await ingest(reader, store, { now: clock("2026-08-24T17:00:00Z") })

    const second = await ingest(reader, store, {
      now: clock("2026-08-24T17:30:00Z"),
      skipCheckedSince: at("2026-08-24T16:00:00Z"),
    })

    expect(second.skipped).toBe(1)
    expect(reader.fetched).toEqual([ID]) // not fetched a second time
  })

  it("stores the raw body, not a re-serialisation of it", async () => {
    const store = new FileArchiveStore(root)
    const body = `{"Name":"BATL",   "ID":"${ID}",\n "x":1.0}`
    const reader = fakeReader({ summaries: [{ ID }], bodies: { [ID]: body } })

    await ingest(reader, store, { now: clock("2026-08-24T17:00:00Z") })

    const index = await store.read(ID)
    const file = index?.snapshots[0]?.file as string
    expect(await store.readSnapshot(ID, file)).toBe(body)
  })

  it("does not let a later success hide an earlier failure", async () => {
    // The exit code is what a cron job acts on, so "archived 30, failed 1"
    // has to surface the 1.
    const store = new FileArchiveStore(root)
    const reader = fakeReader({
      summaries: [{ ID }, { ID: OTHER }],
      fail: { [ID]: "boom" },
    })
    const report = await ingest(reader, store, { now: clock("2026-08-24T17:00:00Z") })
    expect(exitCodeFor(report)).toBe(2)
  })

  it("reports progress as it goes", async () => {
    const store = new FileArchiveStore(root)
    const reader = fakeReader({ summaries: [{ ID }, { ID: OTHER }] })
    const seen: string[] = []

    await ingest(reader, store, {
      now: clock("2026-08-24T17:00:00Z"),
      onProgress: (o) => seen.push(`${o.kind}:${o.championshipId}`),
    })

    expect(seen).toEqual([`stored:${ID}`, `stored:${OTHER}`])
  })
})

describe("archive CLI", () => {
  const report = (over: Partial<IngestReport> = {}): IngestReport => ({
    startedAt: "2026-08-24T17:00:00.000Z",
    finishedAt: "2026-08-24T17:01:00.000Z",
    outcomes: [],
    stored: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
    ...over,
  })

  it("maps runs onto the cron exit-code contract", () => {
    expect(exitCodeFor(report())).toBe(0)
    expect(exitCodeFor(report({ unchanged: 12 }))).toBe(0)
    expect(exitCodeFor(report({ stored: 1 }))).toBe(1)
    expect(exitCodeFor(report({ failed: 1 }))).toBe(2)
    // A failure outranks a success: it's the one someone has to act on.
    expect(exitCodeFor(report({ stored: 30, failed: 1 }))).toBe(2)
  })

  it("summarises a run in one line", () => {
    expect(summarise(report({ stored: 2, unchanged: 10 }))).toBe("2 archived, 10 unchanged")
    expect(summarise(report({ stored: 0, unchanged: 1, failed: 3 }))).toContain("3 failed")
    // Skipped is noise unless it happened.
    expect(summarise(report({ unchanged: 1 }))).not.toContain("skipped")
  })

  it("names the championship in progress output", () => {
    expect(
      describeOutcome({
        kind: "failed",
        championshipId: ID,
        name: "August",
        error: "500 Internal Server Error",
      }),
    ).toBe(`FAILED     August (${ID}) — 500 Internal Server Error`)
  })

  it("parses the options it documents", () => {
    const args = parseArgs(["run", "--dir", "/tmp/a", "--since", "2026-08-24T00:00:00Z", "--json"])
    expect(args.command).toBe("run")
    expect(args.dir).toBe("/tmp/a")
    expect(args.json).toBe(true)
    expect(args.since?.toISOString()).toBe("2026-08-24T00:00:00.000Z")
  })

  it("rejects a bad --since rather than archiving against a NaN date", () => {
    expect(() => parseArgs(["run", "--since", "last tuesday"])).toThrow(UsageError)
  })

  it("rejects an unknown option instead of ignoring it", () => {
    expect(() => parseArgs(["run", "--dry-run"])).toThrow(UsageError)
    expect(() => parseArgs(["run", "--dir"])).toThrow(/needs a value/)
  })
})
