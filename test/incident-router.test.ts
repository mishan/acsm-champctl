import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { type AcsmReader, StaticAcsmReader } from "../src/acsm/client.js"
import type { SlashCommand } from "../src/bot/transport.js"
import { type IncidentChannels, IncidentRouter, parseClock } from "../src/incidents/router.js"
import { SqliteIncidentStore } from "../src/incidents/store.js"
import { type JournalRecord, JournalWriter } from "../src/spectator/journal.js"
import type { DriverClaim } from "../src/liveries/claims.js"
import type { Evidence } from "../src/spectator/evidence.js"
import { parseFastLane, Track } from "../src/spectator/track.js"
import { championship, championshipClass, entryList } from "./support/build.js"
import { writeScenario } from "./support/incident-scenario.js"
import { fastLane, loop } from "./support/synthetic-track.js"

const CHAMP = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
const STEWARDS = "9".repeat(18)
const ANA = "1".repeat(18)
const BO = "2".repeat(18)
const DEE = "4".repeat(18)

let dir: string
/** The race option's value: the recorder's timestamp at the front of the journal's name. */
let journal: string
let stamp: string
let store: SqliteIncidentStore
let channels: {
  created: [string, readonly string[]][]
  posts: [string, string, number][]
  pinged: (readonly string[])[]
  locked: string[]
}
let failGather: boolean
let failCreate: boolean
let failLock: boolean

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
  channels = { created: [], posts: [], pinged: [], locked: [] }
  failGather = false
  failCreate = false
  failLock = false
})
afterEach(async () => {
  store.close()
  await rm(dir, { recursive: true, force: true })
})

