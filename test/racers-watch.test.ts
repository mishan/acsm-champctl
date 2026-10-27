import { describe, expect, it } from "vitest"

import { type AcsmReader, StaticAcsmReader } from "../src/acsm/client.js"
import type { Championship } from "../src/acsm/types.js"
import { type FinishedChampionships, SqliteFinishedStore } from "../src/bot/finished.js"
import { type RacerRole, RacersWatch } from "../src/racers/watch.js"
import { championship, championshipClass, driver, entryList, raceEvent } from "./support/build.js"

const ROLE = "555555555555555555"
const DAY = 86_400_000
const ENDS = Date.parse("2026-10-01T05:00:00Z")
const at = (days: number) => new Date(ENDS + days * DAY)

const ANN = "111111111111111111"
const BEA = "222222222222222222"
const CAL = "333333333333333333"

const roster = (guids: string[]) => [
  championshipClass({ Entrants: entryList(guids.map((g) => driver(`Driver ${g}`, { GUID: g }))) }),
]

/**
 * September, raced until `ENDS` unless `finished`, and October opening for
 * sign-ups once `open` is called. Ann, Bea and Cal hold the role; each has
 * claimed with the Steam id of their own initial.
 */
function harness(
  o: {
    finished?: boolean
    october?: string[]
    failRead?: boolean
    also?: Championship[]
    store?: FinishedChampionships
  } = {},
) {
  const september: Championship = championship({
    ID: "00000000-0000-0000-0000-000000000009",
    Name: "September",
    Created: "2026-08-25T00:00:00Z",
    Classes: roster(["a", "b", "c"]),
    Events: [
      raceEvent({ CompletedTime: "2026-09-24T05:00:00Z" }),
      raceEvent(o.finished ? { CompletedTime: new Date(ENDS).toISOString() } : {}),
    ],
  })
  const october: Championship = championship({
    ID: "00000000-0000-0000-0000-000000000010",
    Name: "October",
    Created: "2026-09-26T00:00:00Z",
    Classes: roster(o.october ?? []),
    SignUpForm: { Enabled: false },
  })
  const inner = new StaticAcsmReader([september, october, ...(o.also ?? [])])
  const read: string[] = []
  const reader = {
    listChampionships: () => inner.listChampionships(),
    exportChampionship: async (id: string) => {
      read.push(id)
      if (o.failRead && id === october.ID) throw new Error("timed out")
      return inner.exportChampionship(id)
    },
  } as unknown as AcsmReader
  const holders = new Set([ANN, BEA, CAL])
  const links = new Map([
    [ANN, new Set(["a"])],
    [BEA, new Set(["b"])],
    [CAL, new Set(["c"])],
  ])
  const marks = new Map<string, Date>()
  const role: RacerRole = {
    holders: async () => [...holders],
    add: async (u) => {
      holders.add(u)
      return true
    },
    remove: async (u) => {
      holders.delete(u)
    },
  }
  const posts: { content: string; ping: { users?: string[]; roles?: string[] } }[] = []
  const told: string[] = []
  const build = () =>
    new RacersWatch({
      reader,
      ...(o.store ? { finished: o.store } : {}),
      links: { guidsByUser: async () => links, fillGuids: async () => {} },
      role,
      roleId: ROLE,
      marks: { get: (k) => marks.get(k), set: (k, v) => void marks.set(k, v) },
      graceDays: 7,
      baseUrl: "https://acsm.example",
      post: async (content, ping) => {
        posts.push({ content, ping })
      },
      notify: async (content) => {
        told.push(content)
      },
      log: () => {},
    })
  const h = {
    watch: build(),
    read,
    /** A new watch over the same server, store and role, as after a deploy. */
    restart: () => {
      h.watch = build()
    },
    role,
    holders,
    links,
    posts,
    told,
    finish: () => {
      september.Events = [
        raceEvent({ CompletedTime: "2026-09-24T05:00:00Z" }),
        raceEvent({ CompletedTime: new Date(ENDS).toISOString() }),
      ]
    },
    open: () => {
      october.SignUpForm = { Enabled: true }
    },
    signUp: (guid: string) => {
      october.Classes = roster([...(o.october ?? []), guid])
    },
    start: () => {
      october.Events = [raceEvent({ StartedTime: "2026-10-08T03:00:00Z" })]
    },
    cancelLast: () => {
      september.Events = [raceEvent({ CompletedTime: "2026-09-24T05:00:00Z" }), raceEvent()]
    },
    reschedule: () => {
      september.Events = [
        raceEvent({ CompletedTime: "2026-09-24T05:00:00Z" }),
        raceEvent({ Scheduled: "2026-11-20T03:00:00Z" }),
      ]
    },
  }
  return h
}

