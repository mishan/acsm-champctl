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
    const queue = await open()
    await queue.submit(submission({ body: bytes("v1") }))
    await queue.submit(submission({ body: bytes("v2"), at: TUE }))

    const history = await queue.history(CHAMP)
    const dead = history.find((h) => h.state === "superseded")
    expect(dead?.reason).toMatch(/replaced by a later upload/)
    expect(await queue.queuedBytes()).toBe(2)
    queue.close()
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
