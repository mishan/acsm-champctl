/**
 * What actually goes out over the gateway.
 *
 * Two words carry most of the safety on the livery path and both are a single
 * property in a single call: `MessageFlags.Ephemeral` on the deferral, and
 * `allowedMentions: { parse: [] }` on the admin announcement. Neither had a
 * test, so deleting either left all 1600 of them green — while one turns every
 * upload link into a public message and the other lets an entry list name ping
 * the guild.
 *
 * `GatewayTransport.wrapping` exists for this: a fake client is enough to drive
 * `post` and the interaction handler, without a token or a socket.
 */
import {
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  Events,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js"
import { describe, expect, it, vi } from "vitest"

import { GatewayTransport, toSlashCommand } from "../src/bot/discord.js"
import type { CommandRouter } from "../src/bot/transport.js"

interface Sent {
  channelId: string
  payload: unknown
}

/** Just enough Client for the two paths under test. */
function fakeClient() {
  const sent: Sent[] = []
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const client = {
    channels: {
      fetch: async (channelId: string) => ({
        isSendable: () => true,
        type: 0,
        send: async (payload: unknown) => {
          sent.push({ channelId, payload })
        },
      }),
    },
    on(event: string, handler: (...args: unknown[]) => void) {
      handlers.set(event, handler)
      return this
    },
  }
  return { client: client as unknown as Client, sent, handlers }
}

const router = (content: string, announcement?: string): CommandRouter => ({
  handle: async () => (announcement ? { content, announcement } : { content }),
})

function fakeInteraction(name = "livery") {
  const calls: { deferred?: unknown; edited?: unknown } = {}
  return {
    calls,
    interaction: {
      commandName: name,
      isChatInputCommand: () => true,
      isAutocomplete: () => false,
      user: { id: "111111111111111111", username: "misha" },
      channelId: "222222222222222222",
      guildId: "333333333333333333",
      member: { roles: [] },
      inCachedGuild: () => false,
      options: {
        data: [],
        getString: () => null,
        getAttachment: () => null,
        getSubcommand: () => "claim",
      },
      deferReply: async (opts: unknown) => {
        calls.deferred = opts
      },
      editReply: async (opts: unknown) => {
        calls.edited = opts
      },
    },
  }
}

describe("GatewayTransport options", () => {
  it("passes whole-number and yes-or-no options to the router as text", async () => {
    const { client, handlers } = fakeClient()
    const got: Record<string, string>[] = []
    GatewayTransport.wrapping(client).listen({
      handle: async (c) => {
        got.push(c.options)
        return { content: "" }
      },
    })
    const { interaction } = fakeInteraction("season")
    interaction.options.data = [
      {
        name: "start",
        options: [
          { name: "cars", value: 3 },
          { name: "one_vote", value: true },
        ],
      },
    ] as never
    await handlers.get("interactionCreate")?.(interaction)
    await new Promise((r) => setTimeout(r, 0))
    expect(got).toEqual([{ cars: "3", one_vote: "true" }])
  })
})

describe("GatewayTransport autocomplete", () => {
  it("asks the router for the focused option's suggestions and answers with them", async () => {
    const { client, handlers } = fakeClient()
    const asked: [string, string, Record<string, string>][] = []
    let answered: unknown
    GatewayTransport.wrapping(client).listen({
      handle: async () => ({ content: "" }),
      autocomplete: async (command, focused) => {
        asked.push([command.name, focused, command.options])
        return [{ name: "Race · loop", value: "j.ndjson.gz" }]
      },
    })
    await handlers.get("interactionCreate")?.({
      isAutocomplete: () => true,
      isChatInputCommand: () => false,
      commandName: "incident",
      user: { id: "1", username: "ana" },
      channelId: "2",
      guildId: "3",
      member: { roles: [] },
      options: {
        data: [{ name: "report", options: [{ name: "race", value: "lo", focused: true }] }],
        getFocused: () => ({ name: "race", value: "lo" }),
        getSubcommand: () => "report",
      },
      respond: async (choices: unknown) => {
        answered = choices
      },
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(asked).toEqual([["incident", "race", { race: "lo" }]])
    expect(answered).toEqual([{ name: "Race · loop", value: "j.ndjson.gz" }])
  })
})

describe("GatewayTransport incident channels", () => {
  /** A channel's overwrites as discord.js holds them: everyone may view and send. */
  const VIEW_SEND = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages
  const channel = (ids: string[], edit: (o: unknown) => Promise<unknown>) => ({
    type: ChannelType.GuildText,
    guildId: "g",
    permissionOverwrites: {
      cache: new Map(
        ids.map((id) => [
          id,
          {
            id,
            type: id === "stewards" || id === "g" ? 0 : 1,
            allow: { bitfield: VIEW_SEND },
            deny: { bitfield: 0n },
          },
        ]),
      ),
    },
    edit,
  })

  it("closes a channel in one edit: everyone but the bot and @everyone stops posting, threads included, as Discord has it now", async () => {
    const edits: unknown[] = []
    // The cached copy predates a member a steward added by hand.
    const client = {
      user: { id: "bot" },
      channels: {
        fetch: async (_: string, o?: { force?: boolean }) =>
          channel(
            o?.force ? ["g", "stewards", "ana", "added", "bot"] : ["g", "stewards", "ana", "bot"],
            async (e) => edits.push(e),
          ),
      },
    }
    await GatewayTransport.wrapping(client as unknown as Client).lockChannel(
      "c",
      "closed-1-ana-bo",
      "closed",
    )
    const shut =
      PermissionFlagsBits.SendMessages |
      PermissionFlagsBits.SendMessagesInThreads |
      PermissionFlagsBits.CreatePublicThreads |
      PermissionFlagsBits.CreatePrivateThreads
    const closed = { allow: VIEW_SEND & ~shut, deny: shut }
    const open = { allow: VIEW_SEND, deny: 0n }
    expect(edits).toEqual([
      {
        name: "closed-1-ana-bo",
        parent: "closed",
        lockPermissions: false,
        permissionOverwrites: [
          { id: "g", type: 0, ...open },
          { id: "stewards", type: 0, ...closed },
          { id: "ana", type: 1, ...closed },
          { id: "added", type: 1, ...closed },
          { id: "bot", type: 1, ...open },
        ],
      },
    ])
  })

  it("tells the steward to try again rather than wait on Discord without end", async () => {
    vi.useFakeTimers()
    try {
      const client = {
        user: { id: "bot" },
        channels: { fetch: async () => channel(["g", "ana"], () => new Promise(() => {})) },
      }
      const closing = GatewayTransport.wrapping(client as unknown as Client).lockChannel(
        "c",
        "closed-1",
      )
      const failed = expect(closing).rejects.toThrow(/holding back changes to this channel/)
      await vi.advanceTimersByTimeAsync(60_000)
      await failed
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    [30013, /50 channels in a category/],
    [50013, /needs Manage Channels and Manage Roles/],
    [10003, /discord\.incidents\.categoryId/],
  ])("says what Discord's error %i means when a channel can't be made", async (code, says) => {
    const client = {
      user: { id: "bot" },
      guilds: {
        fetch: async () => ({
          channels: {
            create: async () => {
              throw Object.assign(new Error("refused"), { code })
            },
          },
        }),
      },
    }
    await expect(
      GatewayTransport.wrapping(client as unknown as Client).createPrivateChannel("g", {
        parentId: "cat",
        name: "incident-1",
        roleIds: ["stewards"],
        userIds: ["ana"],
      }),
    ).rejects.toThrow(says)
  })
})

describe("GatewayTransport incident votes", () => {
  it("lets every role it's given into a new channel", async () => {
    let made: { permissionOverwrites: { id: string; allow?: unknown }[] } | undefined
    const client = {
      user: { id: "bot" },
      guilds: {
        fetch: async () => ({
          channels: {
            create: async (o: typeof made) => {
              made = o
              return { id: "c" }
            },
          },
        }),
      },
    }
    await GatewayTransport.wrapping(client as unknown as Client).createPrivateChannel("g", {
      parentId: "cat",
      name: "incident-1",
      roleIds: ["stewards", "racers"],
      userIds: ["ana"],
    })
    expect(made?.permissionOverwrites.filter((o) => o.allow).map((o) => o.id)).toEqual([
      "stewards",
      "racers",
      "ana",
      "bot",
    ])
    // Only the bot may start a poll.
    const polls = (id: string) =>
      ((made?.permissionOverwrites.find((o) => o.id === id)?.allow ?? []) as bigint[]).includes(
        PermissionFlagsBits.SendPolls,
      )
    expect(["stewards", "racers", "ana", "bot"].map(polls)).toEqual([false, false, false, true])
  })

  it("posts a one-choice poll, and reads its votes back in the order of its answers", async () => {
    const sent: unknown[] = []
    const answers = new Map([
      [3, { id: 3, voteCount: 1 }],
      [1, { id: 1, voteCount: 5 }],
      [2, { id: 2, voteCount: 0 }],
    ])
    const client = {
      channels: {
        fetch: async () => ({
          isSendable: () => true,
          isTextBased: () => true,
          send: async (p: unknown) => {
            sent.push(p)
            return { id: "m" }
          },
          messages: { fetch: async () => ({ poll: { resultsFinalized: true, answers } }) },
        }),
      },
    }
    const t = GatewayTransport.wrapping(client as unknown as Client)
    expect(await t.postPoll("c", "Who?", ["Ana", "Bo", "Neither"], 48)).toBe("m")
    expect(sent[0]).toMatchObject({
      poll: {
        question: { text: "Who?" },
        answers: [{ text: "Ana" }, { text: "Bo" }, { text: "Neither" }],
        duration: 48,
        allowMultiselect: false,
      },
    })
    expect(await t.pollResults("c", "m")).toEqual({ finalized: true, counts: [5, 0, 1] })
    await t.postPoll("c", "Cars?", ["A", "B"], 120, {
      multiselect: true,
      content: "<@&5> vote",
      pingRoles: ["5"],
    })
    expect(sent[1]).toMatchObject({
      content: "<@&5> vote",
      poll: { allowMultiselect: true },
      allowedMentions: { parse: [], roles: ["5"] },
    })
  })
})

describe("GatewayTransport.post", () => {
  it("attaches a file when the message carries one", async () => {
    // The trophy-room image. Sent with the same no-pings rule as everything else.
    const { client, sent } = fakeClient()
    const transport = GatewayTransport.wrapping(client)
    const data = new Uint8Array([137, 80, 78, 71])

    await transport.post({
      channelId: "444444444444444444",
      content: "**October**",
      files: [{ name: "October-podium.png", data, description: "October: 1st place ada" }],
    })

    const payload = sent[0]?.payload as {
      files: { attachment: Buffer; name: string; description?: string }[]
    }
    expect(payload.files[0]?.description).toBe("October: 1st place ada")
    expect(payload).toMatchObject({ content: "**October**", allowedMentions: { parse: [] } })
    expect(payload.files[0]?.name).toBe("October-podium.png")
    expect([...payload.files[0]!.attachment]).toEqual([...data])
  })

  it("pings the users and roles a message names, and still nobody else", async () => {
    // An incident's decision tells both drivers; a name in its text that reads
    // "@everyone" still mustn't.
    const { client, sent } = fakeClient()
    const transport = GatewayTransport.wrapping(client)
    await transport.post({
      channelId: "444444444444444444",
      content: "@everyone <@5> <@&6>",
      pings: ["5"],
      pingRoles: ["6"],
    })
    expect(sent[0]?.payload).toMatchObject({
      allowedMentions: { parse: [], users: ["5"], roles: ["6"] },
    })
  })

  it("suppresses every mention in an admin announcement", async () => {
    // The claim announcement is the only non-ephemeral message the livery path
    // produces, and its text carries an entry list name. On a league with open
    // sign-ups that name is attacker-supplied, and `@` passes SAFE_COMPONENT —
    // so signing up as "@everyone" and running /racer claim was a guild-wide
    // ping, on demand, from the bot's own token.
    const { client, sent } = fakeClient()
    const transport = GatewayTransport.wrapping(client)

    await transport.post({ channelId: "444444444444444444", content: "**@everyone** claimed it." })

    expect(sent).toHaveLength(1)
    expect(sent[0]?.payload).toMatchObject({
      content: "**@everyone** claimed it.",
      allowedMentions: { parse: [] },
    })
  })

  /** A client whose every channel lookup answers `channel`. */
  const clientFinding = (channel: unknown) =>
    ({
      channels: { fetch: async () => channel },
      on() {
        return this
      },
    }) as unknown as Client

  const announceSource = "discord.announceChannelId in the profile"

  it("names the setting a missing channel came from, not always the admin one", async () => {
    // This said "Check discord.adminChannelId" whatever was posting, so a wrong
    // announce channel sent the operator to check the one setting that was right.
    const post = GatewayTransport.wrapping(clientFinding(null)).post({
      channelId: "444444444444444444",
      content: "hi",
      source: announceSource,
    })
    await expect(post).rejects.toThrow(/Check discord\.announceChannelId in the profile/)
    await expect(post).rejects.not.toThrow(/adminChannelId/)
  })

  it("says champctl, not gridmom, can't post into a channel of the wrong kind", async () => {
    const category = { isSendable: () => false, type: 4 }
    const post = GatewayTransport.wrapping(clientFinding(category)).post({
      channelId: "444444444444444444",
      content: "hi",
      source: announceSource,
    })
    await expect(post).rejects.toThrow(/ordinary text channel; check discord\.announceChannelId/)
    await expect(post).rejects.not.toThrow(/gridmom/)
  })
})

describe("GatewayTransport.listen", () => {
  it("defers ephemerally, before the router runs", async () => {
    // A refusal usually names something embarrassing in somebody's zip, and an
    // upload link is a bearer credential. Neither belongs in a channel.
    const { client, handlers } = fakeClient()
    const transport = GatewayTransport.wrapping(client)
    transport.listen(router("queued"))

    const { interaction, calls } = fakeInteraction()
    await handlers.get(Events.InteractionCreate)?.(interaction)
    // The handler is dispatched without being awaited, so let it settle.
    await new Promise((r) => setImmediate(r))

    expect(calls.deferred).toEqual({ flags: MessageFlags.Ephemeral })
    expect(calls.edited).toMatchObject({ content: "queued" })
  })

  it("posts the announcement to the admin channel and the reply to the driver", async () => {
    const { client, sent, handlers } = fakeClient()
    const transport = GatewayTransport.wrapping(client)
    transport.listen(router("done", "**Misha** claimed **Misha**."), {
      adminChannelId: "555555555555555555",
    })

    const { interaction, calls } = fakeInteraction()
    await handlers.get(Events.InteractionCreate)?.(interaction)
    await new Promise((r) => setImmediate(r))

    expect(calls.edited).toMatchObject({ content: "done" })
    expect(sent[0]).toMatchObject({ channelId: "555555555555555555" })
    expect(sent[0]?.payload).toMatchObject({ allowedMentions: { parse: [] } })
  })

  it("does not let a failed announcement turn a successful claim into an error", async () => {
    const { client, handlers } = fakeClient()
    // A channel that cannot be fetched is the common misconfiguration.
    ;(client as unknown as { channels: { fetch: () => Promise<null> } }).channels.fetch =
      async () => null
    const transport = GatewayTransport.wrapping(client)
    transport.listen(router("done", "announcement"), { adminChannelId: "555555555555555555" })

    const { interaction, calls } = fakeInteraction()
    await handlers.get(Events.InteractionCreate)?.(interaction)
    await new Promise((r) => setImmediate(r))

    expect(calls.edited).toMatchObject({ content: "done" })
  })

  /** Everything the bot wrote to stdout and stderr while `run` ran. */
  const logged = async (run: () => Promise<void>): Promise<string> => {
    let out = ""
    const capture = (chunk: unknown) => {
      out += String(chunk)
      return true
    }
    const a = vi.spyOn(process.stdout, "write").mockImplementation(capture)
    const b = vi.spyOn(process.stderr, "write").mockImplementation(capture)
    try {
      await run()
      await new Promise((r) => setImmediate(r))
    } finally {
      a.mockRestore()
      b.mockRestore()
    }
    return out
  }

  it("logs each command with the start of what the driver was told", async () => {
    // Replies are ephemeral: without this an operator asked why an upload
    // didn't work had nothing to look at.
    const { client, handlers } = fakeClient()
    GatewayTransport.wrapping(client).listen(router("Refusing Misha's livery: too big.\nMore."))
    const { interaction } = fakeInteraction()

    const out = await logged(async () => {
      await handlers.get(Events.InteractionCreate)?.(interaction)
    })
    expect(out).toMatch(/\/livery claim from misha: Refusing Misha's livery: too big\.\n/)
  })

  it("logs a command it couldn't acknowledge, which the driver sees as no response", async () => {
    const { client, handlers } = fakeClient()
    GatewayTransport.wrapping(client).listen(router("never sent"))
    const { interaction } = fakeInteraction()
    ;(interaction as unknown as { deferReply: () => Promise<void> }).deferReply = async () => {
      throw new Error("Unknown interaction")
    }

    const out = await logged(async () => {
      await handlers.get(Events.InteractionCreate)?.(interaction)
    })
    expect(out).toMatch(
      /\/livery claim from misha: couldn't acknowledge it \(Unknown interaction\)/,
    )
  })
})

describe("GatewayTransport.moveVoiceMembers", () => {
  it("moves only who is in the channel, and names who it couldn't", async () => {
    const PIT_LANE = "1".repeat(18)
    const moved: string[] = []
    const state = (id: string, channelId: string, fails = false) => ({
      id,
      channelId,
      member: { displayName: id },
      setChannel: async () => {
        if (fails) throw new Error("Missing Permissions")
        moved.push(id)
      },
    })
    const states = [state("a", PIT_LANE), state("b", "elsewhere"), state("c", PIT_LANE, true)]
    const client = {
      guilds: {
        fetch: async () => ({
          channels: { fetch: async () => ({ isVoiceBased: () => true }) },
          voiceStates: { cache: new Map(states.map((s) => [s.id, s])) },
        }),
      },
    } as unknown as Client

    const result = await GatewayTransport.wrapping(client).moveVoiceMembers(
      "guild",
      PIT_LANE,
      "2".repeat(18),
    )

    expect(moved).toEqual(["a"])
    expect(result).toEqual({ moved: ["a"], failed: [{ who: "c", why: "Missing Permissions" }] })
  })

  it("refuses a source that isn't a voice channel, rather than moving nobody", async () => {
    const PIT_LANE = "1".repeat(18)
    const client = {
      guilds: {
        fetch: async () => ({
          channels: { fetch: async (id: string) => ({ isVoiceBased: () => id !== PIT_LANE }) },
          voiceStates: { cache: new Map() },
        }),
      },
    } as unknown as Client

    await expect(
      GatewayTransport.wrapping(client).moveVoiceMembers("guild", PIT_LANE, "2".repeat(18)),
    ).rejects.toThrow(/fromChannelId/)
  })
})

/**
 * The interaction exactly as discord.js builds it from the gateway, rather than
 * a fake: the bug lived in how discord.js caches, so a fake that says
 * `inCachedGuild: () => false` — as the one above does — could not see it.
 */
describe("reading the member's roles", () => {
  const GUILD = "338186558282924032"
  const ROLE = "832679478579953666"

  const interactionIn = (cacheGuild: boolean) => {
    const client = new Client({ intents: [] })
    // What READY does with the guild list, intents or not.
    if (cacheGuild) {
      ;(client.guilds as unknown as { _add: (g: unknown) => unknown })._add({
        id: GUILD,
        unavailable: true,
      })
    }
    const raw = {
      id: "1",
      application_id: "2",
      type: 2,
      token: "t",
      version: 1,
      guild_id: GUILD,
      channel_id: "902235625225330758",
      data: {
        id: "3",
        name: "livery",
        type: 1,
        options: [{ type: 1, name: "claim", options: [] }],
      },
      member: {
        user: { id: "4", username: "driver", discriminator: "0" },
        roles: [ROLE],
        joined_at: "2020-01-01T00:00:00Z",
        deaf: false,
        mute: false,
        flags: 0,
      },
      locale: "en-US",
      app_permissions: "0",
      entitlements: [],
      authorizing_integration_owners: {},
      context: 0,
    }
    const Interaction = ChatInputCommandInteraction as unknown as new (
      client: Client,
      data: unknown,
    ) => ChatInputCommandInteraction
    return { client, interaction: new Interaction(client, raw) }
  }

  it("reads them in a guild discord.js cached from READY without its roles", async () => {
    // The production case: no intents, so the guild is an unavailable stub
    // with no roles, and member.roles.cache came back as @everyone alone.
    const { client, interaction } = interactionIn(true)
    expect(interaction.inCachedGuild()).toBe(true)
    expect(toSlashCommand(interaction).roleIds).toEqual([ROLE])
    await client.destroy()
  })

  it("reads them in a guild discord.js hasn't cached at all", async () => {
    const { client, interaction } = interactionIn(false)
    expect(toSlashCommand(interaction).roleIds).toEqual([ROLE])
    await client.destroy()
  })
})

describe("GatewayTransport roles", () => {
  it("lists a role's holders across pages, bots aside", async () => {
    const member = (id: string, roles: string[], bot = false) => ({ user: { id, bot }, roles })
    const asked: string[] = []
    const pages = [
      [
        ...Array.from({ length: 998 }, (_, i) => member(`${i + 10}`, [])),
        member("1", ["r"]),
        member("2", ["r"], true),
      ],
      [member("3", ["r", "x"]), member("4", ["x"])],
    ]
    const client = {
      rest: {
        get: async (_route: string, o: { query: URLSearchParams }) => {
          asked.push(o.query.get("after") ?? "")
          return pages[asked.length - 1]
        },
      },
    }
    const t = GatewayTransport.wrapping(client as unknown as Client)
    expect(await t.roleHolders("g", "r")).toEqual(["1", "3"])
    expect(asked).toEqual(["0", "2"])
  })

  it("gives nothing to someone who has left the server, and says why anything else failed", async () => {
    const client = {
      rest: {
        put: async (route: string) => {
          throw Object.assign(
            new Error(route.includes("/gone/") ? "Unknown Member" : "Missing Permissions"),
            {
              code: route.includes("/gone/") ? 10007 : 50013,
            },
          )
        },
      },
    }
    const t = GatewayTransport.wrapping(client as unknown as Client)
    expect(await t.setRole("g", "gone", "r", true)).toBe(false)
    await expect(t.setRole("g", "here", "r", true)).rejects.toThrow(/Manage Roles/)
  })
})
