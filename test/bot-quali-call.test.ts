import { afterEach, describe, expect, it, vi } from "vitest"

import { type AcsmReader, StaticAcsmReader } from "../src/acsm/client.js"
import type { Championship, ChampionshipEvent } from "../src/acsm/types.js"
import { QualiCall } from "../src/bot/quali-call.js"
import type { VoiceMover } from "../src/bot/transport.js"
import { championship, raceEvent, testProfile } from "./support/build.js"

const PIT_LANE = "1".repeat(18)
const RACE_CONTROL = "2".repeat(18)

/** The builder's round: practice at 19:00 PDT for an hour, so quali at 03:00Z. */
const QUALI = Date.parse("2026-09-03T03:00:00Z")
const at = (minutesFromQuali: number) => new Date(QUALI + minutesFromQuali * 60_000)
const stamp = (minutesFromQuali: number) => at(minutesFromQuali).toISOString()

const BROKEN = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"

function harness(options: { mover?: VoiceMover; broken?: boolean } = {}) {
  const event: ChampionshipEvent = raceEvent()
  const c: Championship = championship({ Events: [event] })
  // Hands back the same object every time, so a stamp set on `event` is what
  // the next tick reads — the way ACSM's next export would carry it.
  const inner = new StaticAcsmReader(
    options.broken ? [championship({ ID: BROKEN, Events: [raceEvent()] }), c] : [c],
  )
  const reads = { failing: new Set<string>(), gate: undefined as Promise<void> | undefined }
  const reader = {
    listChampionships: () => inner.listChampionships(),
    exportChampionship: async (id: string) => {
      await reads.gate
      if (reads.failing.has(id)) throw new Error(`no championship ${id}`)
      return inner.exportChampionship(id)
    },
  } as unknown as AcsmReader
  const moves: string[][] = []
  const notices: string[] = []
  const call = new QualiCall({
    reader,
    mover: options.mover ?? {
      move: async (from, to) => {
        moves.push([from, to])
        return { moved: ["misha"], failed: [] }
      },
    },
    profile: testProfile(),
    channels: { fromChannelId: PIT_LANE, toChannelId: RACE_CONTROL },
    log: () => {},
    notify: async (content) => {
      notices.push(content)
    },
  })
  const setSession = (key: string, startedTime: string) => {
    event.Sessions = { ...event.Sessions, [key]: { StartedTime: startedTime } }
  }
  return { call, event, id: c.ID as string, reads, moves, notices, setSession }
}

afterEach(() => {
  vi.useRealTimers()
})

describe("QualiCall", () => {
  it("moves Pit Lane to Race Control once, when ACSM stamps qualifying", async () => {
    const { call, moves, setSession } = harness()

    setSession("PRACTICE", stamp(-60))
    await call.tick(at(-5))
    expect(moves).toEqual([])

    setSession("QUALIFY", stamp(4))
    await call.tick(at(5))
    await call.tick(at(6))
    expect(moves).toEqual([[PIT_LANE, RACE_CONTROL]])
  })

  it("leaves people where they are if quali was well under way when it looked", async () => {
    const { call, moves, setSession } = harness()
    setSession("QUALIFY", stamp(4))
    await call.tick(at(30))
    expect(moves).toEqual([])
  })

  it.each([
    ["throws", async () => Promise.reject(new Error("Missing Permissions"))],
    [
      "leaves someone behind",
      async () => ({ moved: [], failed: [{ who: "misha", why: "Missing Permissions" }] }),
    ],
  ])("tells the admins when the move %s", async (_, move) => {
    const { call, notices, setSession } = harness({ mover: { move } })
    setSession("QUALIFY", stamp(0))
    await call.tick(at(1))
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain("Missing Permissions")
  })

  it("still moves for one championship when another on the same night can't be read", async () => {
    const { call, reads, moves, setSession } = harness({ broken: true })
    await call.tick(at(-5))
    reads.failing.add(BROKEN)
    setSession("QUALIFY", stamp(0))
    await call.tick(at(1))
    expect(moves).toHaveLength(1)
  })

  it("keeps watching a round whose championship couldn't be read at a refresh", async () => {
    const { call, id, reads, moves, setSession } = harness()
    await call.tick(at(-30))
    reads.failing.add(id)
    await call.tick(at(-10))
    reads.failing.delete(id)
    setSession("QUALIFY", stamp(0))
    await call.tick(at(1))
    expect(moves).toHaveLength(1)
  })

  it("sees a round brought forward before its new quali", async () => {
    const { call, event, moves, setSession } = harness()
    const scheduled = event.Scheduled as string
    event.Scheduled = "2026-09-02T22:00:00-07:00"
    await call.tick(at(-50))
    event.Scheduled = scheduled
    await call.tick(at(-30))
    setSession("QUALIFY", stamp(0))
    await call.tick(at(1))
    expect(moves).toHaveLength(1)
  })

  it.each([
    ["walking the calendar", undefined],
    ["reading the round", -14],
  ])("moves nobody once stopped while %s, and waits for that tick", async (_, warmUp) => {
    vi.useFakeTimers({ toFake: ["Date"], now: at(0) })
    const { call, reads, moves, setSession } = harness()
    if (warmUp !== undefined) await call.tick(at(warmUp))
    setSession("QUALIFY", stamp(0))
    let release = () => {}
    reads.gate = new Promise((r) => {
      release = r
    })

    const stop = call.start()
    let stopped = false
    const stopping = stop().then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)

    release()
    await stopping
    expect(moves).toEqual([])
  })
})
