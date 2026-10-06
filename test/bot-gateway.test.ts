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
import { ChatInputCommandInteraction, Client, Events, MessageFlags } from "discord.js"
import { describe, expect, it } from "vitest"

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

describe("GatewayTransport.post", () => {
  it("suppresses every mention in an admin announcement", async () => {
    // The claim announcement is the only non-ephemeral message the livery path
    // produces, and its text carries an entry list name. On a league with open
    // sign-ups that name is attacker-supplied, and `@` passes SAFE_COMPONENT —
    // so signing up as "@everyone" and running /livery claim was a guild-wide
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