const gt3 = () =>
  championship({
    ID: "00000000-0000-0000-0000-000000000003",
    Name: "GT3",
    Created: "2026-08-01T00:00:00Z",
    Classes: roster(["d"]),
    Events: [
      raceEvent({ StartedTime: "2026-09-30T03:00:00Z", CompletedTime: "2026-09-30T05:00:00Z" }),
      raceEvent({ Scheduled: "2026-10-30T05:00:00Z" }),
    ],
  })

describe("RacersWatch", () => {
  it("gives the role to someone claimed who signs up, and tells the admins", async () => {
    const h = harness()
    const DEE = "444444444444444444"
    h.links.set(DEE, new Set(["d"]))
    h.open()
    await h.watch.tick(at(-3))
    expect(h.holders.has(DEE)).toBe(false)
    h.signUp("d")
    await h.watch.tick(at(-2))
    expect(h.holders.has(DEE)).toBe(true)
    expect(h.told).toEqual([`Gave <@&${ROLE}> to <@${DEE}> who signed up.`])
  })

  it("gives nothing for a draft that hasn't opened or started", async () => {
    const h = harness()
    const DEE = "444444444444444444"
    h.links.set(DEE, new Set(["d"]))
    h.signUp("d")
    await h.watch.tick(at(-2))
    expect(h.holders.has(DEE)).toBe(false)
  })

  it("pings the role once when sign-ups open, then names who hasn't signed up every few days", async () => {
    const h = harness({ october: ["a"] })
    await h.watch.tick(at(-5))
    expect(h.posts).toEqual([])
    h.open()
    await h.watch.tick(at(-4))
    await h.watch.tick(at(-3))
    expect(h.posts).toEqual([
      {
        content: expect.stringMatching(
          /^<@&555555555555555555> Sign-ups are open for \*\*October\*\*/,
        ),
        ping: { roles: [ROLE] },
      },
    ])
    await h.watch.tick(at(-1))
    expect(h.posts[1]?.content).toMatch(
      /^Still to sign up for \*\*October\*\*: <@222\d+> <@333\d+>/,
    )
    expect(h.posts[1]?.ping).toEqual({ users: [BEA, CAL] })
    h.start()
    await h.watch.tick(at(5))
    expect(h.posts).toHaveLength(2)
  })

  it("warns the admins a day ahead, then takes the role from who didn't sign up", async () => {
    const h = harness({ october: ["a"] })
    await h.watch.tick(at(-1))
    h.open()
    h.finish()
    await h.watch.tick(at(0))
    h.signUp("b")
    await h.watch.tick(at(5.9))
    expect(h.told).toEqual([])
    await h.watch.tick(at(6))
    expect(h.told).toEqual([expect.stringMatching(/I'll take <@&\d+> from <@333\d+> who aren't/)])
    await h.watch.tick(at(6.9))
    expect(h.holders).toEqual(new Set([ANN, BEA, CAL]))
    await h.watch.tick(at(7))
    expect(h.holders).toEqual(new Set([ANN, BEA]))
    expect(h.told[1]).toMatch(/^Took <@&\d+> from <@333\d+> who didn't sign up for \*\*October\*\*/)
    h.holders.add(CAL)
    await h.watch.tick(at(8))
    expect(h.holders.has(CAL)).toBe(true)
  })

  it("takes the role after a restart without reading the finished season again", async () => {
    const h = harness({
      october: ["a", "b"],
      store: (await SqliteFinishedStore.open(":memory:")).for("racers"),
    })
    await h.watch.tick(at(-1))
    h.open()
    h.finish()
    await h.watch.tick(at(0))
    await h.watch.tick(at(6))
    h.restart()
    h.read.length = 0
    await h.watch.tick(at(7))
    expect(h.holders).toEqual(new Set([ANN, BEA]))
    expect(h.read).not.toContain("00000000-0000-0000-0000-000000000009")
  })

  it("counts the grace from when the next season opens, if that's after the last one ends", async () => {
    const h = harness()
    await h.watch.tick(at(-1))
    h.finish()
    await h.watch.tick(at(9))
    h.open()
    await h.watch.tick(at(10))
    await h.watch.tick(at(16))
    await h.watch.tick(at(16.9))
    expect(h.holders.size).toBe(3)
    await h.watch.tick(at(17))
    expect(h.holders.size).toBe(0)
  })

  it("leaves a season that had already finished when it first ran", async () => {
    const h = harness({ finished: true })
    h.open()
    await h.watch.tick(at(30))
    await h.watch.tick(at(40))
    expect(h.holders.size).toBe(3)
  })

  it("takes nothing away when a season can't be read", async () => {
    const h = harness({ failRead: true })
    await h.watch.tick(at(-1)).catch(() => {})
    h.finish()
    await expect(h.watch.tick(at(30))).rejects.toThrow(/timed out/)
    expect(h.holders.size).toBe(3)
  })

  it("pings only the people each reminder names", async () => {
    const h = harness()
    for (let i = 0; i < 150; i++) h.holders.add(String(10n ** 17n + BigInt(i)))
    await h.watch.tick(at(-5))
    h.open()
    await h.watch.tick(at(-4))
    await h.watch.tick(at(-1))
    const reminders = h.posts.slice(1)
    expect(reminders.length).toBeGreaterThan(1)
    for (const { content, ping } of reminders) {
      expect(ping.users?.length).toBeLessThanOrEqual(100)
      expect(ping.users).toEqual([...content.matchAll(/<@(\d+)>/g)].map((m) => m[1]))
    }
    expect(reminders.flatMap((r) => r.ping.users)).toHaveLength(153)
  })

  it("counts the grace from when the next season started, if it never took sign-ups", async () => {
    const h = harness({ october: ["a"] })
    await h.watch.tick(at(-1))
    h.finish()
    await h.watch.tick(at(0))
    // October's first round starts at 2026-10-08T03:00Z, a week after September ends.
    h.start()
    await h.watch.tick(at(7))
    await h.watch.tick(at(13))
    await h.watch.tick(at(13.8))
    expect(h.holders.size).toBe(3)
    await h.watch.tick(at(14))
    expect(h.holders).toEqual(new Set([ANN]))
  })

  it("ends a season with a round that will never be raced, six weeks after its last", async () => {
    const h = harness({ october: ["a"] })
    await h.watch.tick(at(-8))
    h.cancelLast()
    h.open()
    // Last raced 2026-09-24, so over on 11-05, and the grace runs to 11-12.
    await h.watch.tick(at(-7))
    await h.watch.tick(at(41))
    await h.watch.tick(at(41.9))
    expect(h.holders.size).toBe(3)
    await h.watch.tick(at(42))
    expect(h.holders).toEqual(new Set([ANN]))
  })

  it("brings back a season gone quiet once its round is rescheduled", async () => {
    const h = harness({ october: ["a"] })
    await h.watch.tick(at(-8))
    h.cancelLast()
    h.open()
    await h.watch.tick(at(-7))
    await h.watch.tick(at(36))
    h.reschedule()
    await h.watch.tick(at(42))
    expect(h.holders.size).toBe(3)
  })

  it("keeps the role for a series still racing that began before the last one ended", async () => {
    const DEE = "444444444444444444"
    const h = harness({ october: ["a"], also: [gt3()] })
    h.links.set(DEE, new Set(["d"]))
    h.holders.add(DEE)
    await h.watch.tick(at(-1))
    h.open()
    h.finish()
    await h.watch.tick(at(0))
    await h.watch.tick(at(6))
    await h.watch.tick(at(7))
    expect(h.holders).toEqual(new Set([ANN, DEE]))
  })

  it("waits for the next season, not a series running alongside the last", async () => {
    const h = harness({ also: [gt3()] })
    await h.watch.tick(at(-1))
    h.finish()
    await h.watch.tick(at(20))
    expect(h.holders.size).toBe(3)
  })

  it("gives a day's notice even when the bot was down for the day before", async () => {
    const h = harness({ october: ["a"] })
    await h.watch.tick(at(-1))
    h.open()
    h.finish()
    await h.watch.tick(at(0))
    await h.watch.tick(at(10))
    expect(h.told).toHaveLength(1)
    expect(h.holders.size).toBe(3)
    await h.watch.tick(at(10.9))
    expect(h.holders.size).toBe(3)
    await h.watch.tick(at(11))
    expect(h.holders).toEqual(new Set([ANN]))
  })

  it("asks once about someone who signed up and has left the server", async () => {
    const h = harness({ october: ["a"] })
    const GONE = "444444444444444444"
    h.links.set(GONE, new Set(["a"]))
    let asked = 0
    const add = h.role.add
    h.role.add = async (u) => {
      if (u !== GONE) return add(u)
      asked++
      return false
    }
    h.open()
    await h.watch.tick(at(-3))
    await h.watch.tick(at(-2))
    expect(asked).toBe(1)
  })
})
