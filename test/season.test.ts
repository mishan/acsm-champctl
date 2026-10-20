import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { SlashCommand } from "../src/bot/transport.js"
import { SeasonRouter } from "../src/season/router.js"
import { SqliteSeasonStore } from "../src/season/store.js"

const ADMIN = "1".repeat(18)
const RACERS = "2".repeat(18)
const DAY = 86_400_000
const START = new Date("2026-11-01T18:00:00Z")

let store: SqliteSeasonStore
let now: Date
let posts: { content: string; pings: readonly string[] }[]
let polls: { content: string; answers: readonly string[]; hours: number; oneVote: boolean }[]
let results: { finalized: boolean; counts: number[] }
let ended: string[]
let failPosts: boolean
let content: () => Promise<{ cars: typeof CARS; tracks: typeof TRACKS }>
let pollPosted: Promise<void>

beforeEach(async () => {
  store = await SqliteSeasonStore.open(":memory:")
  now = START
  posts = []
  polls = []
  results = { finalized: true, counts: [] }
  ended = []
  failPosts = false
  content = async () => ({ cars: CARS, tracks: TRACKS })
  pollPosted = Promise.resolve()
})
afterEach(() => store.close())

const CARS = [
  { id: "ks_porsche_911_gt3_r", name: "Porsche 911 GT3 R" },
  { id: "ks_ferrari_488_gt3", name: "Ferrari 488 GT3" },
  { id: "ks_audi_r8_lms", name: "Audi R8 LMS" },
  { id: "ks_mclaren_650s_gt3", name: "McLaren 650S GT3" },
]
const TRACKS = [
  { id: "ks_brands_hatch", name: "Brands Hatch" },
  { id: "ks_imola", name: "Imola" },
]

function router() {
  return new SeasonRouter({
    store,
    adminRoleId: ADMIN,
    voterRoleId: RACERS,
    content: () => content(),
    now: () => now,
    channel: {
      post: async (content, pings = []) => {
        if (failPosts) throw new Error("Missing Access")
        posts.push({ content, pings })
      },
      postPoll: async (content, _question, answers, hours, oneVote) => {
        await pollPosted
        polls.push({ content, answers, hours, oneVote })
        return `poll-${polls.length}`
      },
      pollResults: async () => results,
      endPoll: async (id) => {
        ended.push(id)
      },
    },
  })
}

const command = (
  userId: string,
  subcommand: string,
  options: Record<string, string> = {},
  roleIds: readonly string[] = [RACERS],
): SlashCommand => ({
  name: "season",
  subcommand,
  options,
  userId,
  username: userId,
  guildId: "g",
  channelId: "c",
  roleIds,
})

const start = (r: SeasonRouter, cars = "2", tracks = "1") =>
  r.handle(command("admin", "start", { cars, tracks, nominate_days: "7", vote_days: "5" }, [ADMIN]))

