import { describe, expect, it } from "vitest"

import { StaticAcsmReader } from "../src/acsm/client.js"
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

function harness(mover?: VoiceMover) {
  const event: ChampionshipEvent = raceEvent()
  const c: Championship = championship({ Events: [event] })
  const moves: string[][] = []
  const notices: string[] = []
  const call = new QualiCall({
    // Hands back the same object every time, so a stamp set on `event` is what
    // the next tick reads — the way ACSM's next export would carry it.
    reader: new StaticAcsmReader([c]),
    mover: mover ?? {
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
  return { call, moves, notices, setSession }
}

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
    const { call, notices, setSession } = harness({ move })
    setSession("QUALIFY", stamp(0))
    await call.tick(at(1))
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain("Missing Permissions")
  })
})
