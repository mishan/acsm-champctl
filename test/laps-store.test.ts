import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { LAP_MIGRATIONS, type NewProposal, SqliteLapProposals } from "../src/laps/store.js"
import { migrate } from "../src/sqlite.js"

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
  cutoff: new Date("2026-11-05T02:50:00.000Z"),
  status: "approved",
  minutes: 20,
  laps: 22,
  wasLaps: 13,
  bestMs: 54_694,
  detail: { driver: "Driver 1", sessions: 13, validLaps: 270, drivers: 11 },
}
const NOW = new Date("2026-11-04T17:00:00Z")
const LEASE = 10 * 60_000
const later = (ms: number) => new Date(NOW.getTime() + ms)

async function open() {
  return SqliteLapProposals.open(join(dir, "store.db"))
}

describe("lap proposals", () => {
  it("decides once a round and night, and says which call decided", async () => {
    const s = await open()
    const first = s.create(round, NOW)
    expect(first.inserted).toBe(true)
    const again = s.create({ ...round, laps: 99 }, NOW)
    expect(again).toEqual({ proposal: first.proposal, inserted: false })
    expect(first.proposal).toMatchObject({ laps: 22, status: "approved" })
    s.close()
  })

  it("stores a round left alone, with no count", async () => {
    const s = await open()
    const { proposal } = s.create(
      {
        championshipId: "c1",
        eventId: "e1",
        night: "2026-11-04",
        cutoff: round.cutoff,
        status: "kept",
        outcome: "set to 10 by hand; left as set",
      },
      NOW,
    )
    expect(proposal).toMatchObject({ status: "kept", outcome: "set to 10 by hand; left as set" })
    expect(proposal.laps).toBeUndefined()
    expect(proposal.detail).toBeUndefined()
    s.close()
  })

  it("hands a row to one writer at a time, until its lease runs out", async () => {
    const s = await open()
    const { proposal } = s.create(round, NOW)
    expect(s.claim("a", NOW, LEASE)).toMatchObject({ id: proposal.id, holder: "a" })
    expect(s.claim("b", later(LEASE - 1), LEASE)).toBeUndefined()
    expect(s.claim("b", later(LEASE), LEASE)).toMatchObject({ id: proposal.id, holder: "b" })
    expect(s.finish(proposal.id, "a", "applied", "22 laps", later(LEASE)), "a lost it").toBe(false)
    expect(s.release(proposal.id, "a", later(LEASE))).toBe(false)
    expect(s.finish(proposal.id, "b", "applied", "22 laps", later(LEASE))).toBe(true)
    expect(s.get(proposal.id)).toMatchObject({ status: "applied", outcome: "22 laps" })
    expect(s.finish(proposal.id, "b", "failed", "late", later(LEASE)), "only a claimed row").toBe(
      false,
    )
    s.close()
  })

  it("gives a released row back to be claimed again", async () => {
    const s = await open()
    const { proposal } = s.create(round, NOW)
    s.claim("a", NOW, LEASE)
    expect(s.release(proposal.id, "a", NOW)).toBe(true)
    expect(s.get(proposal.id)).toMatchObject({ status: "approved" })
    expect(s.get(proposal.id)?.holder).toBeUndefined()
    expect(s.claim("a", NOW, LEASE)?.id).toBe(proposal.id)
    s.close()
  })

  it("hands nothing out once practice has started, and expires it unless it's being written", async () => {
    const s = await open()
    const held = s.create(round, NOW).proposal
    const waiting = s.create({ ...round, eventId: "e2" }, NOW).proposal
    const cutoff = round.cutoff.getTime()
    expect(s.claim("a", new Date(cutoff - 60_000), LEASE)?.id).toBe(held.id)
    expect(s.claim("b", new Date(cutoff), LEASE)).toBeUndefined()
    s.expire(new Date(cutoff - 1))
    expect(s.get(waiting.id)?.status).toBe("approved")
    s.expire(new Date(cutoff))
    expect(s.get(waiting.id)?.status).toBe("expired")
    expect(s.get(held.id)?.status, "still within its lease").toBe("applying")
    s.expire(new Date(cutoff - 60_000 + LEASE))
    expect(s.get(held.id)?.status).toBe("expired")
    s.close()
  })

  it("compares instants, whatever offset they arrived with", async () => {
    const s = await open()
    // 03:00 at +02:00 is 01:00 UTC; as text it would sort after 02:00Z.
    s.create({ ...round, cutoff: new Date("2026-11-05T03:00:00+02:00") }, NOW)
    expect(s.claim("a", new Date("2026-11-05T02:00:00Z"), LEASE)).toBeUndefined()
    s.close()
  })

  it("lists what the bot hasn't told anyone, once each row is settled", async () => {
    const s = await open()
    const { proposal } = s.create(round, NOW)
    s.create({ ...round, eventId: "e2", status: "none", outcome: "no clean laps" }, NOW)
    expect(
      s.unannounced().map((p) => p.eventId),
      "still to be written",
    ).toEqual(["e2"])
    s.claim("a", NOW, LEASE)
    s.finish(proposal.id, "a", "applied", "22 laps", NOW)
    s.setMessage(proposal.id, "racers", "m1")
    expect(s.get(proposal.id)).toMatchObject({ channelId: "racers", messageId: "m1" })
    expect(s.unannounced().map((p) => p.eventId)).toEqual(["e1", "e2"])
    s.announced(proposal.id, "applied")
    expect(s.unannounced().map((p) => p.eventId)).toEqual(["e2"])
    s.close()
  })

  it("remembers the laps champctl last set on a round, whichever night it was for", async () => {
    const s = await open()
    expect(s.lastApplied("c1", "e1")).toBeUndefined()
    const earlier = s.create({ ...round, night: "2026-11-04", laps: 22 }, NOW).proposal
    const moved = s.create({ ...round, night: "2026-11-11", laps: 18 }, NOW).proposal
    expect(s.claim("a", NOW, LEASE)?.id).toBe(earlier.id)
    expect(s.claim("a", NOW, LEASE)?.id).toBe(moved.id)
    s.finish(moved.id, "a", "applied", "", later(1))
    s.finish(earlier.id, "a", "applied", "", later(2))
    s.create({ ...round, night: "2026-11-18", laps: 30 }, later(3))
    expect(s.lastApplied("c1", "e1")).toBe(22)
    s.close()
  })
})

