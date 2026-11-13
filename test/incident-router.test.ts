import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { type AcsmReader, StaticAcsmReader } from "../src/acsm/client.js"
import type { Button, SlashCommand } from "../src/bot/transport.js"
import { indexJournal } from "../src/incidents/journals.js"
import {
  type IncidentChannels,
  IncidentRouter,
  type IncidentRouterOptions,
  parseClock,
} from "../src/incidents/router.js"
import { SqliteIncidentStore } from "../src/incidents/store.js"
import { type JournalRecord, JournalWriter } from "../src/spectator/journal.js"
import type { DriverClaim } from "../src/liveries/claims.js"
import type { Evidence } from "../src/spectator/evidence.js"
import { parseFastLane, Track } from "ac-ai-line"
import { championship, championshipClass, entryList } from "./support/build.js"
import { writeScenario } from "./support/incident-scenario.js"
import { fastLane, loop } from "./support/synthetic-track.js"

const CHAMP = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
const STEWARDS = "9".repeat(18)
const ANA = "1".repeat(18)
const BO = "2".repeat(18)
const DEE = "4".repeat(18)
const RACERS = "5".repeat(18)

let dir: string
/** The race option's value: the recorder's timestamp at the front of the journal's name. */
let journal: string
let stamp: string
let store: SqliteIncidentStore
let channels: {
  created: [string, readonly string[], readonly string[]][]
  posts: [string, string, number][]
  /** Each post's buttons, beside it in `posts`. */
  buttons: (readonly Button[])[]
  opened: [string, string, readonly string[], readonly string[]][]
  removed: string[]
  pinged: (readonly string[])[]
  pingedRoles: (readonly string[])[]
  locked: [string, string][]
}
let failGather: boolean
let failCreate: boolean
let failOpen: boolean
let failLock: boolean
/** Server Manager can't be reached. */
let failRead: boolean
/** The report's own first message doesn't go through. */
let failFirstPost: boolean
/** How many times the video's upload fails before it goes through. */
let failVideo: number
let videoError: string
let videoErrorName: string
let videoTries: number
let reads: number
let gatheredInto: string | undefined
/** Most evidence renders running at once. */
let rendersAtOnce: number

const track = new Track(parseFastLane(fastLane(loop("left"))))

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "incidents-"))
  // Named the way the recorder names a journal, an hour ago.
  stamp = new Date(Date.now() - 3600_000).toISOString().replace(/[:.]/g, "-")
  await writeScenario(
    dir,
    `${stamp}-loop-race`,
    track,
    [
      { carId: 1, driver: "Ana", s: (t) => 100 + 30 * (t / 1000), across: () => -2 },
      // Bo races as something else in the game: only the GUID ties them.
      {
        carId: 2,
        driver: "B0 [BATL]",
        guid: "76561198000000002",
        s: (t) => 101 + 30 * (t / 1000),
        across: () => 2,
      },
      { carId: 3, driver: "Cy", s: (t) => 60 + 30 * (t / 1000), across: () => 0 },
    ],
    { at: 5000, carId: 2, otherCarId: 1 },
  )
  journal = stamp
  await writeFile(join(dir, "video.mp4"), "mp4")
  store = await SqliteIncidentStore.open(":memory:")
  channels = {
    created: [],
    posts: [],
    buttons: [],
    opened: [],
    removed: [],
    pinged: [],
    pingedRoles: [],
    locked: [],
  }
  failGather = false
  failCreate = false
  failOpen = false
  failLock = false
  failRead = false
  failFirstPost = false
  failVideo = 0
  videoError = "other side closed"
  videoErrorName = "SocketError"
  videoTries = 0
  polls = []
  ended = []
  pollResult = { finalized: true, counts: [0, 0, 0] }
  reads = 0
  rendersAtOnce = 0
})
afterEach(async () => {
  store.close()
  await rm(dir, { recursive: true, force: true })
})

let rendering = 0

/** Polls posted, and what counting one answers. */
let polls: { channel: string; question: string; answers: readonly string[]; hours: number }[]
let pollResult: { finalized: boolean; counts: number[] }
let ended: [string, string][]