describe("/season", () => {
  it.each([
    [
      "start",
      { cars: "2", tracks: "1", nominate_days: "7", vote_days: "5" },
      [RACERS],
      /^Only <@&1+> can start/,
    ],
    ["close", {}, [RACERS], /^Only <@&1+> can end a phase/],
    ["nominate", { item: "ks_imola" }, [ADMIN], /^Only <@&2+> nominate/],
  ])("refuses %s to someone without the role", async (sub, options, roles, reply) => {
    expect((await router().handle(command("u", sub, options, roles))).content).toMatch(reply)
  })

  it("starts once, and calls the Racers to nominate cars", async () => {
    const r = router()
    expect((await start(r)).content).toMatch(/^Started\. Car nominations close <t:\d+:f>/)
    expect(posts).toEqual([
      {
        content: expect.stringMatching(
          /^\*\*Next season: nominate the cars\.\*\* <@&2+>, nominate up to 2 cars/,
        ),
        pings: [RACERS],
      },
    ])
    expect((await start(r)).content).toMatch(/already running/)
  })

  it("nominates an installed car from the list or by its name, and a mod only with a link", async () => {
    const r = router()
    await start(r)
    const nominate = (user: string, item: string, link?: string) =>
      r.handle(command(user, "nominate", { item, ...(link ? { link } : {}) }))
    expect((await nominate("ana", "ks_imola")).content).toMatch(/isn't installed on the server/)
    expect((await nominate("ana", "ks_ferrari_488_gt3")).content).toBe(
      "Nominated **Ferrari 488 GT3**. You can nominate 1 more.",
    )
    expect((await nominate("bo", "ferrari 488 gt3")).content).toBe(
      "**Ferrari 488 GT3** is nominated already, by <@ana>.",
    )
    expect((await nominate("bo", "Lotus 72D")).content).toMatch(/add a `link` to the mod/)
    expect((await nominate("bo", "Lotus 72D", "lotus.zip")).content).toMatch(/web address/)
    expect((await nominate("bo", "Lotus 72D", "https://mods.example/lotus")).content).toBe(
      "Nominated **Lotus 72D**. You can nominate 1 more.",
    )
    expect((await nominate("ana", "Audi R8 LMS")).content).toBe(
      "Nominated **Audi R8 LMS**. That's your 2.",
    )
    expect((await nominate("ana", "McLaren 650S GT3")).content).toMatch(
      /^You've nominated 2 cars already/,
    )
    expect(posts.slice(1).map((p) => p.content)).toEqual([
      "<@ana> nominated **Ferrari 488 GT3**",
      "<@bo> nominated **Lotus 72D**: <https://mods.example/lotus>",
      "<@ana> nominated **Audi R8 LMS**",
    ])
    // Withdrawn, a place is free again; only your own can be.
    expect((await r.handle(command("bo", "withdraw", { item: "ks_audi_r8_lms" }))).content).toMatch(
      /isn't one of your nominations/,
    )
    expect((await r.handle(command("ana", "withdraw", { item: "ks_audi_r8_lms" }))).content).toBe(
      "Withdrawn: **Audi R8 LMS**.",
    )
    expect((await nominate("ana", "McLaren 650S GT3")).content).toMatch(/^Nominated/)
  })

  it("offers installed cars not yet nominated, and your own nominations to withdraw", async () => {
    const r = router()
    await start(r)
    await r.handle(command("ana", "nominate", { item: "ks_ferrari_488_gt3" }))
    const offered = await r.autocomplete(command("bo", "nominate", { item: "gt3" }), "item")
    expect(offered).toEqual([
      { name: "Porsche 911 GT3 R", value: "ks_porsche_911_gt3_r" },
      { name: "McLaren 650S GT3", value: "ks_mclaren_650s_gt3" },
    ])
    expect(await r.autocomplete(command("ana", "withdraw", { item: "" }), "item")).toEqual([
      { name: "Ferrari 488 GT3", value: "ks_ferrari_488_gt3" },
    ])
    expect(await r.autocomplete(command("bo", "withdraw", { item: "" }), "item")).toEqual([])
  })

  it("runs cars to their poll, counts it once Discord has, then opens tracks", async () => {
    const r = router()
    await start(r)
    for (const [user, item] of [
      ["ana", "ks_ferrari_488_gt3"],
      ["bo", "ks_audi_r8_lms"],
      ["cy", "ks_porsche_911_gt3_r"],
    ] as const) {
      await r.handle(command(user, "nominate", { item }))
    }
    now = new Date(START.getTime() + 7 * DAY - 1)
    await r.advance()
    expect(polls).toEqual([])

    now = new Date(START.getTime() + 7 * DAY)
    await r.advance()
    expect(polls).toEqual([
      {
        content: expect.stringMatching(
          /^\*\*Vote for next season's cars\.\*\* <@&2+>, vote for every car/,
        ),
        answers: ["Ferrari 488 GT3", "Audi R8 LMS", "Porsche 911 GT3 R"],
        hours: 120,
        oneVote: false,
      },
    ])
    expect(
      (await r.handle(command("dee", "nominate", { item: "ks_mclaren_650s_gt3" }))).content,
    ).toBe("Nominations aren't open right now.")

    now = new Date(START.getTime() + 12 * DAY)
    results = { finalized: false, counts: [2, 0, 2] }
    await r.advance()
    expect(store.current()?.phase).toBe("cars-vote")

    results = { finalized: true, counts: [2, 0, 2] }
    await r.advance()
    expect(posts.at(-2)!.content).toBe(
      [
        "**Next season's cars.** <@&222222222222222222>",
        "Going through: **Ferrari 488 GT3**, **Porsche 911 GT3 R**.",
        "The poll's votes:",
        "1. **Ferrari 488 GT3**: 2",
        "2. **Porsche 911 GT3 R**: 2",
        "3. **Audi R8 LMS**: 0",
      ].join("\n"),
    )
    expect(posts.at(-1)!.content).toMatch(/^\*\*Next season: nominate the tracks\.\*\*/)

    // One track for one place: no vote needed, and the season vote is done.
    await r.handle(command("ana", "nominate", { item: "ks_imola" }))
    now = new Date(START.getTime() + 19 * DAY)
    await r.advance()
    expect(polls).toHaveLength(1)
    expect(posts.at(-1)!.content).toBe(
      [
        "**Next season's tracks.** <@&222222222222222222>",
        "1 nominated for 1 place, so no vote was needed.",
        "Going through: **Imola**.",
      ].join("\n"),
    )
    expect(store.current()).toBeUndefined()
  })

  it("posts a one-vote poll when started that way", async () => {
    const r = router()
    await r.handle(
      command(
        "admin",
        "start",
        { cars: "1", tracks: "1", nominate_days: "7", vote_days: "5", one_vote: "true" },
        [ADMIN],
      ),
    )
    await r.handle(command("ana", "nominate", { item: "ks_ferrari_488_gt3" }))
    await r.handle(command("bo", "nominate", { item: "ks_audi_r8_lms" }))
    await r.handle(command("admin", "close", {}, [ADMIN]))
    expect(polls[0]).toMatchObject({
      content: expect.stringMatching(/vote for the car you'd most like to race/),
      oneVote: true,
    })
  })

  it("leaves a tie at the cut to the admins", async () => {
    const r = router()
    await start(r, "1")
    await r.handle(command("ana", "nominate", { item: "ks_ferrari_488_gt3" }))
    await r.handle(command("bo", "nominate", { item: "ks_audi_r8_lms" }))
    await r.handle(command("ana", "close", {}, [ADMIN]))
    results = { finalized: true, counts: [1, 1] }
    await r.handle(command("ana", "close", {}, [ADMIN]))
    // Ended before it's counted, so the count is the final one.
    expect(ended).toEqual(["poll-1"])
    expect(posts.at(-2)!.content).toMatch(
      /\nTied for the last place: \*\*Ferrari 488 GT3\*\*, \*\*Audi R8 LMS\*\*\. <@&1+> will choose\.\n/,
    )
  })

  it("takes no nominations or withdrawals once their time is up, before it's moved on", async () => {
    const r = router()
    await start(r)
    await r.handle(command("ana", "nominate", { item: "ks_ferrari_488_gt3" }))
    await r.handle(command("bo", "nominate", { item: "ks_audi_r8_lms" }))
    await r.handle(command("cy", "nominate", { item: "ks_porsche_911_gt3_r" }))
    now = new Date(START.getTime() + 7 * DAY)
    for (const [user, sub, item] of [
      ["dee", "nominate", "ks_mclaren_650s_gt3"],
      ["ana", "withdraw", "ks_ferrari_488_gt3"],
    ]) {
      expect((await r.handle(command(user!, sub!, { item: item! }))).content).toBe(
        "Nominations aren't open right now.",
      )
    }
  })

  it("counts a nominator's earlier nominations even when two arrive at once", async () => {
    const r = router()
    await start(r)
    await r.handle(command("ana", "nominate", { item: "ks_ferrari_488_gt3" }))
    const replies = await Promise.all(
      ["ks_audi_r8_lms", "ks_porsche_911_gt3_r"].map((item) =>
        r.handle(command("ana", "nominate", { item })),
      ),
    )
    expect(replies.map((x) => x.content)).toEqual([
      expect.stringMatching(/^Nominated/),
      expect.stringMatching(/^You've nominated 2 cars already/),
    ])
  })

  it("refuses a nomination when it can't read what's installed, rather than call it a mod", async () => {
    const r = router()
    await start(r)
    content = async () => {
      throw new Error("ACSM is down")
    }
    const reply = await r.handle(
      command("ana", "nominate", { item: "ks_ferrari_488_gt3", link: "https://mods.example/f" }),
    )
    expect(reply.content).toMatch(/couldn't read the cars installed/)
    expect(store.nominations(store.current()!.id, "cars")).toEqual([])
  })

  it("starts, and takes nominations, even when the channel post fails", async () => {
    const r = router()
    failPosts = true
    expect((await start(r)).content).toMatch(
      /^Started\. .*didn't post in the season channel \(Missing Access\)/,
    )
    expect((await r.handle(command("ana", "nominate", { item: "ks_imola" }))).content).toMatch(
      /isn't installed/,
    )
    expect(
      (await r.handle(command("ana", "nominate", { item: "ks_ferrari_488_gt3" }))).content,
    ).toMatch(/^Nominated/)
  })

  it("won't let a close land on the phase after the one that's closing", async () => {
    const r = router()
    await start(r, "1")
    await r.handle(command("ana", "nominate", { item: "ks_ferrari_488_gt3" }))
    await r.handle(command("bo", "nominate", { item: "ks_audi_r8_lms" }))
    let post!: () => void
    pollPosted = new Promise((done) => {
      post = done
    })
    const first = r.handle(command("admin", "close", {}, [ADMIN]))
    expect((await r.handle(command("admin", "close", {}, [ADMIN]))).content).toMatch(
      /closing already/,
    )
    let idle = false
    const settled = r.idle().then(() => {
      idle = true
    })
    await Promise.resolve()
    expect(idle).toBe(false)
    post()
    await first
    await settled
    const v = store.current()!
    expect(v.phase).toBe("cars-vote")
    expect(v.phaseEndsAt.getTime()).toBe(START.getTime() + 5 * DAY)
  })

  it("holds as many nominees as a poll does, its answers clipped to Discord's limit", async () => {
    const r = router()
    await start(r, "1")
    const long = (i: number) => `${i} ${"Lotus Type 72D Gold Leaf ".repeat(3)}`.trim()
    for (let i = 0; i < 10; i++) {
      await r.handle(
        command(`u${i}`, "nominate", { item: long(i), link: `https://mods.example/${i}` }),
      )
    }
    expect(
      (await r.handle(command("dee", "nominate", { item: "ks_ferrari_488_gt3" }))).content,
    ).toMatch(/^Nominations are full: a poll holds 10 cars/)
    await r.handle(command("admin", "close", {}, [ADMIN]))
    expect(polls[0]!.answers).toHaveLength(10)
    expect(polls[0]!.answers.every((a) => a.length <= 55)).toBe(true)
  })

  it("moves on rather than post a result again when its post fails", async () => {
    const r = router()
    await start(r)
    now = new Date(START.getTime() + 7 * DAY)
    failPosts = true
    await r.advance()
    failPosts = false
    now = new Date(START.getTime() + 8 * DAY)
    await r.advance()
    expect(posts.filter((p) => /Next season's cars/.test(p.content))).toEqual([])
    expect(store.current()?.phase).toBe("tracks-nominate")
  })
})