describe("lap baselines", () => {
  it("keeps the laps a round had when first seen, whatever it has since", async () => {
    const s = await open()
    expect(s.baseline("c1", "e1")).toBeUndefined()
    expect(s.recordBaseline("c1", "e1", 13, NOW)).toBe(true)
    expect(s.recordBaseline("c1", "e1", 10, later(1))).toBe(false)
    expect(s.baseline("c1", "e1")).toEqual({ laps: 13, seenAt: NOW })
    s.close()
  })
})

describe("race minutes", () => {
  it("takes a championship's own minutes until they're cleared", async () => {
    const s = await open()
    expect(s.raceMinutes("c1")).toBeUndefined()
    s.setRaceMinutes("c1", 40, "staff", NOW)
    s.setRaceMinutes("c1", 30, "staff", NOW)
    expect(s.raceMinutes("c1")).toBe(30)
    expect(s.raceMinutes("c2")).toBeUndefined()
    s.setRaceMinutes("c1", undefined, "staff", NOW)
    expect(s.raceMinutes("c1")).toBeUndefined()
    s.close()
  })
})

describe("lap store migrations", () => {
  it("carries a first-version store's rows over as they were", async () => {
    const path = join(dir, "store.db")
    const db = new DatabaseSync(path)
    migrate(db, "laps", LAP_MIGRATIONS.slice(0, 1))
    db.prepare(
      `INSERT INTO lap_proposal (id, championship_id, event_id, night, cutoff, minutes, laps,
         was_laps, best_ms, detail, status, outcome, channel_id, message_id, announced,
         created_at, updated_at)
       VALUES (7, 'c1', 'e1', '2026-11-04', '2026-11-05T03:00:00.000Z', 20, 22, 13, 54694,
         '{"driver":"Driver 1","sessions":1,"validLaps":2,"drivers":1}', 'applied', 'set',
         'racers', 'm1', 'applied', 'x', 'x')`,
    ).run()
    for (const [id, status] of [
      [8, "pending"],
      [9, "applying"],
    ] as const) {
      db.prepare(
        `INSERT INTO lap_proposal (id, championship_id, event_id, night, cutoff, minutes, laps,
           was_laps, best_ms, detail, status, created_at, updated_at)
         VALUES (?, 'c1', ?, '2026-11-04', '2026-11-05T03:00:00.000Z', 20, 22, 13, 1, '{}', ?,
           'x', 'x')`,
      ).run(id, `e${id}`, status)
    }
    db.close()
    const s = await SqliteLapProposals.open(path)
    expect(s.get(7)).toMatchObject({
      laps: 22,
      status: "applied",
      outcome: "set",
      channelId: "racers",
      messageId: "m1",
    })
    expect(s.get(8)?.status, "a button flow that no longer exists").toBe("expired")
    expect(s.get(9)?.status, "a write with no lease to run out").toBe("approved")
    expect(
      s.unannounced().map((p) => p.id),
      "already posted",
    ).toEqual([8])
    s.close()
  })

  it("skips a step another process ran between reading the version and locking", async () => {
    const path = join(dir, "store.db")
    const first = new DatabaseSync(path)
    const second = new DatabaseSync(path)
    migrate(first, "laps", LAP_MIGRATIONS.slice(0, 1))
    // `migrate` reads the version, then the steps' length: running the other
    // process's migration there puts it in that gap.
    let raced = false
    const steps = new Proxy(LAP_MIGRATIONS, {
      get(target, key, receiver) {
        if (key === "length" && !raced) {
          raced = true
          migrate(first, "laps", LAP_MIGRATIONS)
        }
        return Reflect.get(target, key, receiver)
      },
    })
    expect(() => migrate(second, "laps", steps)).not.toThrow()
    first.close()
    second.close()
  })

  it("refuses a newer champctl's schema committed in that same gap", async () => {
    const path = join(dir, "store.db")
    const first = new DatabaseSync(path)
    const second = new DatabaseSync(path)
    migrate(first, "laps", LAP_MIGRATIONS.slice(0, 1))
    const newer = [...LAP_MIGRATIONS, { name: "laps: from a newer champctl", up: () => {} }]
    let raced = false
    const steps = new Proxy(LAP_MIGRATIONS, {
      get(target, key, receiver) {
        if (key === "length" && !raced) {
          raced = true
          migrate(first, "laps", newer)
        }
        return Reflect.get(target, key, receiver)
      },
    })
    expect(() => migrate(second, "laps", steps)).toThrow(/written by a newer version/)
    first.close()
    second.close()
  })

  it("refuses a row to write that has no count", async () => {
    const s = await open()
    const { laps: _, ...uncounted } = round
    expect(() => s.create(uncounted, NOW)).toThrow(/CHECK/)
    s.close()
  })
})