function router(
  claimed: Record<string, string> = { [ANA]: "Ana", [BO]: "Bo", [DEE]: "Dee" },
  extra: Partial<IncidentRouterOptions> = {},
) {
  const c = championship({
    ID: CHAMP,
    Classes: [
      championshipClass({
        Entrants: entryList([
          { Name: "Ana", GUID: "76561198000000001" },
          { Name: "Bo", GUID: "76561198000000002" },
          { Name: "Cy", GUID: "76561198000000003" },
          { Name: "Dee", GUID: "76561198000000004" },
        ]),
      }),
    ],
  })
  const claim = (discordUserId: string, entrantName: string): DriverClaim => ({
    championshipId: CHAMP,
    discordUserId,
    entrantName,
    claimedAt: "",
  })
  const ch: IncidentChannels = {
    create: async (name, users, roles) => {
      if (failCreate) throw new Error("Missing Permissions")
      // As long as Discord takes, so a second tap arrives while the first is waiting.
      await new Promise((r) => setTimeout(r, 20))
      channels.created.push([name, users, roles])
      return `chan-${channels.created.length}`
    },
    open: async (id, name, roles, users) => {
      // As long as Discord takes, so a second press arrives while the first is waiting.
      await new Promise((r) => setTimeout(r, 20))
      if (failOpen) throw new Error("Discord is holding back changes to this channel")
      channels.opened.push([id, name, roles, users])
    },
    remove: async (id) => {
      channels.removed.push(id)
    },
    post: async (id, content, files, pings, pingRoles, buttons) => {
      if (failFirstPost && content.startsWith("**Report")) throw new Error("Unknown Channel")
      if (content === "From above:") videoTries++
      if (failVideo > 0 && content === "From above:" && failVideo--)
        throw Object.assign(new Error(videoError), { name: videoErrorName })
      channels.posts.push([id, content, files?.length ?? 0])
      channels.buttons.push(buttons ?? [])
      channels.pinged.push(pings ?? [])
      channels.pingedRoles.push(pingRoles ?? [])
    },
    lock: async (id, name) => {
      if (failLock) throw new Error("Missing Permissions")
      // As long as Discord takes, so a second steward arrives while the first is waiting.
      await new Promise((r) => setTimeout(r, 20))
      channels.locked.push([id, name])
    },
    poll: async (channel, question, answers, hours) => {
      polls.push({ channel, question, answers, hours })
      return `poll-${polls.length}`
    },
    pollResults: async () => {
      // As long as Discord takes, so a steward can decide while it's counting.
      await new Promise((r) => setTimeout(r, 20))
      return pollResult
    },
    endPoll: async (channel, id) => {
      ended.push([channel, id])
    },
  }
  return new IncidentRouter({
    recordings: dir,
    acRoot: dir,
    replayUrl: "https://champctl.example/replays",
    championshipId: CHAMP,
    reader: {
      exportChampionship: async (id: string) => {
        reads++
        if (failRead) throw new Error("502 Bad Gateway")
        return new StaticAcsmReader([c]).exportChampionship(id)
      },
    } as unknown as AcsmReader,
    claims: {
      forDiscordUser: async (_, user) => (claimed[user] ? claim(user, claimed[user]) : undefined),
      forEntrant: async (_, name) => {
        const user = Object.keys(claimed).find((u) => claimed[u] === name)
        return user ? claim(user, name) : undefined
      },
    },
    store,
    channels: ch,
    stewardRoleId: STEWARDS,
    timeZone: "America/Los_Angeles",
    ...extra,
    gather: async (q): Promise<Evidence> => {
      gatheredInto = q.outDir
      rendering++
      rendersAtOnce = Math.max(rendersAtOnce, rendering)
      await new Promise((r) => setTimeout(r, 20))
      rendering--
      if (failGather) throw new Error("no racing line")
      for (const ext of [".acreplay", ".mp4"])
        await writeFile(join(q.outDir, `${q.stem}${ext}`), "")
      return {
        summary: [`at ${q.atMs}`],
        call: ["Suggested call: unclear", "None of the rules clearly applies."],
        drawing: Buffer.from("png"),
        video: join(dir, "video.mp4"),
        clip: `${q.stem}.acreplay`,
        skips: [],
      }
    },
  })
}

const car = (carId: number, driver: string, guid?: string): JournalRecord => ({
  t: "car",
  at: 0,
  carId,
  model: "m",
  skin: "s",
  driver,
  ...(guid ? { guid } : {}),
})
const hit: JournalRecord = {
  t: "collision",
  at: 5000,
  carId: 2,
  otherCarId: 1,
  impactSpeed: 40,
  worldPos: [0, 0, 0],
}

/** A race with these cars and a contact in it, by hand; its key. */
async function contact(records: JournalRecord[], round = ""): Promise<string> {
  // Two hours ago: a session old enough not to be the beforeEach one, recent enough to report.
  const key = new Date(Date.now() - 7200_000).toISOString().replace(/[:.]/g, "-")
  await mkdir(join(dir, round), { recursive: true })
  const w = new JournalWriter(join(dir, round, `${key}-loop-race.ndjson.gz`))
  w.write({
    t: "session",
    at: 0,
    serverName: "s",
    track: "loop",
    trackConfig: "",
    name: "Race",
    type: 3,
    recorderCarId: 0,
  })
  for (const r of records) w.write(r)
  await w.close()
  return key
}

/** The newest draft's button, pressed by `user`. */
const press = (r: IncidentRouter, action: "open" | "withdraw", user = ANA) => {
  const id = channels.buttons.findLast((b) => b.length)?.[0]?.id.split(":")[2]
  return r.press({
    customId: `incident:${action}:${id}`,
    userId: user,
    channelId: "chan-1",
    roleIds: [],
  })
}

/** A report of the first contact, opened as an incident. */
const filed = async (r: IncidentRouter, options: Record<string, string> = {}, user = ANA) => {
  await r.handle(
    command(user, "report", { race: journal, what: "c:0", description: "x", ...options }),
  )
  return press(r, "open", user)
}

const command = (
  user: string,
  sub: string,
  options: Record<string, string>,
  extra: Partial<SlashCommand> = {},
): SlashCommand => ({
  name: "incident",
  subcommand: sub,
  options,
  userId: user,
  username: user,
  guildId: "g",
  channelId: "somewhere",
  roleIds: [],
  ...extra,
})

