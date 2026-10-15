import { describe, expect, it } from "vitest"

import { type AcsmReader, StaticAcsmReader } from "../src/acsm/client.js"
import type { Championship, ChampionshipEvent } from "../src/acsm/types.js"
import { StandingsWatch } from "../src/bot/standings-watch.js"
import { championship, raceEvent } from "./support/build.js"

const NIGHT = Date.parse("2026-10-15T04:00:00Z")
const at = (minutes: number) => new Date(NIGHT + minutes * 60_000)

/** Two rounds; whatever is set on them is what the next export carries. */
function harness(rounds: { completed?: string }[] = [{}, {}]) {
  const evs: ChampionshipEvent[] = rounds.map((r) =>
    r.completed ? { ...raceEvent(), CompletedTime: r.completed } : raceEvent(),
  )
  const c: Championship = championship({ Name: "October", Events: evs })
  const reader = new StaticAcsmReader([c]) as unknown as AcsmReader
  const posts: string[] = []
  const watch = new StandingsWatch({
    reader,
    log: () => {},
    post: async (_id, name) => {
      posts.push(name)
    },
  })
  return { watch, evs, posts }
}

describe("StandingsWatch", () => {
  it("posts once when a round's last session ends, not before", async () => {
    const { watch, evs, posts } = harness()
    await watch.tick(at(0))
    // Race 1 over and its results in, race 2 still running.
    evs[0]!.Sessions = { RACE: { CompletedTime: at(5).toISOString(), Results: {} } } as never
    await watch.tick(at(6))
    expect(posts).toEqual([])

    evs[0]!.CompletedTime = at(30).toISOString()
    await watch.tick(at(31))
    await watch.tick(at(33))
    expect(posts).toEqual(["October"])
  })

  it("doesn't post a round that was raced before it started watching", async () => {
    const { watch, posts } = harness([{ completed: at(-60).toISOString() }, {}])
    await watch.tick(at(0))
    await watch.tick(at(2))
    expect(posts).toEqual([])
  })

  it("doesn't post an old round it only now managed to read", async () => {
    // Its first look found nothing raced; the stamp it then finds is days old.
    const { watch, evs, posts } = harness()
    await watch.tick(at(0))
    evs[1]!.CompletedTime = at(-3 * 24 * 60).toISOString()
    await watch.tick(at(2))
    expect(posts).toEqual([])
  })
})
