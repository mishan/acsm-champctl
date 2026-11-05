import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { type NewProposal, SqliteLapProposals } from "../src/laps/store.js"

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "champctl-laps-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const round: NewProposal = {
  championshipId: "c1",
  eventId: "e1",
  night: "2026-11-04",
  cutoff: new Date("2026-11-05T03:00:00.000Z"),
  minutes: 20,
  laps: 22,
  wasLaps: 13,
  bestMs: 54_694,
  detail: { driver: "Driver 1", sessions: 13, validLaps: 270, drivers: 11 },
}
const NOW = new Date("2026-11-04T17:00:00Z")

async function open() {
  return SqliteLapProposals.open(join(dir, "store.db"))
}

describe("lap proposals", () => {
  it("proposes once a round and night, however often it's asked", async () => {
    const s = await open()
    const first = s.create(round, NOW)
    expect(s.create({ ...round, laps: 99 }, NOW)).toEqual(first)
    expect(first).toMatchObject({ laps: 22, status: "pending" })
    expect(first.messageId, "not posted yet, so the next run posts it").toBeUndefined()
    s.close()
  })

  it("approves only the lap count the button showed, and only once", async () => {
    const s = await open()
    const { id } = s.create(round, NOW)
    expect(s.approve(id, 21, "staff", NOW)).toBe(false)
    expect(s.approve(id, 22, "staff", NOW)).toBe(true)
    expect(s.approve(id, 22, "someone else", NOW)).toBe(false)
    expect(s.get(id)).toMatchObject({ status: "approved", approvedBy: "staff" })
    s.close()
  })

  it("stops taking approvals once practice has started, and says it expired", async () => {
    const s = await open()
    const { id } = s.create(round, NOW)
    const started = round.cutoff
    expect(s.approve(id, 22, "staff", started)).toBe(false)
    s.expire(new Date(started.getTime() - 1))
    expect(s.get(id)?.status).toBe("pending")
    s.expire(started)
    expect(s.get(id)?.status).toBe("expired")
    s.close()
  })

  it("compares practice starts as instants, whatever offset they arrived with", async () => {
    const s = await open()
    // 03:00 at +02:00 is 01:00 UTC; as text it would sort after 02:00Z.
    const { id } = s.create({ ...round, cutoff: new Date("2026-11-05T03:00:00+02:00") }, NOW)
    s.approve(id, 22, "staff", NOW)
    expect(s.claim(new Date("2026-11-05T02:00:00Z"))).toBeUndefined()
    s.close()
  })

  it("won't hand out an approval once practice has started", async () => {
    const s = await open()
    const { id } = s.create(round, NOW)
    s.approve(id, 22, "staff", NOW)
    const started = round.cutoff
    expect(s.claim(started)).toBeUndefined()
    s.expire(started)
    expect(s.get(id)?.status).toBe("expired")
    s.close()
  })

  it("recomputes for new minutes only while nobody has approved it", async () => {
    const s = await open()
    const { id } = s.create(round, NOW)
    expect(s.setMinutes(id, 40, 44, NOW)).toBe(true)
    expect(s.approve(id, 22, "staff", NOW)).toBe(false)
    expect(s.approve(id, 44, "staff", NOW)).toBe(true)
    expect(s.setMinutes(id, 20, 22, NOW)).toBe(false)
    expect(s.get(id)).toMatchObject({ minutes: 40, laps: 44 })
    s.close()
  })

  it("hands an approval to one applier, then records how it went", async () => {
    const s = await open()
    const { id } = s.create(round, NOW)
    s.approve(id, 22, "staff", NOW)
    expect(s.claim(NOW)).toMatchObject({ id, status: "applying", laps: 22, wasLaps: 13 })
    expect(s.claim(NOW)).toBeUndefined()
    expect(s.finish(id, "applied", "22 laps", NOW)).toBe(true)
    expect(s.get(id)).toMatchObject({ status: "applied", outcome: "22 laps" })
    expect(s.finish(id, "failed", "late", NOW), "only a claimed row").toBe(false)
    s.close()
  })

  it("lists what the bot hasn't told the channel yet", async () => {
    const s = await open()
    const { id } = s.create(round, NOW)
    expect(s.unannounced(), "nothing to edit before it's posted").toEqual([])
    s.setMessage(id, "chan", "msg")
    expect(s.unannounced().map((p) => p.id)).toEqual([id])
    s.announced(id, "pending")
    expect(s.unannounced()).toEqual([])
    s.approve(id, 22, "staff", NOW)
    expect(s.unannounced().map((p) => p.status)).toEqual(["approved"])
    s.close()
  })
})