describe("/incident autocomplete", () => {
  it("offers recent qualifying and races, not practice, in the league's time named", async () => {
    // Two and three hours before the race in beforeEach.
    for (const [hours, name, type] of [
      [2, "Qualify", 2],
      [3, "Practice", 1],
    ] as const) {
      const key = new Date(Date.now() - 3600_000 * hours).toISOString().replace(/[:.]/g, "-")
      const w = new JournalWriter(join(dir, `${key}-loop-${name.toLowerCase()}.ndjson.gz`))
      w.write({
        t: "session",
        at: 0,
        serverName: "s",
        track: "loop",
        trackConfig: "",
        name,
        type,
        recorderCarId: 0,
      })
      await w.close()
    }
    const choices = await router().autocomplete(command(ANA, "report", { race: "" }), "race")
    expect(choices.map((c) => c.name)).toEqual([
      expect.stringMatching(/^Race · loop · \w{3} \d+, \d+:\d{2} [AP]M P[DS]T$/),
      expect.stringMatching(/^Qualify · loop · /),
    ])
  })

  it("numbers the races on a night with two", async () => {
    // A second race a minute after the one in beforeEach: close enough that the
    // two can't fall either side of midnight.
    const key = new Date(
      Date.parse(stamp.replace(/T(\d+)-(\d+)-(\d+)-(\d+)Z/, "T$1:$2:$3.$4Z")) + 60_000,
    )
      .toISOString()
      .replace(/[:.]/g, "-")
    const w = new JournalWriter(join(dir, `${key}-loop-race.ndjson.gz`))
    w.write({
      t: "session",
      at: 0,
      serverName: "s",
      track: "loop",
      trackConfig: "",
      name: "Race",
      type: 3,
      recorderCarId: 0,
    })
    await w.close()
    const choices = await router().autocomplete(command(ANA, "report", { race: "" }), "race")
    expect(choices.map((c) => c.name.split(" · ")[0])).toEqual(["Race 2", "Race 1"])
    await router().handle(command(ANA, "report", { race: journal, what: "c:0", description: "x" }))
    expect(channels.posts[0]![1]).toMatch(/ Race 1 at loop, /)
  })

  it("offers the reporter's own contacts, and something else", async () => {
    const choices = await router().autocomplete(
      command(ANA, "report", { race: journal, what: "" }),
      "what",
    )
    expect(choices.map((c) => c.value)).toEqual(["c:0", "other"])
    expect(choices[0]!.name).toMatch(/^0:05 · contact with B0 \[BATL\]/)
  })

  it("offers the other drivers nearest first, once the time is typed", async () => {
    // At 5 s Bo is alongside Ana and Cy 40 m behind.
    const choices = await router().autocomplete(
      command(ANA, "report", { race: journal, what: "other", when: "0:05", other_driver: "" }),
      "other_driver",
    )
    expect(choices).toEqual([
      { name: expect.stringMatching(/^B0 \[BATL\] · [1-6] m away at 0:05$/), value: "B0 [BATL]" },
      { name: expect.stringMatching(/^Cy · (3\d|4\d) m away at 0:05$/), value: "Cy" },
    ])
  })

  it.each([
    ["someone else in a contact", "c", false, "no contact of yours was recorded"],
    ["anyone in a session with no contacts", ANA, true, "this session recorded no contacts"],
  ])("offers %s only something else", async (_, user, quiet, why) => {
    const race = quiet
      ? new Date(Date.now() - 7200_000).toISOString().replace(/[:.]/g, "-")
      : journal
    if (quiet) await writeScenario(dir, `${race}-loop-race`, track, [], undefined)
    const choices = await router({ [ANA]: "Ana", [BO]: "Bo", c: "Cy" }).autocomplete(
      command(user, "report", { race, what: "" }),
      "what",
    )
    expect(choices).toEqual([
      { name: `Something else (${why}): give the driver and the time below`, value: "other" },
    ])
  })
})