function router(claimed: Record<string, string> = { [ANA]: "Ana", [BO]: "Bo", [DEE]: "Dee" }) {
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
    create: async (name, users) => {
      if (failCreate) throw new Error("Missing Permissions")
      // As long as Discord takes, so a second tap arrives while the first is waiting.
      await new Promise((r) => setTimeout(r, 20))
      channels.created.push([name, users])
      return `chan-${channels.created.length}`
    },
    post: async (id, content, files, pings) => {
      channels.posts.push([id, content, files?.length ?? 0])
      channels.pinged.push(pings ?? [])
    },
    lock: async (id) => {
      if (failLock) throw new Error("Missing Permissions")
      channels.locked.push(id)
    },
  }
  return new IncidentRouter({
    recordings: dir,
    acRoot: dir,
    replayUrl: "https://champctl.example/replays",
    championshipId: CHAMP,
    reader: new StaticAcsmReader([c]) as unknown as AcsmReader,
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
    gather: async (q): Promise<Evidence> => {
      if (failGather) throw new Error("no racing line")
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
async function contact(records: JournalRecord[]): Promise<string> {
  const key = "2026-01-01T00-00-00-000Z"
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
  for (const r of records) w.write(r)
  await w.close()
  return key
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
  it("offers recent sessions by their recordings' names", async () => {
    const choices = await router().autocomplete(command(ANA, "report", { race: "" }), "race")
    expect(choices).toEqual([{ name: expect.stringMatching(/^Race · loop · /), value: stamp }])
  })

  it("offers the reporter's own contacts, and something else", async () => {
    const choices = await router().autocomplete(
      command(ANA, "report", { race: journal, what: "" }),
      "what",
    )
    expect(choices.map((c) => c.value)).toEqual(["c:0", "other"])
    expect(choices[0]!.name).toMatch(/^0:05 · contact with B0 \[BATL\]/)
  })

  it("offers someone else only something else", async () => {
    const choices = await router({ [ANA]: "Ana", [BO]: "Bo", c: "Cy" }).autocomplete(
      command("c", "report", { race: journal, what: "" }),
      "what",
    )
    expect(choices.map((c) => c.value)).toEqual(["other"])
  })
})

describe("/incident report", () => {
  it("asks a driver to claim their name first", async () => {
    const reply = await router({}).handle(
      command(ANA, "report", { race: journal, what: "c:0", description: "x" }),
    )
    expect(reply.content).toMatch(/\/livery claim/)
    expect(channels.created).toEqual([])
  })

  it("opens a channel for both drivers with the report and the evidence", async () => {
    const reply = await router().handle(
      command(ANA, "report", { race: journal, what: "c:0", description: "Bo turned in on me" }),
    )
    expect(reply.content).toBe(
      "Filed as incident #1: <#chan-1>. The stewards will look at it there.",
    )
    // The other driver is told they've been reported; the reporter knows.
    expect(channels.pinged[0]).toEqual([BO])
    expect(channels.created).toEqual([["incident-1-ana-bo", [ANA, BO]]])
    expect(channels.posts[0]![1]).toMatch(
      new RegExp(
        `^\\*\\*Incident #1\\*\\*: <@${ANA}> reports <@${BO}>\\. Race at loop, 0:05 into the session\\.\\n> Bo turned in on me$`,
      ),
    )
    // The facts, the call with its drawing, then the video with the clip's link.
    expect(channels.posts.slice(1).map(([, text, files]) => [text.split("\n")[0], files])).toEqual([
      ["**What the recording shows**", 0],
      ["**Suggested call: unclear**", 1],
      [
        "Overhead video below, and a replay clip to watch in the game: https://champctl.example/replays/incident-1.acreplay",
        1,
      ],
    ])
  })

  it("finds a driver by GUID when their name in the game isn't the entry list's", async () => {
    const choices = await router().autocomplete(
      command(BO, "report", { race: journal, what: "" }),
      "what",
    )
    expect(choices.map((c) => c.value)).toEqual(["c:0", "other"])
  })

  it("takes the driver who held the slot at the time, when it changed hands later", async () => {
    // Bo leaves after the contact and Dee joins in the same slot.
    const key = await contact([car(1, "Ana"), car(2, "Bo"), hit, { ...car(2, "Dee"), at: 8000 }])
    await router().handle(command(ANA, "report", { race: key, what: "c:0", description: "x" }))
    expect(channels.created).toEqual([["incident-1-ana-bo", [ANA, BO]]])
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

  it("files one report when a driver taps twice", async () => {
    const r = router()
    const report = () =>
      r.handle(command(ANA, "report", { race: journal, what: "c:0", description: "x" }))
    await Promise.all([report(), report()])
    expect(channels.created).toHaveLength(1)
  })

  it("holds a driver's reports at three the stewards haven't decided", async () => {
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
      store.setChannel(i.number, `old-${i.number}`)
    }
    const reply = await router().handle(
      command(ANA, "report", { race: journal, what: "c:0", description: "x" }),
    )
    expect(reply.content).toMatch(/You have 3 reports the stewards haven't decided yet/)
    expect(channels.created).toEqual([])
  })

  it("says so when the other driver hasn't claimed their name, and leaves them out", async () => {
    await router({ [ANA]: "Ana" }).handle(
      command(ANA, "report", { race: journal, what: "c:0", description: "x" }),
    )
    expect(channels.created).toEqual([["incident-1-ana-bo", [ANA]]])
    expect(channels.posts[0]![1]).toMatch(/Bo hasn't claimed their name/)
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
    expect(channels.created[0]![0]).toBe("incident-1-ana-cy")
    expect(channels.posts.find(([, t]) => t.startsWith("**What"))![1]).toMatch(/at 2500/)
  })

  it.each([
    ["no other driver", { what: "other", when: "0:02" }, /pick the other driver/],
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
    await r.handle(command(ANA, "report", { race: journal, what: "c:0", description: "x" }))
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
    failLock = false
    const again = await r.handle(
      command(ANA, "report", { race: journal, what: "c:0", description: "x" }),
    )
    expect(again.content).toMatch(/^Filed as incident #2: <#chan-1>/)
  })

  it("files the report and says so in the channel when the evidence can't be gathered", async () => {
    failGather = true
    const reply = await router().handle(
      command(ANA, "report", { race: journal, what: "c:0", description: "x" }),
    )
    expect(reply.content).toMatch(/^Filed as incident #1/)
    expect(channels.posts.at(-1)![1]).toMatch(
      /couldn't gather the recording's evidence for this one: no racing line/,
    )
  })
})

describe("/incident decide", () => {
  const filed = async () => {
    const r = router()
    await r.handle(command(ANA, "report", { race: journal, what: "c:0", description: "x" }))
    return r
  }

  it("is for the incident's own channel, and for stewards", async () => {
    const r = await filed()
    expect(
      (await r.handle(command("s", "decide", { outcome: "x" }, { roleIds: [STEWARDS] }))).content,
    ).toMatch(/in the incident's own channel/)
    expect(
      (await r.handle(command(ANA, "decide", { outcome: "x" }, { channelId: "chan-1" }))).content,
    ).toMatch(/Only the stewards/)
    expect(channels.locked).toEqual([])
  })

  it("records the decision, tells both drivers, and makes the channel read-only, once", async () => {
    const r = await filed()
    const steward = { channelId: "chan-1", roleIds: [STEWARDS] }
    const reply = await r.handle(command("s", "decide", { outcome: "Racing incident" }, steward))
    expect(reply.content).toMatch(/^Recorded/)
    expect(channels.posts.at(-1)![1]).toBe(
      `**Decision on incident #1**, by <@s>:\n> Racing incident\n\n<@${ANA}> <@${BO}>`,
    )
    expect(channels.pinged.at(-1)).toEqual([ANA, BO])
    expect(channels.locked).toEqual(["chan-1"])
    expect(store.byChannel("chan-1")?.decision).toBe("Racing incident")
    const again = await r.handle(command("s", "decide", { outcome: "No further action" }, steward))
    expect(again.content).toBe("Incident #1 was already decided: Racing incident")
  })

  it("can be made again when the channel couldn't be locked", async () => {
    const r = await filed()
    const steward = { channelId: "chan-1", roleIds: [STEWARDS] }
    failLock = true
    await expect(r.handle(command("s", "decide", { outcome: "x" }, steward))).rejects.toThrow()
    failLock = false
    expect((await r.handle(command("s", "decide", { outcome: "x" }, steward))).content).toMatch(
      /^Recorded/,
    )
    expect(channels.locked).toEqual(["chan-1"])
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
