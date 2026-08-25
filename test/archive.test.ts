import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { AcsmError, HttpAcsmReader, type AcsmReader } from "../src/acsm/client.js"
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
  UnsafeArchivePath,
  assertSafeChampionshipId,
  assertSafePathSegment,
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

  it("surfaces a real IO error rather than reporting an empty archive", async () => {
    // A broken archive must not look like an empty one. If it did, the ingest
    // would report "archived" every night while writing nothing — the worst
    // outcome for a tool whose job is not losing data.
    await writeFile(join(root, "not-a-directory"), "x", "utf8")
    const store = new FileArchiveStore(join(root, "not-a-directory"))
    await expect(store.list()).rejects.toThrow(/ENOTDIR/)
  })

  it("surfaces an unreadable index rather than treating it as absent", async () => {
    const store = new FileArchiveStore(root)
    await store.put(ID, '{"a":1}', at("2026-08-24T17:00:00Z"))
    // A directory where the index file should be: not ENOENT, not a parse
    // failure, so it has to be reported.
    await rm(join(root, ID, "index.json"))
    await mkdir(join(root, ID, "index.json"))
    await expect(store.read(ID)).rejects.toThrow(/EISDIR/)
  })

  it("still treats a missing index as simply absent", async () => {
    expect(await new FileArchiveStore(root).read(ID)).toBeUndefined()
  })

  it("treats a valid-but-wrong-shaped index as absent, not as an index", async () => {
    // Parsing was not enough, and casting the result was the bug. `{}` made
    // put() throw on `existing.snapshots.at(-1)`; `{"snapshots":"nope"}` threw
    // nothing at all and silently dropped the history instead.
    const store = new FileArchiveStore(root)
    for (const body of [
      "{}",
      "null",
      "[]",
      '"a string"',
      '{"snapshots":"nope"}',
      '{"championshipId":"x","firstSeen":"t","lastCheckedAt":"t"}',
      '{"championshipId":"x","firstSeen":"t","lastCheckedAt":"t","snapshots":[1,2]}',
    ]) {
      await mkdir(join(root, ID), { recursive: true })
      await writeFile(join(root, ID, "index.json"), body, "utf8")
      expect(await store.read(ID), body).toBeUndefined()
    }
  })

  it("recovers from a wrong-shaped index rather than throwing", async () => {
    // The contract is "recoverable means treat it as absent", so the next run
    // has to store a fresh snapshot instead of falling over.
    const store = new FileArchiveStore(root)
    await store.put(ID, '{"a":1}', at("2026-08-24T17:00:00Z"))
    await writeFile(join(root, ID, "index.json"), "{}", "utf8")

    const again = await store.put(ID, '{"a":2}', at("2026-08-25T17:00:00Z"))
    expect(again.stored).toBe(true)
    expect((await store.read(ID))?.snapshots).toHaveLength(1)
  })

  it("accepts a real index, including one with optional fields missing", async () => {
    // Proportionate: a snapshot without a `name` is still a usable history.
    const store = new FileArchiveStore(root)
    await mkdir(join(root, ID), { recursive: true })
    await writeFile(
      join(root, ID, "index.json"),
      JSON.stringify({
        championshipId: ID,
        firstSeen: "2026-08-24T17:00:00.000Z",
        lastCheckedAt: "2026-08-24T17:00:00.000Z",
        snapshots: [{ fetchedAt: "t", file: "f.json", sha256: "abc", bytes: 3 }],
      }),
      "utf8",
    )
    expect((await store.read(ID))?.snapshots).toHaveLength(1)
  })

  it("skips directories that aren't ours rather than choking on them", async () => {
    // The archive root is an ordinary directory somebody may keep other things
    // in. Returning these made `status` throw UnsafeArchivePath on a folder
    // nobody ever claimed was a championship.
    const store = new FileArchiveStore(root)
    await store.put(ID, '{"a":1}', at("2026-08-24T17:00:00Z"))
    for (const junk of ["lost+found", ".tmp", ".git", "index.json"]) {
      await mkdir(join(root, junk), { recursive: true })
    }

    expect(await store.list()).toEqual([ID])
  })

  it("everything list() returns can be passed straight to read()", async () => {
    // This is the contract `status` depends on.
    const store = new FileArchiveStore(root)
    await store.put(ID, '{"a":1}', at("2026-08-24T17:00:00Z"))
    await store.put(OTHER, '{"a":2}', at("2026-08-24T17:00:00Z"))
    await mkdir(join(root, "lost+found"), { recursive: true })

    const ids = await store.list()
    expect(ids).toHaveLength(2)
    for (const id of ids) {
      await expect(store.read(id)).resolves.toBeDefined()
    }
  })
})

