import { describe, expect, it } from "vitest"

import { type AcsmReader, StaticAcsmReader } from "../src/acsm/client.js"
import type { Championship, ChampionshipEvent } from "../src/acsm/types.js"
import type { FinishedChampionships } from "../src/bot/finished.js"
import { SqliteFinishedStore } from "../src/bot/finished.js"
import { StandingsWatch } from "../src/bot/standings-watch.js"
import { championship, raceEvent } from "./support/build.js"

const NIGHT = Date.parse("2026-10-15T04:00:00Z")
const at = (minutes: number) => new Date(NIGHT + minutes * 60_000)

/** Two rounds; whatever is set on them is what the next export carries. */
function harness(
  rounds: { completed?: string }[] = [{}, {}],
  fail: { reads?: number; posts?: number; partly?: boolean } = {},
  finished?: FinishedChampionships,
) {
  const evs: ChampionshipEvent[] = rounds.map((r) =>
    r.completed ? { ...raceEvent(), CompletedTime: r.completed } : raceEvent(),
  )
  const c: Championship = championship({ Name: "October", Events: evs })
  const inner = new StaticAcsmReader([c])
  let failReads = fail.reads ?? 0
  let failPosts = fail.posts ?? 0
  const reads = { n: 0 }
  const reader = {
    listChampionships: () => inner.listChampionships(),
    exportChampionship: async (id: string) => {
      reads.n++
      if (failReads-- > 0) throw new Error("timed out")
      return inner.exportChampionship(id)
    },
  } as unknown as AcsmReader
  const posts: string[] = []
  const told: string[] = []
  const watch = new StandingsWatch({
    reader,
    ...(finished ? { finished } : {}),
    log: () => {},
    post: async (_id, name, sent) => {
      if (failPosts-- > 0) {
        // A class's message out, and the next refused.
        if (fail.partly) {
          posts.push(name)
          sent()
        }
        throw new Error("Discord said no")
      }
      posts.push(name)
      return false
    },
    notify: async (content) => {
      told.push(content)
    },
  })
  return { watch, evs, posts, told, reads }
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

  it("posts the last round of a championship, when the round before was a week ago", async () => {
    const { watch, evs, posts } = harness([{ completed: at(-7 * 24 * 60).toISOString() }, {}])
    await watch.tick(at(0))
    evs[1]!.Sessions = { RACE: { CompletedTime: at(5).toISOString(), Results: {} } } as never
    await watch.tick(at(16))
    evs[1]!.CompletedTime = at(30).toISOString()
    await watch.tick(at(31))
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

  it("doesn't post a round raced before it could first read the championship", async () => {
    // A restart just after race night, with ACSM too slow to answer at first.
    const { watch, posts } = harness([{ completed: at(-60).toISOString() }, {}], { reads: 1 })
    await watch.tick(at(0))
    await watch.tick(at(16))
    await watch.tick(at(18))
    expect(posts).toEqual([])
  })

  it("tries a failed post again, and tells the admins it failed", async () => {
    const { watch, evs, posts, told } = harness([{}, {}], { posts: 1 })
    await watch.tick(at(0))
    evs[0]!.CompletedTime = at(30).toISOString()
    await watch.tick(at(31))
    await watch.tick(at(33))
    expect(posts).toEqual(["October"])
    expect(told).toEqual([expect.stringMatching(/couldn't post the standings: Discord said no/)])
  })

  it("tells the admins once about a post that keeps failing", async () => {
    const { watch, evs, posts, told } = harness([{}, {}], { posts: 3 })
    await watch.tick(at(0))
    evs[0]!.CompletedTime = at(30).toISOString()
    for (const m of [31, 33, 35, 37]) await watch.tick(at(m))
    expect(posts).toEqual(["October"])
    expect(told).toHaveLength(1)
  })

  it("doesn't post again when part of the standings went out", async () => {
    const { watch, evs, posts, told } = harness([{}, {}], { posts: 1, partly: true })
    await watch.tick(at(0))
    evs[0]!.CompletedTime = at(30).toISOString()
    await watch.tick(at(31))
    await watch.tick(at(33))
    expect(posts).toEqual(["October"])
    expect(told).toEqual([expect.stringMatching(/only part of the standings went out/)])
  })

  it("posts once for a night raced as two events", async () => {
    const { watch, evs, posts } = harness([{}, {}])
    await watch.tick(at(0))
    evs[0]!.CompletedTime = at(30).toISOString()
    evs[1]!.CompletedTime = at(31).toISOString()
    await watch.tick(at(32))
    await watch.tick(at(34))
    expect(posts).toEqual(["October"])
  })

  it("watches a championship created before its rounds are", async () => {
    const { watch, evs, posts } = harness([])
    await watch.tick(at(0))
    evs.push({ ...raceEvent(), CompletedTime: at(30).toISOString() })
    await watch.tick(at(31))
    expect(posts).toEqual(["October"])
  })

  it("stops reading a championship whose rounds are all raced, stamped or not", async () => {
    // A round with results ACSM never stamped complete: the quali watch's rule
    // counts it raced, and so must this, or it's read every tick for good.
    const { watch, evs, reads } = harness([{}])
    evs[0]!.Sessions = { RACE: { CompletedTime: at(-600).toISOString(), Results: {} } } as never
    await watch.tick(at(0))
    const afterRefresh = reads.n
    await watch.tick(at(2))
    await watch.tick(at(4))
    expect(reads.n).toBe(afterRefresh)
  })

  it("doesn't read a finished championship again after a restart", async () => {
    const finished = (await SqliteFinishedStore.open(":memory:")).for("standings")
    const raced = [{ completed: at(-600).toISOString() }]
    await harness(raced, {}, finished).watch.tick(at(0))
    const restarted = harness(raced, {}, finished)
    await restarted.watch.tick(at(2))
    expect(restarted.reads.n).toBe(0)
  })
})
