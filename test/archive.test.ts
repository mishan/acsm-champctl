import { mkdtemp, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { AcsmError, HttpAcsmReader, type AcsmReader } from "../src/acsm/client.js"
import type { Championship, ChampionshipSummary } from "../src/acsm/types.js"
import { ingest, IngestError, type IngestReport } from "../src/archive/ingest.js"
import {
  main as archiveMain,
  describe as describeOutcome,
  exitCodeFor,
  parseArgs,
  summarise,
} from "../src/cli/archive.js"
import { UsageError } from "../src/cli/args.js"
import { SqliteArchiveStore, sha256 } from "../src/archive/store.js"

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "champctl-archive-"))
})

afterEach(async () => {
  for (const s of stores.splice(0)) s.close()
  await rm(root, { recursive: true, force: true })
})

const ID = "11111111-2222-3333-4444-555555555555"
const OTHER = "99999999-8888-7777-6666-555555555555"

const at = (iso: string): Date => new Date(iso)

/** The store deals in bytes, so the fixtures do too. */
const b = (s: string): Buffer => Buffer.from(s, "utf8")

/**
 * A fresh store per test.
 *
 * In memory by default: these assert behaviour, not durability, and an
 * in-memory database starts empty every time with no cleanup. The few tests
 * about persistence and locking open a real file under `root` and say so.
 */
const stores: SqliteArchiveStore[] = []
const newStore = async (): Promise<SqliteArchiveStore> => {
  const s = await SqliteArchiveStore.open(":memory:")
  stores.push(s)
  return s
}