describe("/incident report", () => {
  it("asks a driver to claim their name first", async () => {
    const reply = await router({}).handle(
      command(ANA, "report", { race: journal, what: "c:0", description: "x" }),
    )
    expect(reply.content).toMatch(/\/racer claim/)
    expect(channels.created).toEqual([])
  })

  it("shows the report and the evidence to the reporter alone, as a draft", async () => {
    const reply = await router().handle(
      command(ANA, "report", { race: journal, what: "c:0", description: "Bo turned in on me" }),
    )
    expect(reply.content).toBe(
      "Here's your draft: <#chan-1>. Nobody else can see it until you open it there.",
    )
    expect(channels.created).toEqual([["draft-1-ana-bo", [ANA], []]])
    // Mentioning only the reporter, who may not have seen the reply.
    expect(channels.posts[0]![1]).toBe(
      `**Report** by <@${ANA}> of <@${BO}>. Race at loop, 0:05 into the session.\n> Bo turned in on me`,
    )
    expect(channels.pinged.flat()).toEqual([ANA])
    // The facts, the call with its drawing, the video; the clip unlinked, then the buttons.
    expect(channels.posts.slice(1).map(([, text, files]) => [text.split("\n")[0], files])).toEqual([
      ["**What the recording shows**", 0],
      ["**Suggested call: unclear**", 1],
      ["From above:", 1],
      [expect.stringMatching(/^Only you can see this so far\./), 0],
    ])
    expect(channels.buttons.at(-1)!.map((b) => b.id)).toEqual([
      "incident:open:1",
      "incident:withdraw:1",
    ])
    expect(await readdir(dir)).toEqual(expect.arrayContaining(["draft-1.acreplay", "draft-1.mp4"]))
    expect([store.list(), polls]).toEqual([[], []])
  })

  it("opens a draft as an incident for the stewards and both drivers", async () => {
    const reply = await filed(router())
    expect(reply).toEqual({
      content: "Opened as incident #1. The stewards will look at it here.",
      clearButtons: true,
    })
    expect(channels.opened).toEqual([["chan-1", "incident-1-ana-bo", [STEWARDS], [ANA, BO]]])
    // The other driver is told they've been reported, and the clip is linked now it's public.
    const after = channels.posts.findIndex(([, t]) => t.startsWith("**Incident"))
    expect(channels.posts.slice(after).map(([, t]) => t)).toEqual([
      `**Incident #1**: <@${ANA}> reports <@${BO}>, as above.`,
      "A replay clip to watch in the game: https://champctl.example/replays/incident-1.acreplay",
    ])
    expect(channels.pinged[after]).toEqual([BO])
    const files = await readdir(dir)
    expect(files).toEqual(expect.arrayContaining(["incident-1.acreplay", "incident-1.mp4"]))
    expect(files.filter((f) => f.startsWith("draft-"))).toEqual([])
    expect(store.byChannel("chan-1")?.number).toBe(1)
  })

  it("lets only the reporter open or withdraw their draft", async () => {
    const r = router()
    await r.handle(command(ANA, "report", { race: journal, what: "c:0", description: "x" }))
    for (const action of ["open", "withdraw"] as const) {
      expect((await press(r, action, BO)).content).toBe(
        "Only the driver who reported it can do that.",
      )
    }
    expect([channels.opened, channels.removed]).toEqual([[], []])
  })

  it("opens one incident when the reporter presses twice, or withdraws as it opens", async () => {
    const r = router()
    await r.handle(command(ANA, "report", { race: journal, what: "c:0", description: "x" }))
    const replies = await Promise.all([press(r, "open"), press(r, "open"), press(r, "withdraw")])
    expect(replies.map((x) => x.content)).toEqual([
      expect.stringMatching(/^Opened as incident #1/),
      "I'm still on it. Give it a minute.",
      "I'm still on it. Give it a minute.",
    ])
    expect((await press(r, "open")).content).toMatch(/^That draft is gone/)
    expect([channels.opened.length, channels.removed, store.list().length]).toEqual([1, [], 1])
  })

  it("opens a draft as the same incident when it couldn't be opened the first time", async () => {
    const r = router()
    await r.handle(command(ANA, "report", { race: journal, what: "c:0", description: "x" }))
    failOpen = true
    expect((await press(r, "open")).content).toMatch(
      /^I couldn't open it: Discord is holding back changes to this channel\. Try again/,
    )
    failOpen = false
    expect((await press(r, "open")).content).toMatch(/^Opened as incident #1\./)
    expect(store.list().map((i) => i.number)).toEqual([1])
  })

  it("withdraws a draft: its channel, its evidence and itself", async () => {
    const r = router()
    await r.handle(command(ANA, "report", { race: journal, what: "c:0", description: "x" }))
    expect((await press(r, "withdraw")).content).toBe("Withdrawn. Nobody else saw it.")
    expect(channels.removed).toEqual(["chan-1"])
    expect((await readdir(dir)).filter((f) => f.startsWith("draft-"))).toEqual([])
    expect(store.openCount(ANA)).toBe(0)
    expect((await press(r, "open")).content).toMatch(/^That draft is gone/)
  })

  it("replaces a draft when the same moment is reported again", async () => {
    const r = router()
    await r.handle(command(ANA, "report", { race: journal, what: "c:0", description: "x" }))
    const again = await r.handle(
      command(ANA, "report", { race: journal, what: "c:0", description: "Better words" }),
    )
    expect(again.content).toMatch(/^Here's your draft: <#chan-2>/)
    expect(channels.removed).toEqual(["chan-1"])
    expect(store.openCount(ANA)).toBe(1)
  })

  it("keeps the first draft when the same moment is reported again before it's made", async () => {
    const r = router()
    const report = () =>
      r.handle(command(ANA, "report", { race: journal, what: "c:0", description: "x" }))
    const first = report()
    // Into the first's channel and render, after its draft is written.
    await new Promise((r) => setTimeout(r, 30))
    const replies = await Promise.all([first, report()])
    expect(replies.map((x) => x.content)).toEqual([
      expect.stringMatching(/^Here's your draft: <#chan-1>/),
      "I'm still filing your last report. Give it a minute.",
    ])
    expect([channels.removed, store.openCount(ANA)]).toEqual([[], 1])
  })

  it("won't withdraw a draft whose opening has begun, whose channel may be public", async () => {
    const r = router()
    await r.handle(command(ANA, "report", { race: journal, what: "c:0", description: "x" }))
    failOpen = true
    await press(r, "open")
    expect((await press(r, "withdraw")).content).toBe(
      "It's being opened already. Press Open incident to finish it.",
    )
    expect(channels.removed).toEqual([])
  })

  it("links the overhead video when opened, if it didn't upload to the draft", async () => {
    failVideo = Number.POSITIVE_INFINITY
    await filed(router())
    expect(channels.posts.at(-1)![1]).toBe(
      "The overhead video didn't upload to Discord: https://champctl.example/replays/incident-1.mp4",
    )
  })

  it.each([
    [
      "with no replays page",
      { replayUrl: "" },
      false,
      ["`incident-1.acreplay` on the replays page"],
    ],
    ["when there's no clip", {}, true, []],
  ])("names the clip as best it can %s", async (_, extra, noEvidence, says) => {
    failGather = noEvidence
    await filed(router(undefined, extra))
    const after = channels.posts.findIndex(([, t]) => t.startsWith("**Incident"))
    expect(
      channels.posts
        .slice(after + 1)
        .map(([, t]) => t.replace(/^A replay clip to watch in the game: /, "")),
    ).toEqual(says)
  })

  it("leaves a draft alone that's being opened when the moment is reported again", async () => {
    const r = router()
    await r.handle(command(ANA, "report", { race: journal, what: "c:0", description: "x" }))
    failOpen = true
    await press(r, "open")
    const again = await r.handle(
      command(ANA, "report", { race: journal, what: "c:0", description: "x" }),
    )
    expect(again.content).toBe("You're already opening that one: <#chan-1>.")
    expect(channels.removed).toEqual([])
  })

  it("finishes opening a draft something stopped, and withdraws one left a day", async () => {
    const DAY = 24 * 3600_000
    const made = new Date()
    const at = (ms: number) => router(undefined, { now: () => new Date(made.getTime() + ms) })
    await at(0).handle(command(ANA, "report", { race: journal, what: "c:0", description: "x" }))
    failOpen = true
    await press(at(0), "open")
    failOpen = false
    await at(0).handle(command(BO, "report", { race: journal, what: "c:0", description: "x" }))
    // One that was being opened is finished on the next sweep: its channel may be public.
    await at(5 * 60_000).sweepDrafts()
    expect(channels.opened.map(([id, name]) => [id, name])).toEqual([
      ["chan-1", "incident-1-ana-bo"],
    ])
    await at(DAY - 60_000).sweepDrafts()
    expect(channels.removed).toEqual([])
    await at(DAY + 60_000).sweepDrafts()
    expect(channels.removed).toEqual(["chan-2"])
  })

  it("tries the video's upload again when Discord drops it once", async () => {
    failVideo = 1
    const logged: string[] = []
    await router(undefined, { log: (l) => logged.push(l) }).handle(
      command(ANA, "report", { race: journal, what: "c:0", description: "x" }),
    )
    expect(channels.posts.at(-2)?.slice(1)).toEqual(["From above:", 1])
    expect(logged.filter((l) => l.startsWith("overhead video"))).toEqual([
      expect.stringMatching(/: other side closed \(0 KB, [\d.]+ s\)$/),
      expect.stringMatching(/: uploaded \(0 KB, [\d.]+ s\)$/),
    ])
  })

  it("keeps the rest of the evidence when the video won't upload, without linking a draft's", async () => {
    // REST has already retried a timeout, and the video may have landed: no second go.
    failVideo = Number.POSITIVE_INFINITY
    videoError = "This operation was aborted"
    videoErrorName = "AbortError"
    await router().handle(command(ANA, "report", { race: journal, what: "c:0", description: "x" }))
    expect(channels.posts.at(-2)![1]).toBe(
      "The overhead video didn't upload (This operation was aborted). It'll be linked here when you open the report.",
    )
    expect(videoTries).toBe(1)
  })

  it("finds a driver by GUID when their name in the game isn't the entry list's", async () => {
    const choices = await router().autocomplete(
      command(BO, "report", { race: journal, what: "" }),
      "what",
    )
    expect(choices.map((c) => c.value)).toEqual(["c:0", "other"])
  })

  it.each([
    ["before", 5000, "incident-1-ana-bo", BO],
    ["after", 9000, "incident-1-ana-dee", DEE],
  ])(
    "takes whoever held a slot at the time, for a contact %s it changed hands",
    async (_, at, name, other) => {
      // Bo leaves at 8 s and Dee joins in the same slot.
      const key = await contact([
        car(1, "Ana"),
        car(2, "Bo"),
        { ...car(2, "Dee"), at: 8000 },
        { ...hit, at },
      ])
      await filed(router(), { race: key })
      expect(channels.opened).toEqual([["chan-1", name, [STEWARDS], [ANA, other]]])
    },
  )

  it("takes something else with a driver only if they were on the server then", async () => {
    const key = await contact([car(1, "Ana"), car(2, "Bo"), { ...car(2, "Dee"), at: 8000 }])
    const reply = await router().handle(
      command(ANA, "report", {
        race: key,
        what: "other",
        other_driver: "Dee",
        when: "0:05",
        description: "x",
      }),
    )
    expect(reply.content).toBe("Dee wasn't on the server at 0:05 in that session.")
  })

  it("doesn't take the other driver by name when their car's GUID says it's someone else", async () => {
    // A guest calling themselves Bo: the real Bo isn't added to the channel or pinged.
    const key = await contact([car(1, "Ana"), car(2, "Bo", "76561198000000099"), hit])
    await filed(router(), { race: key })
    expect(channels.opened).toEqual([["chan-1", "incident-1-ana-bo", [STEWARDS], [ANA]]])
  })

  it("refuses a session older than the list offers, typed in by hand", async () => {
    const old = new Date(Date.now() - 30 * 24 * 3600_000).toISOString().replace(/[:.]/g, "-")
    await writeFile(
      join(dir, `${old}-loop-race.ndjson.gz`),
      await readFile(join(dir, `${journal}-loop-race.ndjson.gz`)),
    )
    const reply = await router().handle(
      command(ANA, "report", { race: old, what: "c:0", description: "x" }),
    )
    expect(reply.content).toMatch(/^Pick the race from the list/)
  })

  it("reads the entry list once for a driver's keystrokes, not once each", async () => {
    const r = router()
    for (const typed of ["", "0", "0:"]) {
      await r.autocomplete(command(ANA, "report", { race: journal, what: typed }), "what")
    }
    expect(reads).toBe(1)
  })

  it("renders one report's evidence at a time", async () => {
    const r = router()
    await Promise.all([
      r.handle(command(ANA, "report", { race: journal, what: "c:0", description: "x" })),
      r.handle(command(BO, "report", { race: journal, what: "c:0", description: "x" })),
    ])
    expect([channels.created.length, rendersAtOnce]).toEqual([2, 1])
  })

  it("doesn't take a driver by name when their car's GUID says it's someone else", async () => {
    // Someone calling themselves Ana in the game, with a GUID that isn't Ana's.
    const key = await contact([
      car(1, "Ana", "76561198000000009"),
      car(2, "Bo", "76561198000000002"),
      hit,
    ])
    const reply = await router().handle(
      command(ANA, "report", { race: key, what: "c:0", description: "x" }),
    )
    expect(reply.content).toMatch(/^I can't find Ana in the recording/)
  })

  it("refuses, rather than going by names, when the entry list can't be read", async () => {
    // Someone calling themselves Ana in the game, whose GUID can't be checked.
    const key = await contact([car(1, "Ana", "76561198000000009"), car(2, "Bo"), hit])
    failRead = true
    const reply = await router().handle(
      command(ANA, "report", { race: key, what: "c:0", description: "x" }),
    )
    expect(reply.content).toMatch(/^I can't read the championship's entry list right now/)
    expect(channels.created).toEqual([])
  })

  it("posts the evidence though the report's own message didn't go through", async () => {
    failFirstPost = true
    const reply = await router().handle(
      command(ANA, "report", { race: journal, what: "c:0", description: "x" }),
    )
    expect(reply.content).toMatch(/^Here's your draft: <#chan-1>/)
    expect(channels.posts.map(([, text]) => text.split("\n")[0])).toContain(
      "**What the recording shows**",
    )
  })

  it("files one report when a driver taps twice", async () => {
    const r = router()
    const report = () =>
      r.handle(command(ANA, "report", { race: journal, what: "c:0", description: "x" }))
    await Promise.all([report(), report()])
    expect(channels.created).toHaveLength(1)
  })

  it.each([
    ["the stewards haven't decided", true, /You have 3 reports the stewards haven't decided yet/],
    ["only counting ones that got a channel", false, /^Here's your draft/],
  ])("holds a driver's reports at three %s", async (_, opened, says) => {
    for (const atMs of [0, 6000, 11000]) {
      const i = store.file(
        {
          reporterDiscord: ANA,
          reporter: "Ana",
          other: "Cy",
          journal: "elsewhere",
          atMs,
          description: "x",
        },
        new Date(),
      )
      if (opened) store.setChannel(i.number, `old-${i.number}`)
    }
    const reply = await router().handle(
      command(ANA, "report", { race: journal, what: "c:0", description: "x" }),
    )
    expect(reply.content).toMatch(says)
  })

  it("counts drafts toward the three", async () => {
    for (const atMs of [0, 6000, 11000]) {
      const filing = { reporterDiscord: ANA, reporter: "Ana", other: "Cy", description: "x" }
      store.draft({ ...filing, journal: "elsewhere", atMs }, new Date())
    }
    const reply = await router().handle(
      command(ANA, "report", { race: journal, what: "c:0", description: "x" }),
    )
    expect(reply.content).toMatch(/You have 3 reports/)
  })

  it("says so when the other driver hasn't claimed their name, and leaves them out", async () => {
    await filed(router({ [ANA]: "Ana" }))
    expect(channels.opened).toEqual([["chan-1", "incident-1-ana-bo", [STEWARDS], [ANA]]])
    expect(channels.posts.find(([, t]) => t.startsWith("**Incident"))![1]).toMatch(
      /Bo hasn't claimed their name/,
    )
  })

  it("takes something else with the other driver and the time", async () => {
    await router().handle(
      command(ANA, "report", {
        race: journal,
        what: "other",
        other_driver: "Cy",
        when: "0:02.5",
        description: "x",
      }),
    )
    expect(channels.created[0]![0]).toBe("draft-1-ana-cy")
    expect(channels.posts.find(([, t]) => t.startsWith("**What"))![1]).toMatch(/at 2500/)
  })

  it.each([
    ["what happened in their own words", "he pushed me wide", "cy"],
    ["the start of a name", "other", "C"],
  ])("takes something else when typed rather than picked: %s", async (_, what, typed) => {
    // As postaL had to, when the list didn't come up in time.
    const reply = await router().handle(
      command(ANA, "report", {
        race: journal,
        what,
        other_driver: typed,
        when: "0:02",
        description: "x",
      }),
    )
    expect(reply.content).toMatch(/^Here's your draft/)
    expect(channels.created[0]![0]).toBe("draft-1-ana-cy")
  })

  it.each([
    ["no other driver", { what: "other", when: "0:02" }, /also say who in other_driver/],
    [
      "a name that's more than one driver's",
      { what: "other", other_driver: "a", when: "0:02" },
      /also say who/,
    ],
    ["no time", { what: "other", other_driver: "Cy" }, /say when/],
    [
      "a time past the recording",
      { what: "other", other_driver: "Cy", when: "9:00" },
      /only runs to 0:/,
    ],
    ["someone else's contact", { what: "c:9" }, /isn't a contact of yours/],
    [
      "themselves",
      { what: "other", other_driver: "Ana", when: "0:02" },
      /an incident is between two cars/,
    ],
  ])("refuses %s", async (_, options, message) => {
    const reply = await router().handle(
      command(ANA, "report", { race: journal, description: "x", ...options }),
    )
    expect(reply.content).toMatch(message)
    expect(channels.created).toEqual([])
  })

  it("doesn't open a second channel for the same report", async () => {
    const r = router()
    await filed(r)
    const again = await r.handle(
      command(ANA, "report", { race: journal, what: "c:0", description: "x" }),
    )
    expect(again.content).toBe("You've already reported that as incident #1: <#chan-1>.")
    expect(channels.created).toHaveLength(1)
  })

  it("lets a report be filed again when its channel couldn't be opened", async () => {
    const r = router()
    failCreate = true
    const first = await r.handle(
      command(ANA, "report", { race: journal, what: "c:0", description: "x" }),
    )
    expect(first.content).toMatch(
      /^I couldn't open a channel for the report\. Tell an admin: Missing Permissions/,
    )
    failCreate = false
    const again = await r.handle(
      command(ANA, "report", { race: journal, what: "c:0", description: "x" }),
    )
    expect(again.content).toMatch(/^Here's your draft: <#chan-1>/)
  })

  it("puts a report's evidence in its session's round folder, and links it there", async () => {
    const round = "2026-10-13-loop"
    const key = await contact([car(1, "Ana"), car(2, "Bo"), hit], round)
    await filed(router(), { race: key })
    expect(gatheredInto).toBe(join(dir, round))
    expect(await readdir(join(dir, round))).toEqual(expect.arrayContaining(["incident-1.mp4"]))
    expect(channels.posts.at(-1)![1]).toBe(
      `A replay clip to watch in the game: https://champctl.example/replays/${round}/incident-1.acreplay`,
    )
  })

  it("makes the draft and says so in the channel when the evidence can't be gathered", async () => {
    failGather = true
    const reply = await router().handle(
      command(ANA, "report", { race: journal, what: "c:0", description: "x" }),
    )
    expect(reply.content).toMatch(/^Here's your draft/)
    expect(channels.buttons.at(-1)).toHaveLength(2)
    expect(channels.posts.at(-2)![1]).toMatch(
      /couldn't gather the recording's evidence for this one: no racing line/,
    )
  })
})

describe("/incident decide", () => {
  const opened = async () => {
    const r = router()
    await filed(r)
    return r
  }

  it("is for the incident's own channel, and for stewards", async () => {
    const r = await opened()
    expect(
      (await r.handle(command("s", "decide", { outcome: "x" }, { roleIds: [STEWARDS] }))).content,
    ).toMatch(/in the incident's own channel/)
    expect(
      (await r.handle(command(ANA, "decide", { outcome: "x" }, { channelId: "chan-1" }))).content,
    ).toMatch(/Only the stewards/)
    expect(channels.locked).toEqual([])
  })

  it("records the decision, tells both drivers, and makes the channel read-only, once", async () => {
    const r = await opened()
    const steward = { channelId: "chan-1", roleIds: [STEWARDS] }
    const reply = await r.handle(command("s", "decide", { outcome: "Racing incident" }, steward))
    expect(reply.content).toMatch(/^Recorded/)
    expect(channels.posts.at(-1)![1]).toBe(
      `**Decision on incident #1**, by <@s>:\n> Racing incident\n\n<@${ANA}> <@${BO}>`,
    )
    expect(channels.pinged.at(-1)).toEqual([ANA, BO])
    expect(channels.locked).toEqual([["chan-1", "closed-1-ana-bo"]])
    expect(store.byChannel("chan-1")?.decision).toBe("Racing incident")
    const again = await r.handle(command("s", "decide", { outcome: "No further action" }, steward))
    expect(again.content).toBe("Incident #1 was already decided: Racing incident")
  })

  it("is made once when two stewards decide at the same time", async () => {
    const r = await opened()
    const steward = (id: string) => ({ channelId: "chan-1", roleIds: [STEWARDS], userId: id })
    await Promise.all([
      r.handle(command("s1", "decide", { outcome: "Racing incident" }, steward("s1"))),
      r.handle(command("s2", "decide", { outcome: "Warning for Bo" }, steward("s2"))),
    ])
    expect(channels.posts.filter(([, text]) => text.startsWith("**Decision"))).toHaveLength(1)
  })

  it("can be made again when the channel couldn't be locked", async () => {
    const r = await opened()
    const steward = { channelId: "chan-1", roleIds: [STEWARDS] }
    failLock = true
    await expect(r.handle(command("s", "decide", { outcome: "x" }, steward))).rejects.toThrow()
    failLock = false
    expect((await r.handle(command("s", "decide", { outcome: "x" }, steward))).content).toMatch(
      /^Recorded/,
    )
    expect(channels.locked).toEqual([["chan-1", "closed-1-ana-bo"]])
  })
})

describe("indexJournal", () => {
  it("reads the session being recorded again once it's grown, but not on every keystroke", async () => {
    const path = join(dir, "live.ndjson.gz")
    const write = async (collisions: number) => {
      await rm(path, { force: true })
      const w = new JournalWriter(path)
      w.write({
        t: "session",
        at: 0,
        serverName: "s",
        track: "loop",
        trackConfig: "",
        name: "Race",
        type: 3,
        recorderCarId: 0,
      })
      for (let i = 0; i < collisions; i++) w.write({ ...hit, at: 1000 * (i + 1) })
      await w.close()
    }
    await write(1)
    await indexJournal(dir, "live.ndjson.gz", 0)
    await write(2)
    expect((await indexJournal(dir, "live.ndjson.gz", 5_000)).collisions).toHaveLength(1)
    expect((await indexJournal(dir, "live.ndjson.gz", 11_000)).collisions).toHaveLength(2)
  })

  it("reads a journal once for callers that ask at the same time", async () => {
    const file = (await readdir(dir)).find((f) => f.endsWith(".ndjson.gz"))!
    const [a, b] = await Promise.all([indexJournal(dir, file), indexJournal(dir, file)])
    expect(a).toBe(b)
  })
})

describe("deciding by vote", () => {
  const FILED = new Date("2026-10-15T05:00:00Z")
  const voting = (now = FILED) =>
    router(undefined, { vote: { hours: 48, roleId: RACERS }, now: () => now })
  const report = (r: IncidentRouter) => filed(r)
  const hoursIn = (hours: number) => new Date(FILED.getTime() + hours * 3600_000)

  it("asks the channel who was at fault, after the evidence", async () => {
    const reply = await report(voting())
    expect(polls).toEqual([
      {
        channel: "chan-1",
        question: "Incident #1: who was at fault?",
        answers: ["Ana", "Bo", "Racing incident (neither)"],
        hours: 48,
      },
    ])
    expect(reply.content).toBe("Opened as incident #1. The Racers vote on it here.")
    expect(channels.opened[0]![2]).toEqual([STEWARDS, RACERS])
    const header = channels.posts.findIndex(([, t]) => t.startsWith("**Incident"))
    expect(channels.posts[header]![1]).toMatch(/\n\n<@&5{18}>: your vote decides this one\.$/)
    expect(channels.pingedRoles[header]).toEqual([RACERS])
    // Nobody but the reporter is called before it's opened.
    expect(channels.pingedRoles.slice(0, header).flat()).toEqual([])
  })

  it.each([
    [
      "the reporter",
      [5, 2, 1],
      "Ana at fault, by vote (Ana: 5, Bo: 2, Racing incident (neither): 1)",
    ],
    [
      "the other driver",
      [1, 4, 0],
      "Bo at fault, by vote (Ana: 1, Bo: 4, Racing incident (neither): 0)",
    ],
    [
      "neither",
      [1, 1, 3],
      "A racing incident: neither driver at fault, by vote (Ana: 1, Bo: 1, Racing incident (neither): 3)",
    ],
  ])("decides for %s when the vote closes", async (_, counts, outcome) => {
    await report(voting())
    pollResult = { finalized: true, counts }
    await voting(hoursIn(47)).settlePolls()
    expect(store.byChannel("chan-1")?.decision).toBeUndefined()
    await voting(hoursIn(48)).settlePolls()
    expect(channels.posts.at(-1)![1]).toBe(
      `**Decision on incident #1**, by the vote:\n> ${outcome}\n\n<@${ANA}> <@${BO}>`,
    )
    expect(channels.locked).toEqual([["chan-1", "closed-1-ana-bo"]])
    expect(store.byChannel("chan-1")).toMatchObject({ decision: outcome, decidedBy: "vote" })
  })

  it.each([
    ["a tie", [2, 2, 1], /was tied/],
    ["no votes", [0, 0, 0], /closed with no votes/],
  ])("hands %s to the stewards, once", async (_, counts, says) => {
    await report(voting())
    pollResult = { finalized: true, counts }
    await voting(hoursIn(49)).settlePolls()
    await voting(hoursIn(50)).settlePolls()
    expect(channels.posts.filter(([, t]) => says.test(t))).toHaveLength(1)
    expect(channels.locked).toEqual([])
    expect(store.byChannel("chan-1")?.decision).toBeUndefined()
  })

  it("waits for Discord to finish counting", async () => {
    await report(voting())
    pollResult = { finalized: false, counts: [5, 0, 0] }
    await voting(hoursIn(49)).settlePolls()
    expect(channels.locked).toEqual([])
    pollResult = { finalized: true, counts: [5, 0, 0] }
    await voting(hoursIn(49)).settlePolls()
    expect(channels.locked).toHaveLength(1)
  })

  it("posts a vote's decision once, though the channel won't close", async () => {
    await report(voting())
    pollResult = { finalized: true, counts: [5, 0, 0] }
    failLock = true
    for (const h of [49, 50, 51]) await voting(hoursIn(h)).settlePolls()
    expect(channels.posts.filter(([, t]) => t.startsWith("**Decision"))).toHaveLength(1)
    expect(channels.posts.at(-1)![1]).toMatch(
      /^The decision is recorded, but I couldn't close this channel/,
    )
    expect(store.byChannel("chan-1")?.decidedBy).toBe("vote")
  })

  it("makes one decision when a steward decides while the vote is being counted", async () => {
    await report(voting())
    const r = voting(hoursIn(49))
    pollResult = { finalized: true, counts: [5, 0, 0] }
    await Promise.all([
      r.settlePolls(),
      r.handle(
        command(
          "s",
          "decide",
          { outcome: "No action" },
          { channelId: "chan-1", roleIds: [STEWARDS] },
        ),
      ),
    ])
    expect(channels.posts.filter(([, t]) => t.startsWith("**Decision"))).toHaveLength(1)
  })

  it("ends the vote when the stewards decide first", async () => {
    await report(voting())
    await voting().handle(
      command(
        "s",
        "decide",
        { outcome: "No action" },
        { channelId: "chan-1", roleIds: [STEWARDS] },
      ),
    )
    expect(ended).toEqual([["chan-1", "poll-1"]])
  })

  it("leaves alone a vote the stewards have already decided", async () => {
    await report(voting())
    await voting().handle(
      command(
        "s",
        "decide",
        { outcome: "No action" },
        { channelId: "chan-1", roleIds: [STEWARDS] },
      ),
    )
    pollResult = { finalized: true, counts: [5, 0, 0] }
    await voting(hoursIn(49)).settlePolls()
    expect(store.byChannel("chan-1")?.decision).toBe("No action")
    expect(channels.locked).toHaveLength(1)
  })
})

describe("parseClock", () => {
  it.each([
    ["12:59", 779_000],
    ["1:02:03", 3_723_000],
    ["12:60", undefined],
    ["soon", undefined],
  ])("%s", (value, ms) => {
    expect(parseClock(value)).toBe(ms)
  })
})
