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
import { Events, MessageFlags } from "discord.js"
import type { Client } from "discord.js"
import { describe, expect, it } from "vitest"

import { GatewayTransport } from "../src/bot/discord.js"
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