describe("archive store", () => {
  it("stores the body byte for byte", async () => {
    // The archive's whole value is that it is still trustworthy after the
    // source is gone, so it must not normalise anything. This body has key
    // ordering and spacing that JSON.stringify would not reproduce.
    const s = await newStore()
    const body = b('{"Name":"BATL",   "ID":"x",\n "Events":[1.0, 2.50]}')
    const { snapshot } = await s.put(ID, body, at("2026-08-24T17:00:00Z"))

    expect((await s.readSnapshot(ID, snapshot.id)).equals(body)).toBe(true)
  })

  it("stores bytes a UTF-8 decode would have changed", async () => {
    // The reason put takes a Buffer and the column is BLOB rather than TEXT.
    // Response.text() strips a leading BOM and replaces every invalid sequence
    // with U+FFFD, so a string-typed pipeline stores something the server never
    // sent — and sha256 then describes the substitution rather than the source.
    const s = await newStore()
    const body = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      b('{"a":1,"bad":"'),
      Buffer.from([0xff]),
      b('"}'),
    ])

    const { snapshot } = await s.put(ID, body, at("2026-08-24T17:00:00Z"))
    const back = await s.readSnapshot(ID, snapshot.id)

    expect(back.equals(body)).toBe(true)
    expect(snapshot.bytes).toBe(body.byteLength)
    // A round trip through a string would have lost the BOM and turned 0xff
    // into three replacement bytes, so this would not match.
    expect(back.equals(b(body.toString("utf8")))).toBe(false)
  })

  it("writes one snapshot per change, not per run", async () => {
    const s = await newStore()
    const body = b('{"a":1}')

    const first = await s.put(ID, body, at("2026-08-24T17:00:00Z"))
    const second = await s.put(ID, body, at("2026-08-25T17:00:00Z"))
    const third = await s.put(ID, b('{"a":2}'), at("2026-08-26T17:00:00Z"))

    expect(first.stored).toBe(true)
    expect(second.stored).toBe(false)
    expect(third.stored).toBe(true)
    expect((await s.read(ID))?.snapshots).toHaveLength(2)
  })

  it("records that an unchanged run happened", async () => {
    // Otherwise there is no way to tell "nothing changed" from "the job has
    // been silently failing for a month".
    const s = await newStore()
    await s.put(ID, b('{"a":1}'), at("2026-08-24T17:00:00Z"))
    await s.put(ID, b('{"a":1}'), at("2026-08-25T17:00:00Z"))

    const index = await s.read(ID)
    expect(index?.snapshots).toHaveLength(1)
    expect(index?.lastCheckedAt).toBe("2026-08-25T17:00:00.000Z")
    expect(index?.firstSeen).toBe("2026-08-24T17:00:00.000Z")
  })

  it("keeps the change history in order, with the name at the time", async () => {
    const s = await newStore()
    await s.put(ID, b('{"a":1}'), at("2026-08-24T17:00:00Z"), "August")
    await s.put(ID, b('{"a":2}'), at("2026-09-24T17:00:00Z"), "September")

    const index = await s.read(ID)
    expect(index?.snapshots.map((x) => x.name)).toEqual(["August", "September"])
    expect(index?.snapshots.map((x) => x.fetchedAt)).toEqual([
      "2026-08-24T17:00:00.000Z",
      "2026-09-24T17:00:00.000Z",
    ])
  })

  it("dedupes against the latest snapshot, not any earlier one", async () => {
    // A championship that changes and then reverts should record the revert as
    // its own snapshot; treating it as a duplicate of the older body would
    // lose the fact that it changed twice.
    const s = await newStore()
    await s.put(ID, b('{"a":1}'), at("2026-08-24T17:00:00Z"))
    await s.put(ID, b('{"a":2}'), at("2026-08-25T17:00:00Z"))
    const back = await s.put(ID, b('{"a":1}'), at("2026-08-26T17:00:00Z"))

    expect(back.stored).toBe(true)
    expect((await s.read(ID))?.snapshots).toHaveLength(3)
  })

  it("keeps championships apart", async () => {
    const s = await newStore()
    await s.put(ID, b('{"a":1}'), at("2026-08-24T17:00:00Z"))
    await s.put(OTHER, b('{"a":1}'), at("2026-08-24T17:00:00Z"))

    expect(await s.list()).toEqual([ID, OTHER].sort())
    expect((await s.read(OTHER))?.snapshots).toHaveLength(1)
  })

  it("records the hash and byte length of the stored bytes", async () => {
    const s = await newStore()
    const text = '{"a":"ä"}'
    const body = b(text)
    const { snapshot } = await s.put(ID, body, at("2026-08-24T17:00:00Z"))
    expect(snapshot.sha256).toBe(sha256(body))
    expect(snapshot.bytes).toBe(body.byteLength)
    expect(snapshot.bytes).not.toBe(text.length)
  })

  it("returns nothing for a championship it has never seen", async () => {
    const s = await newStore()
    expect(await s.read(ID)).toBeUndefined()
    expect(await s.list()).toEqual([])
  })

  it("says which snapshot is missing rather than returning nothing", async () => {
    const s = await newStore()
    await expect(s.readSnapshot(ID, 999)).rejects.toThrow(/No snapshot/)
  })

  it("rolls the whole put back when the snapshot insert fails", async () => {
    // The bug the file layout kept producing in different forms: a body and an
    // index entry are two writes, and an interruption between them left one
    // without the other. put() upserts the championship row *before* inserting
    // the snapshot, so if only the second fails, lastCheckedAt must not have
    // moved either. Forced with a trigger, since there is otherwise no way to
    // fail one statement and not the other.
    const path = join(root, "rollback.db")
    const s = await SqliteArchiveStore.open(path)
    try {
      await s.put(ID, b('{"a":1}'), at("2026-08-24T17:00:00Z"))

      const raw = new DatabaseSync(path)
      raw.exec(
        `CREATE TRIGGER no_more BEFORE INSERT ON snapshot
         BEGIN SELECT RAISE(ABORT, 'no'); END`,
      )
      raw.close()

      await expect(s.put(ID, b('{"a":2}'), at("2026-08-26T17:00:00Z"))).rejects.toThrow()

      const index = await s.read(ID)
      expect(index?.snapshots).toHaveLength(1)
      // The upsert ran first inside the same transaction; it has to be gone too.
      expect(index?.lastCheckedAt).toBe("2026-08-24T17:00:00.000Z")
    } finally {
      s.close()
    }
  })

  it("stores two bodies fetched in the same millisecond", async () => {
    // fetched_at was the primary key, so two runs fetching different bodies in
    // the same millisecond collided and the second was rolled back — losing an
    // archive state, which is the one thing this module must not do. Snapshots
    // have their own id now, and fetched_at is ordering metadata.
    const s = await newStore()
    const when = at("2026-08-24T17:00:00Z")
    const first = await s.put(ID, b('{"a":1}'), when)
    const second = await s.put(ID, b('{"a":2}'), when)

    expect(second.stored).toBe(true)
    expect(second.snapshot.id).not.toBe(first.snapshot.id)
    expect((await s.read(ID))?.snapshots).toHaveLength(2)
    expect((await s.readSnapshot(ID, first.snapshot.id)).toString()).toBe('{"a":1}')
    expect((await s.readSnapshot(ID, second.snapshot.id)).toString()).toBe('{"a":2}')
  })

  it("keeps lastCheckedAt and firstSeen monotonic when writers land out of order", async () => {
    // Two processes take the write lock in whatever order they get it, which
    // is not necessarily the order they fetched in. Assigning last_checked
    // outright let a slow older run drag it backwards, and --since would then
    // re-fetch everything it had already done.
    const s = await newStore()
    await s.put(ID, b('{"a":1}'), at("2026-08-25T17:00:00Z"))
    await s.put(ID, b('{"a":1}'), at("2026-08-20T17:00:00Z")) // a delayed older run

    const index = await s.read(ID)
    expect(index?.lastCheckedAt).toBe("2026-08-25T17:00:00.000Z")
    expect(index?.firstSeen).toBe("2026-08-20T17:00:00.000Z")
  })

  it("cannot record a hash for a body it does not hold", async () => {
    // Dedup used to compare against a hash in a separate index file, so
    // deleting a snapshot left the hash vouching for bytes that were gone —
    // and every later run reported "unchanged" and moved lastCheckedAt on,
    // masking the loss permanently. One row makes that unrepresentable.
    const s = await newStore()
    await s.put(ID, b('{"a":1}'), at("2026-08-24T17:00:00Z"))

    const index = await s.read(ID)
    for (const snap of index?.snapshots ?? []) {
      const body = await s.readSnapshot(ID, snap.id)
      expect(sha256(body)).toBe(snap.sha256)
      expect(body.byteLength).toBe(snap.bytes)
    }
  })

  it("excludes a second writer while a write transaction is open", async () => {
    // Two awaited put()s never overlap, so the first version of this test
    // passed with or without any locking and proved nothing. This one holds a
    // write transaction open on a separate connection, which is the same
    // situation from the loser's point of view: someone else has the lock.
    //
    // What it proves is that a put refused for that reason writes *nothing* —
    // not that IMMEDIATE beats DEFERRED. Measured: it passes under both. The
    // test below is the one that separates them.
    //
    // node:sqlite is synchronous, so a second writer cannot run while the
    // first is mid-call inside one process. busyTimeoutMs is tiny so the test
    // doesn't sit for the real five seconds.
    const path = join(root, "concurrent.db")
    const holder = new DatabaseSync(path)
    const s = await SqliteArchiveStore.open(path, { busyTimeoutMs: 50 })
    try {
      await s.put(ID, b('{"a":1}'), at("2026-08-24T17:00:00Z"))

      holder.exec("PRAGMA busy_timeout = 50")
      holder.exec("BEGIN IMMEDIATE")

      // The lock is held elsewhere, so this must fail rather than interleave.
      await expect(s.put(ID, b('{"a":2}'), at("2026-08-25T17:00:00Z"))).rejects.toThrow(
        /SQLITE_BUSY|database is locked/i,
      )

      // Nothing half-written: the refused put left the archive as it was.
      holder.exec("ROLLBACK")
      const index = await s.read(ID)
      expect(index?.snapshots).toHaveLength(1)
      expect(index?.lastCheckedAt).toBe("2026-08-24T17:00:00.000Z")

      // And once the lock is free the same write goes through.
      const after = await s.put(ID, b('{"a":2}'), at("2026-08-25T17:00:00Z"))
      expect(after.stored).toBe(true)
      expect((await s.read(ID))?.snapshots).toHaveLength(2)
    } finally {
      holder.close()
      s.close()
    }
  })

  it("takes the write lock before the read, so a racing commit waits its turn", async () => {
    // Why put() uses BEGIN IMMEDIATE rather than plain BEGIN, at the SQL level
    // — the store's own API is synchronous end to end, so there is no way to
    // land a commit between its SELECT and its INSERT from in here.
    //
    // Measured, on this Node's SQLite: under DEFERRED the read takes a
    // snapshot, and if anyone commits before the upgrade to a write, the
    // upgrade fails outright. busy_timeout does not retry that one — it is a
    // stale-snapshot error, not a lock-contention error — so a nightly job
    // overlapping a manual run would fail rather than queue. IMMEDIATE takes
    // the write lock up front, so the *other* writer is the one that waits.
    const attempt = (mode: "DEFERRED" | "IMMEDIATE") => {
      const path = join(root, `mode-${mode}.db`)
      const setup = new DatabaseSync(path)
      setup.exec("PRAGMA journal_mode = WAL")
      setup.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)")
      setup.close()

      const ours = new DatabaseSync(path)
      const other = new DatabaseSync(path)
      ours.exec("PRAGMA busy_timeout = 200")
      other.exec("PRAGMA busy_timeout = 200")
      try {
        ours.exec(`BEGIN ${mode}`)
        ours.prepare("SELECT count(*) AS c FROM t").get() // the read-modify-write's read

        let otherCommitted = true
        try {
          other.exec("BEGIN IMMEDIATE")
          other.prepare("INSERT INTO t(v) VALUES(?)").run("them")
          other.exec("COMMIT")
        } catch {
          otherCommitted = false
        }

        let ourWrite = "ok"
        try {
          ours.prepare("INSERT INTO t(v) VALUES(?)").run("us")
          ours.exec("COMMIT")
        } catch (e) {
          ourWrite = (e as { code?: string }).code ?? "failed"
          try {
            ours.exec("ROLLBACK")
          } catch {
            /* already rolled back */
          }
        }
        return { otherCommitted, ourWrite }
      } finally {
        ours.close()
        other.close()
      }
    }

    // DEFERRED: they get in first, and our upgrade is refused.
    expect(attempt("DEFERRED")).toEqual({ otherCommitted: true, ourWrite: "ERR_SQLITE_ERROR" })
    // IMMEDIATE: we hold the lock, so they wait and we complete.
    expect(attempt("IMMEDIATE")).toEqual({ otherCommitted: false, ourWrite: "ok" })
  })

  it("persists across reopening, which is the point of an archive", async () => {
    const path = join(root, "persist.db")
    const first = await SqliteArchiveStore.open(path)
    await first.put(ID, b('{"a":1}'), at("2026-08-24T17:00:00Z"), "August")
    first.close()

    const second = await SqliteArchiveStore.open(path)
    try {
      const index = await second.read(ID)
      expect(index?.snapshots).toHaveLength(1)
      expect(index?.snapshots[0]?.name).toBe("August")
      expect((await second.readSnapshot(ID, index?.snapshots[0]?.id as number)).toString()).toBe(
        '{"a":1}',
      )
    } finally {
      second.close()
    }
  })

  it("creates the directory the database is asked to live in", async () => {
    const path = join(root, "nested", "deeper", "archive.db")
    const s = await SqliteArchiveStore.open(path)
    try {
      await s.put(ID, b('{"a":1}'), at("2026-08-24T17:00:00Z"))
      expect((await s.read(ID))?.snapshots).toHaveLength(1)
    } finally {
      s.close()
    }
  })

  it("takes an id that would have been an unsafe path segment", async () => {
    // The file layout turned ids into directory names, so "../../etc" had to be
    // refused — and a future ACSM issuing a non-UUID id risked being refused
    // with it, turning an unrecognised id into the data loss the archive exists
    // to prevent. Bound parameters make the question go away.
    const s = await newStore()
    for (const odd of ["../../etc", "a/b", "index.json", "  ", "ünïcode"]) {
      await s.put(odd, b('{"id":1}'), at("2026-08-24T17:00:00Z"))
    }
    expect(await s.list()).toHaveLength(5)
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
      expect(raw.toString("utf8")).toBe(body)
    } finally {
      spy.restore()
    }
  })

  it("returns the bytes a UTF-8 decode would have mangled", async () => {
    // The end-to-end version of the store's byte-fidelity test: a body that
    // Response.text() would silently rewrite has to survive the client too,
    // otherwise the archive stores a substitution no matter what put() takes.
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]), // BOM
      Buffer.from('{"ok":true}', "utf8"),
    ])
    const bom = new HttpAcsmReader({
      baseUrl: "https://acsm.example",
      rateLimit: false,
      fetch: async () => new Response(bytes, { status: 200 }),
    })

    const raw = await bom.exportChampionshipRaw(ID)
    // The BOM is still there — and it still parsed, because the parse runs on
    // a decoded copy with the BOM dropped rather than on the stored bytes.
    expect(raw.equals(bytes)).toBe(true)
    expect(raw.subarray(0, 3).toString("hex")).toBe("efbbbf")
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
      return b(options.bodies?.[id] ?? `{"ID":"${id}"}`)
    },
    async exportChampionship(id: string) {
      return JSON.parse((await this.exportChampionshipRaw(id)).toString("utf8")) as Championship
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
    const store = await newStore()
    const reader = fakeReader({ summaries: [{ ID: ID, Name: "August" }, { ID: OTHER }] })

    const report = await ingest(reader, store, { now: clock("2026-08-24T17:00:00Z") })

    expect(report.stored).toBe(2)
    expect(report.failed).toBe(0)
    expect(await store.list()).toEqual([ID, OTHER].sort())
  })

  it("keeps going when one championship fails", async () => {
    // The point of a nightly job is that the archive gets no worse. One bad
    // championship must not cost the other thirty.
    const store = await newStore()
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
    const store = await newStore()
    const reader = fakeReader({ summaries: [], failList: "Public Access is off" })
    await expect(ingest(reader, store)).rejects.toBeInstanceOf(IngestError)
  })

  it("reports a list entry with no ID rather than dropping it", async () => {
    const store = await newStore()
    const reader = fakeReader({ summaries: [{ Name: "Nameless" }, { ID }] })

    const report = await ingest(reader, store, { now: clock("2026-08-24T17:00:00Z") })
    expect(report.failed).toBe(1)
    expect(report.stored).toBe(1)
  })

  it("fetches a duplicated list entry only once", async () => {
    const store = await newStore()
    const reader = fakeReader({ summaries: [{ ID }, { ID }] })

    const report = await ingest(reader, store, { now: clock("2026-08-24T17:00:00Z") })
    expect(reader.fetched).toEqual([ID])
    expect(report.outcomes).toHaveLength(1)
  })

  it("counts an unchanged championship separately from a stored one", async () => {
    const store = await newStore()
    const reader = fakeReader({ summaries: [{ ID }] })

    await ingest(reader, store, { now: clock("2026-08-24T17:00:00Z") })
    const second = await ingest(reader, store, { now: clock("2026-08-25T17:00:00Z") })

    expect(second.stored).toBe(0)
    expect(second.unchanged).toBe(1)
  })

  it("can skip championships already checked recently", async () => {
    // So a re-run after a partial failure doesn't refetch everything.
    const store = await newStore()
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
    const store = await newStore()
    const body = `{"Name":"BATL",   "ID":"${ID}",\n "x":1.0}`
    const reader = fakeReader({ summaries: [{ ID }], bodies: { [ID]: body } })

    await ingest(reader, store, { now: clock("2026-08-24T17:00:00Z") })

    const index = await store.read(ID)
    const id = index?.snapshots[0]?.id as number
    expect((await store.readSnapshot(ID, id)).toString("utf8")).toBe(body)
  })

  it("does not let a later success hide an earlier failure", async () => {
    // The exit code is what a cron job acts on, so "archived 30, failed 1"
    // has to surface the 1.
    const store = await newStore()
    const reader = fakeReader({
      summaries: [{ ID }, { ID: OTHER }],
      fail: { [ID]: "boom" },
    })
    const report = await ingest(reader, store, { now: clock("2026-08-24T17:00:00Z") })
    expect(exitCodeFor(report)).toBe(2)
  })

  it("reports progress as it goes", async () => {
    const store = await newStore()
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
  it("reports an unknown command without creating a database", async () => {
    // The store used to be opened before the command was checked, so a typo
    // left an empty archive file behind — or failed with a SQLite error —
    // instead of saying which command it didn't recognise.
    const db = join(root, "should-not-exist.db")
    const original = process.stderr.write.bind(process.stderr)
    let err = ""
    process.stderr.write = ((chunk: string | Uint8Array) => {
      err += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)
      return true
    }) as typeof process.stderr.write
    try {
      expect(await archiveMain(["frobnicate", "--db", db])).toBe(3)
    } finally {
      process.stderr.write = original
    }
    expect(err).toContain("Unknown command frobnicate")
    expect(err).toContain("Usage:")
    expect(existsSync(db)).toBe(false)
  })

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
    const args = parseArgs([
      "run",
      "--db",
      "/tmp/a.db",
      "--since",
      "2026-08-24T00:00:00Z",
      "--json",
    ])
    expect(args.command).toBe("run")
    expect(args.db).toBe("/tmp/a.db")
    expect(args.json).toBe(true)
    expect(args.since?.toISOString()).toBe("2026-08-24T00:00:00.000Z")
  })

  it("rejects a bad --since rather than archiving against a NaN date", () => {
    expect(() => parseArgs(["run", "--since", "last tuesday"])).toThrow(UsageError)
  })

  it("rejects an unknown option instead of ignoring it", () => {
    expect(() => parseArgs(["run", "--dry-run"])).toThrow(UsageError)
    expect(() => parseArgs(["run", "--db"])).toThrow(/needs a value/)
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
