import { zipSync } from "fflate"
import { describe, expect, it } from "vitest"

import { StaticAcsmReader } from "../src/acsm/client.js"
import type { Championship, Entrant } from "../src/acsm/types.js"
import { LIVERY_COMMAND, LIVERY_COMMANDS } from "../src/bot/commands.js"
import { toSlashCommand } from "../src/bot/discord.js"
import { LiveryRouter } from "../src/bot/livery-router.js"
import type { SlashCommand } from "../src/bot/transport.js"
import { SqliteClaimStore } from "../src/liveries/claims.js"
import { DEFAULT_LIMITS } from "../src/liveries/pack.js"
import { SqliteSubmissionQueue } from "../src/liveries/queue.js"
import { SqliteTokenStore } from "../src/liveries/upload-token.js"
import { championship, championshipClass, entryList, raceEvent } from "./support/build.js"

const CAR = "rss_formula_hybrid_2021"
const CHAMP = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
const OTHER = "11111111-2222-3333-4444-555555555555"
const MISHA = "111111111111111111"
const GUILD = "999999999999999999"
const LIVERY_CHANNEL = "888888888888888888"
const RACER_ROLE = "666666666666666666"

const bytes = (s: string) => new TextEncoder().encode(s)
const skin = (extra: Record<string, Uint8Array> = {}) =>
  zipSync({ "livery.dds": bytes("dds"), "preview.jpg": bytes("jpg"), ...extra })

const person = (over: Partial<Entrant>): Partial<Entrant> => ({ Model: CAR, Skin: "", ...over })

const champ = (over: Partial<Championship> = {}): Championship =>
  championship({
    ID: CHAMP,
    Name: "September 2026",
    Classes: [
      championshipClass({
        Entrants: entryList([person({ Name: "Misha" }), person({ Name: "postaL" })]),
      }),
    ],
    Events: [raceEvent({})],
    ...over,
  })

const NOW = new Date("2026-09-02T20:00:00.000Z")

const command = (over: Partial<SlashCommand> = {}): SlashCommand => ({
  name: "livery",
  options: {},
  userId: MISHA,
  username: "misha",
  guildId: GUILD,
  channelId: LIVERY_CHANNEL,
  roleIds: [RACER_ROLE],
  ...over,
})

const attachment = (body: Uint8Array, size = body.length) => ({
  filename: "whatever the driver called it.zip",
  size,
  download: async () => body,
})

async function router(over: Record<string, unknown> = {}) {
  const store = ":memory:"
  const claims = await SqliteClaimStore.open(store)
  const queue = await SqliteSubmissionQueue.open(store)
  const tokens = await SqliteTokenStore.open(store)
  const reader = new StaticAcsmReader([champ()])
  return {
    claims,
    queue,
    tokens,
    close: () => {
      tokens.close()
      queue.close()
      claims.close()
    },
    router: new LiveryRouter({
      reader,
      claims,
      queue,
      tokens,
      clamp: {},
      now: () => NOW,
      ...over,
    }),
  }
}

describe("the /livery command definition", () => {
  it("takes an attachment option rather than reading messages", () => {
    // Reading a zip off an ordinary message needs the MessageContent intent,
    // which is privileged and would let this token read every message in every
    // channel it can see. discord.ts asks for no intents at all.
    const upload = LIVERY_COMMAND.options.find((o) => o.name === "upload")
    expect(upload?.options[0]).toMatchObject({ name: "file", type: 11, required: true })
  })

  it("is not offered in DMs, where a role clamp cannot be satisfied", () => {
    expect(LIVERY_COMMAND.dmPermission).toBe(false)
  })

  it("tells a driver the entry list name has to match exactly, where they type it", () => {
    const claim = LIVERY_COMMAND.options.find((o) => o.name === "claim")
    expect(claim?.options[0]?.description).toMatch(/exactly/)
  })

  it("offers the three subcommands and nothing else", () => {
    expect(LIVERY_COMMANDS).toHaveLength(1)
    expect(LIVERY_COMMAND.options.map((o) => o.name).sort()).toEqual([
      "claim",
      "upload",
      "upload-url",
    ])
  })

  it("keeps every name and description within Discord's limits", () => {
    // Discord rejects the whole registration for one over-long description, so
    // the first sign would be a bot that starts and answers nothing.
    for (const sub of LIVERY_COMMAND.options) {
      expect(sub.name).toMatch(/^[a-z-]{1,32}$/)
      expect(sub.description.length).toBeLessThanOrEqual(100)
      for (const option of sub.options) {
        expect(option.name).toMatch(/^[a-z-]{1,32}$/)
        expect(option.description.length).toBeLessThanOrEqual(100)
      }
    }
  })
})