describe("the reader parses each response once", () => {
  const body = JSON.stringify({ ID, Name: "BATL", Events: [] })

  /**
   * Counts parses *of this body only*. A blanket JSON.parse spy also catches
   * whatever the test runner does across an await, which is not what is being
   * measured here.
   */
  const counting = () => {
    const real = JSON.parse
    let calls = 0
    JSON.parse = ((...args: Parameters<typeof real>) => {
      if (args[0] === body) calls++
      return real(...args)
    }) as typeof JSON.parse
    return { calls: () => calls, restore: () => (JSON.parse = real) }
  }

  const reader = (onFetch?: () => void) =>
    new HttpAcsmReader({
      baseUrl: "https://acsm.example",
      rateLimit: false,
      fetch: async () => {
        onFetch?.()
        return new Response(body, { status: 200 })
      },
    })

  it("parses once for the typed export", async () => {
    // A championship export is the largest body this client sees, and the
    // archive fetches one per championship per run. Validating by parsing and
    // then parsing again for the caller doubled that for no gain.
    const spy = counting()
    try {
      await reader().exportChampionship(ID)
      expect(spy.calls()).toBe(1)
    } finally {
      spy.restore()
    }
  })

  it("parses once for the raw export too, and returns the exact bytes", async () => {
    const spy = counting()
    try {
      const raw = await reader().exportChampionshipRaw(ID)
      expect(spy.calls()).toBe(1)
      expect(raw).toBe(body)
    } finally {
      spy.restore()
    }
  })

  it("still rejects a non-JSON body, which is how a login redirect shows up", async () => {
    const html = new HttpAcsmReader({
      baseUrl: "https://acsm.example",
      rateLimit: false,
      fetch: async () => new Response("<html>login</html>", { status: 200 }),
    })
    await expect(html.exportChampionshipRaw(ID)).rejects.toThrow(/Public Access/)
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
      "a..b/../..",
    ]) {
      expect(() => assertSafeChampionshipId(bad), bad).toThrow(UnsafeArchivePath)
    }
  })

  it("accepts the UUIDs ACSM actually issues", () => {
    expect(() => assertSafeChampionshipId(ID)).not.toThrow()
  })

  it("is a containment check, not a UUID check", () => {
    // Stated explicitly because the two are easy to conflate. The archive
    // exists so history isn't lost; refusing to store a championship whose ID
    // merely has an unfamiliar *shape* would cause the loss it prevents. Only
    // escaping the directory is a reason to refuse.
    for (const unusual of ["champ-1", "2026-08-summer-series", "ABC123", "a"]) {
      expect(() => assertSafeChampionshipId(unusual), unusual).not.toThrow()
    }
  })

  it("refuses '..' anywhere, as defence in depth", () => {
    // "a..b" cannot traverse — the pattern already forbids separators — so
    // this is belt and braces against the pattern being widened later. Pinned
    // so the redundancy is deliberate rather than accidental.
    expect(() => assertSafeChampionshipId("a..b")).toThrow(UnsafeArchivePath)
  })

  it("applies the same rule to snapshot filenames, which are not UUIDs", () => {
    // readSnapshot runs the filename through this too, so a UUID-strict check
    // would break reading back every snapshot the store ever wrote.
    const file = snapshotFileName(at("2026-08-24T17:00:00Z"))
    expect(() => assertSafePathSegment(file, "a snapshot filename")).not.toThrow()
    expect(() => assertSafePathSegment("../index.json", "a snapshot filename")).toThrow(
      /not a single path segment/,
    )
  })

  it("names what it rejected, and what it was being used as", () => {
    expect(() => assertSafeChampionshipId("../x")).toThrow(/"\.\.\/x".*championship directory name/)
    expect(() => assertSafePathSegment("../x", "a snapshot filename")).toThrow(
      /snapshot filename/,
    )
  })

  it("refuses to write outside the archive", async () => {
    const store = new FileArchiveStore(root)
    await expect(
      store.put("../escaped", '{"a":1}', at("2026-08-24T17:00:00Z")),
    ).rejects.toThrow(UnsafeArchivePath)
  })

  it("refuses to read outside the archive", async () => {
    const store = new FileArchiveStore(root)
    await store.put(ID, '{"a":1}', at("2026-08-24T17:00:00Z"))
    await expect(store.readSnapshot(ID, "../../etc/passwd")).rejects.toThrow(UnsafeArchivePath)
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

  it("rejects extra positional arguments", () => {
    // No command takes a target, so an extra word is a typo or a value that
    // drifted off its option. Ignoring it would look like a clean run against
    // the default archive directory.
    expect(() => parseArgs(["run", "extra"])).toThrow(UsageError)
    expect(() => parseArgs(["run", "extra"])).toThrow(/takes no arguments/)
    expect(() => parseArgs(["status", "/tmp/archive"])).toThrow(/takes no arguments/)
    expect(() => parseArgs(["run", "a", "b"])).toThrow(/"a", "b"/)
  })

  it("still accepts a bare command", () => {
    expect(parseArgs(["run"]).command).toBe("run")
    expect(parseArgs(["status", "--json"]).command).toBe("status")
    expect(parseArgs([]).command).toBe("")
  })
})
