import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { describe, expect, it } from "vitest"

import { SqliteSubmissionQueue } from "../src/liveries/queue.js"

const CAR = "rss_formula_hybrid_2021"
const CHAMP = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
const OTHER = "11111111-2222-3333-4444-555555555555"
const MISHA = "111111111111111111"
const POSTAL = "222222222222222222"

const bytes = (s: string) => new TextEncoder().encode(s)
const text = (b: Uint8Array) => new TextDecoder().decode(b)

const at = (iso: string) => new Date(iso)
const MON = at("2026-09-01T20:00:00.000Z")
const TUE = at("2026-09-02T20:00:00.000Z")

const open = () => SqliteSubmissionQueue.open(":memory:")

/**
 * A queue on a real file, plus a second connection to look at the bytes.
 *
 * Retention is one of the two things bounding disk on this feature and the
 * public surface cannot see it: `queuedBytes` sums `WHERE state = 'queued'`, so
 * a superseded row's blob is invisible to it and the tests that claimed to
 * check the drop would have passed with `body = NULL` deleted. Reading the
 * column directly is the only way to assert the property the comments promise.
 */
const onDisk = async () => {
  const dir = await mkdtemp(join(tmpdir(), "champctl-queue-"))
  const path = join(dir, "liveries.db")
  const queue = await SqliteSubmissionQueue.open(path)
  const peek = new DatabaseSync(path)
  const bodiesByState = (state: string): (Uint8Array | null)[] =>
    (
      peek
        .prepare("SELECT body FROM livery_submission WHERE state = ? ORDER BY id")
        .all(state) as unknown as { body: Uint8Array | null }[]
    ).map((r) => r.body)
  return {
    queue,
    bodiesByState,
    close: async () => {
      peek.close()
      queue.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

const submission = (over: Partial<Parameters<SqliteSubmissionQueue["submit"]>[0]> = {}) => ({
  discordUserId: MISHA,
  discordHandle: "misha",
  championshipId: CHAMP,
  driverName: "Misha",
  carModel: CAR,
  skinFolder: "Misha",
  body: bytes("zip bytes"),
  at: MON,
  ...over,
})

describe("SqliteSubmissionQueue", () => {
  it("queues a submission and hands the bytes back untouched", async () => {
    const queue = await open()
    const result = await queue.submit(submission())
    expect(result.submission).toMatchObject({
      discordUserId: MISHA,
      driverName: "Misha",
      state: "queued",
      bytes: 9,
    })

    const [waiting] = await queue.queued(CHAMP)
    // As received, not as unpacked. The drain re-runs the checks on the same
    // input rather than trusting an unpacking the bot did an hour ago.
    expect(text(waiting?.body ?? new Uint8Array())).toBe("zip bytes")
    queue.close()
  })

  it("supersedes an earlier upload from the same driver", async () => {
    // Both were always going to land on the same skin folder. Queuing both
    // means uploading the dead one first and then overwriting it.
    const queue = await open()
    await queue.submit(submission({ body: bytes("v1") }))
    const second = await queue.submit(submission({ body: bytes("v2"), at: TUE }))

    expect(second.superseded).toMatchObject({ state: "queued" })
    const waiting = await queue.queued(CHAMP)
    expect(waiting).toHaveLength(1)
    expect(text(waiting[0]?.body ?? new Uint8Array())).toBe("v2")
    queue.close()
  })

  it("drops the superseded bytes rather than keeping dead artwork", async () => {
    const { queue, bodiesByState, close } = await onDisk()
    await queue.submit(submission({ body: bytes("v1") }))
    await queue.submit(submission({ body: bytes("v2"), at: TUE }))

    const history = await queue.history(CHAMP)
    expect(history.find((h) => h.state === "superseded")?.reason).toMatch(
      /replaced by a later upload/,
    )
    // The row survives as an audit line; the artwork does not. Asserted on the
    // column, because queuedBytes() sums only queued rows and would read the
    // same either way.
    expect(bodiesByState("superseded")).toEqual([null])
    expect(bodiesByState("queued")).toHaveLength(1)
    await close()
  })

  it("keeps two drivers' submissions apart", async () => {
    const queue = await open()
    await queue.submit(submission())
    await queue.submit(
      submission({ discordUserId: POSTAL, driverName: "postaL", skinFolder: "postaL" }),
    )
    expect((await queue.queued(CHAMP)).map((s) => s.driverName)).toEqual(["Misha", "postaL"])
    queue.close()
  })

  it("keeps the same driver's two cars apart", async () => {
    const queue = await open()
    await queue.submit(submission())
    await queue.submit(submission({ carModel: "ford_transit" }))
    expect(await queue.queued(CHAMP)).toHaveLength(2)
    queue.close()
  })

  it("keeps championships apart", async () => {
    const queue = await open()
    await queue.submit(submission())
    await queue.submit(submission({ championshipId: OTHER }))
    expect(await queue.queued(CHAMP)).toHaveLength(1)
    expect(await queue.queued(OTHER)).toHaveLength(1)
    queue.close()
  })

  it("hands them back oldest first", async () => {
    const queue = await open()
    await queue.submit(submission({ driverName: "Zed", skinFolder: "Zed" }))
    await queue.submit(submission({ driverName: "Ann", skinFolder: "Ann", discordUserId: POSTAL }))
    expect((await queue.queued(CHAMP)).map((s) => s.driverName)).toEqual(["Zed", "Ann"])
    queue.close()
  })

  it("empties applied submissions but keeps the audit line", async () => {
    // store.ts holds the artwork now, and two copies is one too many — but
    // "who uploaded the thing that broke Suzuka" still needs an answer.
    const queue = await open()
    const first = await queue.submit(submission())
    expect(await queue.markApplied([first.submission.id], TUE)).toBe(1)

    expect(await queue.queued(CHAMP)).toEqual([])
    expect(await queue.queuedBytes()).toBe(0)
    const [line] = await queue.history(CHAMP)
    expect(line).toMatchObject({ state: "applied", discordUserId: MISHA, driverName: "Misha" })
    queue.close()
  })

  it("really does empty an applied submission's blob", async () => {
    // store.ts holds the artwork once it is applied, and two copies of a
    // driver's zip is one copy too many. Same reason as the superseded case:
    // the public surface cannot see this column.
    const { queue, bodiesByState, close } = await onDisk()
    const first = await queue.submit(submission())
    await queue.markApplied([first.submission.id], TUE)
    expect(bodiesByState("applied")).toEqual([null])
    await close()
  })

  it("really does empty a refused submission's blob", async () => {
    const { queue, bodiesByState, close } = await onDisk()
    const first = await queue.submit(submission())
    await queue.markRefused(first.submission.id, "not a livery", TUE)
    expect(bodiesByState("refused")).toEqual([null])
    await close()
  })

  it("won't apply a submission twice", async () => {
    const queue = await open()
    const first = await queue.submit(submission())
    await queue.markApplied([first.submission.id], TUE)
    expect(await queue.markApplied([first.submission.id], TUE)).toBe(0)
    queue.close()
  })

  it("keeps a refusal with the sentence the driver was given", async () => {
    // Four drivers fighting the extension allowlist on a Tuesday is the signal
    // that the documentation is wrong, and it is invisible if refusals are
    // thrown away.
    const queue = await open()
    const first = await queue.submit(submission())
    await queue.markRefused(first.submission.id, "no .dds in it", TUE)

    const [line] = await queue.history(CHAMP)
    expect(line).toMatchObject({ state: "refused", reason: "no .dds in it" })
    expect(await queue.queued(CHAMP)).toEqual([])
    queue.close()
  })

  it("reports when a driver last had one accepted", async () => {
    const queue = await open()
    expect(await queue.lastAcceptedAt(MISHA)).toBeUndefined()
    await queue.submit(submission())
    expect(await queue.lastAcceptedAt(MISHA)).toEqual(MON)
    queue.close()
  })

  it("does not count a refused submission against the cooldown", async () => {
    // A driver iterating on a zip that keeps being rejected is doing exactly
    // what the refusals are for.
    const queue = await open()
    const first = await queue.submit(submission())
    await queue.markRefused(first.submission.id, "leftover .psd", MON)
    expect(await queue.lastAcceptedAt(MISHA)).toBeUndefined()
    queue.close()
  })

  it("still counts an applied submission against the cooldown", async () => {
    const queue = await open()
    const first = await queue.submit(submission())
    await queue.markApplied([first.submission.id], TUE)
    expect(await queue.lastAcceptedAt(MISHA)).toEqual(MON)
    queue.close()
  })

  it("totals only what is still waiting, across championships", async () => {
    const queue = await open()
    await queue.submit(submission({ body: bytes("aaaa") }))
    await queue.submit(submission({ championshipId: OTHER, body: bytes("bbbbbb") }))
    expect(await queue.queuedBytes()).toBe(10)
    queue.close()
  })

  it("has an empty queue for a championship nobody has uploaded for", async () => {
    const queue = await open()
    expect(await queue.queued(CHAMP)).toEqual([])
    expect(await queue.history(CHAMP)).toEqual([])
    queue.close()
  })

  it("shows history newest first", async () => {
    const queue = await open()
    await queue.submit(submission({ driverName: "Ann", skinFolder: "Ann" }))
    await queue.submit(submission({ driverName: "Bob", skinFolder: "Bob", discordUserId: POSTAL }))
    expect((await queue.history(CHAMP)).map((h) => h.driverName)).toEqual(["Bob", "Ann"])
    queue.close()
  })
})

/**
 * The heartbeat that keeps `autoApply` honest.
 *
 * The timer lives in champctl-liveries, which holds the ACSM credentials the
 * bot must never have — so the profile flag is a claim about a different
 * process, and without something to check it an operator who sets the flag and
 * forgets the watcher has every driver told "shortly" for ever.
 */
describe("the drain heartbeat", () => {
  it("has nothing to report before a drain has ever run", async () => {
    const queue = await open()
    expect(await queue.lastDrainRun(CHAMP)).toBeUndefined()
    queue.close()
  })

  it("records when a drain ran", async () => {
    const queue = await open()
    await queue.recordDrainRun(CHAMP, MON)
    expect(await queue.lastDrainRun(CHAMP)).toEqual(MON)
    queue.close()
  })

  it("moves forward rather than accumulating", async () => {
    const queue = await open()
    await queue.recordDrainRun(CHAMP, MON)
    await queue.recordDrainRun(CHAMP, TUE)
    expect(await queue.lastDrainRun(CHAMP)).toEqual(TUE)
    queue.close()
  })

  it("keeps championships apart, since a watcher runs per championship", async () => {
    const queue = await open()
    await queue.recordDrainRun(CHAMP, MON)
    expect(await queue.lastDrainRun(OTHER)).toBeUndefined()
    queue.close()
  })
})

describe("the drain lease", () => {
  // Two connections to one file, not two calls on one connection. The race this
  // guards is the watcher in one process against an operator's CLI run in
  // another, and a single in-memory handle would prove nothing about that.
  //
  // What these pin is that a second connection is refused, taken over on
  // expiry, and cannot be renewed or released by a lapsed holder. What they do
  // NOT pin is the atomicity of the read-then-write inside `acquireDrainLease`:
  // node:sqlite is synchronous, so nothing running in one Node process can
  // interleave two of them, and `Promise.all` below only proves the second call
  // sees the first one's committed row. BEGIN IMMEDIATE is what makes the
  // interleaved case safe and it is not tested here.
  const twoProcesses = async () => {
    const dir = await mkdtemp(join(tmpdir(), "champctl-lease-"))
    const db = join(dir, "liveries.db")
    const a = await SqliteSubmissionQueue.open(db)
    const b = await SqliteSubmissionQueue.open(db)
    return {
      a,
      b,
      dir,
      close: async () => {
        a.close()
        b.close()
        await rm(dir, { recursive: true, force: true })
      },
    }
  }

  it("refuses the second process while the first holds it", async () => {
    const { a, b, close } = await twoProcesses()
    const [first, second] = await Promise.all([
      a.acquireDrainLease(CHAMP, "host:1", MON, 60_000),
      b.acquireDrainLease(CHAMP, "host:2", MON, 60_000),
    ])
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1)
    const loser = first.ok ? second : first
    expect(loser).toMatchObject({ ok: false })
    await close()
  })

  it("names who is holding it, so the operator knows what to wait for", async () => {
    const { a, b, close } = await twoProcesses()
    await a.acquireDrainLease(CHAMP, "titan:4242", MON, 60_000)
    expect(await b.acquireDrainLease(CHAMP, "titan:9999", MON, 60_000)).toMatchObject({
      ok: false,
      heldBy: "titan:4242",
    })
    await close()
  })

  it("holds one championship without holding another", async () => {
    const { a, b, close } = await twoProcesses()
    await a.acquireDrainLease(CHAMP, "host:1", MON, 60_000)
    expect(await b.acquireDrainLease(OTHER, "host:2", MON, 60_000)).toMatchObject({ ok: true })
    await close()
  })

  it("takes over a lease whose holder is gone", async () => {
    // Without this one `kill -9` during a drain locks the championship out
    // until somebody finds the row by hand, which is worse than the race the
    // lease prevents.
    const { a, b, close } = await twoProcesses()
    await a.acquireDrainLease(CHAMP, "host:1", MON, 60_000)
    const later = new Date(MON.getTime() + 60_001)
    expect(await b.acquireDrainLease(CHAMP, "host:2", later, 60_000)).toMatchObject({ ok: true })
    await close()
  })

  it("won't let a lapsed holder renew its way back in", async () => {
    const { a, b, close } = await twoProcesses()
    await a.acquireDrainLease(CHAMP, "host:1", MON, 60_000)
    const later = new Date(MON.getTime() + 60_001)
    await b.acquireDrainLease(CHAMP, "host:2", later, 60_000)
    // host:1 is still running and still renewing on its timer. It no longer
    // owns the championship, and taking it back mid-upload is the lost update
    // all over again.
    expect(await a.renewDrainLease(CHAMP, "host:1", later, 60_000)).toBe(false)
    await close()
  })

  it("keeps the lease alive across a renewal", async () => {
    const { a, b, close } = await twoProcesses()
    await a.acquireDrainLease(CHAMP, "host:1", MON, 60_000)
    const halfway = new Date(MON.getTime() + 30_000)
    expect(await a.renewDrainLease(CHAMP, "host:1", halfway, 60_000)).toBe(true)
    // Past the original expiry, inside the renewed one.
    const past = new Date(MON.getTime() + 70_000)
    expect(await b.acquireDrainLease(CHAMP, "host:2", past, 60_000)).toMatchObject({ ok: false })
    await close()
  })

  it("releases only its own lease", async () => {
    const { a, b, close } = await twoProcesses()
    await a.acquireDrainLease(CHAMP, "host:1", MON, 60_000)
    // A drain that lost the lease and then finished must not clear the lease of
    // whoever took it over.
    await b.releaseDrainLease(CHAMP, "host:2")
    expect(await b.acquireDrainLease(CHAMP, "host:2", MON, 60_000)).toMatchObject({ ok: false })
    await a.releaseDrainLease(CHAMP, "host:1")
    expect(await b.acquireDrainLease(CHAMP, "host:2", MON, 60_000)).toMatchObject({ ok: true })
    await close()
  })
})