describe("LiveryRouter", () => {
  it("claims, and hands back an announcement for the admin channel", async () => {
    const r = await router()
    const reply = await r.router.handle(
      command({ subcommand: "claim", options: { name: "Misha" } }),
    )
    expect(reply.content).toMatch(/You're claimed as "Misha"/)
    // Carried back rather than posted here, so the router keeps having no way
    // to talk to Discord.
    expect(reply.announcement).toMatch(/claimed the entry list name/)
    r.close()
  })

  it("passes a claim refusal through and announces nothing", async () => {
    const r = await router()
    const reply = await r.router.handle(
      command({ subcommand: "claim", options: { name: "Nobody" } }),
    )
    expect(reply.content).toMatch(/isn't on the entry list/)
    expect(reply.announcement).toBeUndefined()
    r.close()
  })

  it("queues an upload once the driver has claimed", async () => {
    const r = await router()
    await r.router.handle(command({ subcommand: "claim", options: { name: "Misha" } }))
    const reply = await r.router.handle(
      command({ subcommand: "upload", attachment: attachment(skin()) }),
    )

    expect(reply.content).toMatch(/2 files for Misha/)
    expect((await r.queue.queued(CHAMP)).map((s) => s.driverName)).toEqual(["Misha"])
    r.close()
  })

  it("sends an unclaimed driver to /livery claim", async () => {
    const r = await router()
    const reply = await r.router.handle(
      command({ subcommand: "upload", attachment: attachment(skin()) }),
    )
    expect(reply.content).toMatch(/\/livery claim/)
    r.close()
  })

  /**
   * Checked against the size Discord reported, before fetching anything.
   * Downloading first and then refusing would spend the bandwidth to learn what
   * the payload already said.
   */
  it("refuses an oversized attachment without downloading it", async () => {
    const r = await router()
    await r.router.handle(command({ subcommand: "claim", options: { name: "Misha" } }))

    let downloaded = false
    const reply = await r.router.handle(
      command({
        subcommand: "upload",
        attachment: {
          filename: "huge.zip",
          size: DEFAULT_LIMITS.maxTotalBytes + 1,
          download: async () => {
            downloaded = true
            return skin()
          },
        },
      }),
    )

    expect(downloaded).toBe(false)
    expect(reply.content).toMatch(/upload-url/)
    r.close()
  })

  it("says what to attach when the option is missing", async () => {
    const r = await router()
    const reply = await r.router.handle(command({ subcommand: "upload" }))
    expect(reply.content).toMatch(/needs a zip attached/)
    r.close()
  })

  it("obeys the clamp before anything else", async () => {
    const r = await router({ clamp: { channelIds: [LIVERY_CHANNEL] } })
    const reply = await r.router.handle(
      command({
        subcommand: "claim",
        options: { name: "Misha" },
        channelId: "777777777777777777",
      }),
    )
    expect(reply.content).toMatch(/Not here/)
    r.close()
  })

  it("hands out an upload link when the league has one", async () => {
    const r = await router({ uploadBaseUrl: "https://liveries.example.com" })
    await r.router.handle(command({ subcommand: "claim", options: { name: "Misha" } }))
    const reply = await r.router.handle(command({ subcommand: "upload-url" }))
    expect(reply.content).toMatch(/https:\/\/liveries\.example\.com\/u\//)
    r.close()
  })

  it("says so when the league has no upload server", async () => {
    const r = await router()
    await r.router.handle(command({ subcommand: "claim", options: { name: "Misha" } }))
    const reply = await r.router.handle(command({ subcommand: "upload-url" }))
    expect(reply.content).toMatch(/hasn't set up upload links/)
    r.close()
  })

  it("does not pretend to know a command it wasn't given", async () => {
    const r = await router()
    expect((await r.router.handle(command({ name: "stats" }))).content).toMatch(/don't know/)
    expect((await r.router.handle(command({ subcommand: "delete" }))).content).toMatch(/don't know/)
    r.close()
  })

  /**
   * The promise `autoApply` makes is about a different process — the drain,
   * which holds the credentials this one must never have. Without the heartbeat
   * an operator who set the flag and never started the watcher would have every
   * driver told "shortly" for ever.
   */
  it("does not promise self-serve when no drain has run", async () => {
    const r = await router({ autoApply: true })
    await r.router.handle(command({ subcommand: "claim", options: { name: "Misha" } }))
    const reply = await r.router.handle(
      command({ subcommand: "upload", attachment: attachment(skin()) }),
    )
    expect(reply.content).toMatch(/queued for an admin/)
    r.close()
  })

  it("promises self-serve once the watcher has been seen", async () => {
    const r = await router({ autoApply: true })
    await r.queue.recordDrainRun(CHAMP, NOW)
    await r.router.handle(command({ subcommand: "claim", options: { name: "Misha" } }))
    const reply = await r.router.handle(
      command({ subcommand: "upload", attachment: attachment(skin()) }),
    )
    expect(reply.content).toMatch(/go on the server shortly/)
    r.close()
  })
})

/**
 * Which championship an upload is for (docs/discord-livery-upload.md §7).
 *
 * Refuses ambiguity rather than picking. Quietly choosing one of two running
 * series puts a livery on the wrong car — a failure nobody looks for, because
 * the upload succeeded.
 */
describe("choosing the championship", () => {
  const twoRunning = () => [champ(), champ({ ID: OTHER, Name: "GT3 Series" })]

  it("uses the only one that still has racing to come", async () => {
    const claims = await SqliteClaimStore.open(":memory:")
    const queue = await SqliteSubmissionQueue.open(":memory:")
    const tokens = await SqliteTokenStore.open(":memory:")
    const r = new LiveryRouter({
      reader: new StaticAcsmReader([champ()]),
      claims,
      queue,
      tokens,
      clamp: {},
      now: () => NOW,
    })
    expect(
      (await r.handle(command({ subcommand: "claim", options: { name: "Misha" } }))).content,
    ).toMatch(/claimed as "Misha"/)
    tokens.close()
    queue.close()
    claims.close()
  })

  it("refuses to guess between two running championships", async () => {
    const claims = await SqliteClaimStore.open(":memory:")
    const queue = await SqliteSubmissionQueue.open(":memory:")
    const tokens = await SqliteTokenStore.open(":memory:")
    const r = new LiveryRouter({
      reader: new StaticAcsmReader(twoRunning()),
      claims,
      queue,
      tokens,
      clamp: {},
      now: () => NOW,
    })
    const reply = await r.handle(command({ subcommand: "claim", options: { name: "Misha" } }))
    expect(reply.content).toMatch(/2 championships running/)
    expect(reply.content).toMatch(/September 2026, GT3 Series/)
    expect(reply.content).toMatch(/championshipId/)
    tokens.close()
    queue.close()
    claims.close()
  })

  it("takes the pinned one without asking, when a league has set it", async () => {
    const claims = await SqliteClaimStore.open(":memory:")
    const queue = await SqliteSubmissionQueue.open(":memory:")
    const tokens = await SqliteTokenStore.open(":memory:")
    const r = new LiveryRouter({
      reader: new StaticAcsmReader(twoRunning()),
      claims,
      queue,
      tokens,
      clamp: {},
      championshipId: CHAMP,
      now: () => NOW,
    })
    expect(
      (await r.handle(command({ subcommand: "claim", options: { name: "Misha" } }))).content,
    ).toMatch(/claimed as "Misha"/)
    tokens.close()
    queue.close()
    claims.close()
  })

  it("says there is nowhere to put a livery when nothing is running", async () => {
    const claims = await SqliteClaimStore.open(":memory:")
    const queue = await SqliteSubmissionQueue.open(":memory:")
    const tokens = await SqliteTokenStore.open(":memory:")
    const r = new LiveryRouter({
      reader: new StaticAcsmReader([]),
      claims,
      queue,
      tokens,
      clamp: {},
      now: () => NOW,
    })
    expect(
      (await r.handle(command({ subcommand: "claim", options: { name: "Misha" } }))).content,
    ).toMatch(/nowhere to put a livery/)
    tokens.close()
    queue.close()
    claims.close()
  })
})

/**
 * The one boundary that touches `discord.js`.
 *
 * Past `toSlashCommand` it is ids, strings and a thunk, which is what lets
 * everything above be tested without a gateway. The adapter itself is worth
 * pinning because its mistakes are silent: a clamp reading no roles refuses
 * everyone, and a missing subcommand answers nobody.
 */
describe("toSlashCommand", () => {
  const interaction = (over: Record<string, unknown> = {}) =>
    ({
      commandName: "livery",
      options: {
        data: [{ name: "claim", options: [{ name: "name", value: "Misha" }] }],
        getSubcommand: () => "claim",
        getAttachment: () => null,
      },
      user: { id: MISHA, username: "misha" },
      guildId: GUILD,
      channelId: LIVERY_CHANNEL,
      member: { roles: { cache: new Map([[RACER_ROLE, {}]]) } },
      inCachedGuild: () => true,
      ...over,
    }) as unknown as Parameters<typeof toSlashCommand>[0]

  it("reads the subcommand and its string options", () => {
    expect(toSlashCommand(interaction())).toMatchObject({
      name: "livery",
      subcommand: "claim",
      options: { name: "Misha" },
      userId: MISHA,
      username: "misha",
    })
  })

  it("takes roles from the payload, so no privileged intent is needed", () => {
    expect(toSlashCommand(interaction()).roleIds).toEqual([RACER_ROLE])
  })

  it("has no guild and no roles in a DM, which is what the clamp checks", () => {
    const dm = toSlashCommand(
      interaction({ guildId: null, member: null, inCachedGuild: () => false }),
    )
    expect(dm.guildId).toBeUndefined()
    expect(dm.roleIds).toEqual([])
  })

  it("carries the attachment's size without fetching it", async () => {
    let fetched = false
    const withFile = interaction({
      options: {
        data: [{ name: "upload", options: [] }],
        getSubcommand: () => "upload",
        getAttachment: () => {
          fetched = true
          return { name: "livery.zip", size: 1234, url: "https://cdn.example/x.zip" }
        },
      },
    })
    const command = toSlashCommand(withFile)
    expect(command.attachment).toMatchObject({ filename: "livery.zip", size: 1234 })
    // `getAttachment` ran, but nothing was downloaded — that waits for the
    // router to decide the size is acceptable.
    expect(fetched).toBe(true)
  })

  it("has no attachment when the option wasn't given", () => {
    expect(toSlashCommand(interaction()).attachment).toBeUndefined()
  })

  it("omits the subcommand rather than inventing one", () => {
    const bare = toSlashCommand(
      interaction({
        options: { data: [], getSubcommand: () => null, getAttachment: () => null },
      }),
    )
    expect(bare.subcommand).toBeUndefined()
  })
})
