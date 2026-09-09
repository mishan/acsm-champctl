/**
 * The one module that imports discord.js.
 *
 * A gateway client, not a bare REST call, and the nightly report does not need
 * one: posting a message is a single authenticated POST. It is a gateway
 * because the next things the bot does need one — a format poll has to be
 * *closed*, and `/stats @driver` has to be *received* (plan §7) — and two
 * Discord clients in one repo is two sets of credentials, two failure modes and
 * two places to notice that a token expired. Logging in costs a couple of
 * seconds on a job that runs once a night.
 *
 * No intents are requested, and `/livery` did not change that. Intents are a
 * subscription to events; interactions arrive without one, and the roles and
 * channel a clamp needs are in the interaction payload rather than behind
 * `GuildMembers`. The alternative — taking a driver's zip off an ordinary
 * message — would have needed `MessageContent`, which is privileged and would
 * let this token read every message in every channel it can see. Asking for
 * nothing still means the token this job runs under can do nothing but talk and
 * answer.
 */

import {
  type ApplicationCommandDataResolvable,
  type ChatInputCommandInteraction,
  Client,
  Events,
  MessageFlags,
  type Interaction,
} from "discord.js"

import type { CommandDefinition } from "./commands.js"
import {
  BotError,
  type CommandRouter,
  type DiscordMessage,
  type DiscordTransport,
  type IncomingAttachment,
  type SlashCommand,
} from "./transport.js"

export interface GatewayOptions {
  token: string
  /** How long to wait for the gateway handshake. */
  readyTimeoutMs?: number
}

export class GatewayTransport implements DiscordTransport {
  readonly #client: Client

  private constructor(client: Client) {
    this.#client = client
  }

  /**
   * Wraps a client that is already connected.
   *
   * `login` is how the process gets one. This exists so a test can drive `post`
   * and the interaction handler against a fake gateway — the ephemeral flag and
   * the mention suppression are both one word in one call, and both are the
   * kind of word a refactor drops silently.
   */
  static wrapping(client: Client): GatewayTransport {
    return new GatewayTransport(client)
  }

  /**
   * Connects, and resolves once Discord says the session is up.
   *
   * The wait is not ceremony. `client.login()` resolves as soon as the token is
   * accepted, while `channels.fetch` reads through a cache the gateway is still
   * filling — so posting immediately after login finds no channel and reports
   * it as a channel that doesn't exist, intermittently, which is the worst
   * possible way to describe a race.
   */
  static async login(options: GatewayOptions): Promise<GatewayTransport> {
    const client = new Client({ intents: [] })
    const timeoutMs = options.readyTimeoutMs ?? 30_000

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new BotError(`Discord did not finish connecting within ${timeoutMs}ms`))
        }, timeoutMs)
        const onReady = () => settle()
        const onError = (e: Error) => settle(e)
        const settle = (err?: Error) => {
          clearTimeout(timer)
          // Both removed, not just the one that fired. A `once` error listener
          // left attached after a successful handshake is worse than none: it
          // swallows the first gateway error into an already-settled promise
          // and then removes itself, so the operator sees nothing and the
          // *second* error has no listener at all.
          client.off(Events.ClientReady, onReady)
          client.off(Events.Error, onError)
          if (err) {
            reject(err)
          } else {
            resolve()
          }
        }
        client.once(Events.ClientReady, onReady)
        client.once(Events.Error, onError)
        client.login(options.token).catch((e: unknown) => {
          settle(e instanceof Error ? e : new Error(String(e)))
        })
      })
    } catch (e) {
      // A half-open client keeps the process alive on its reconnect timer, so a
      // failed login would hang the CLI rather than exit non-zero.
      await client.destroy()
      throw e instanceof BotError ? e : new BotError(`Could not sign in to Discord: ${message(e)}`)
    }

    // For the life of the process, not once. discord.js reconnects on its own,
    // so a gateway error is a log line rather than an emergency — but an
    // 'error' event with no listener is re-thrown by the emitter and takes the
    // process down, which meant serve()'s finally never ran and the queue
    // database closed with its write-ahead log un-checkpointed.
    client.on(Events.Error, (e: Error) => {
      process.stderr.write(`Discord gateway error, reconnecting: ${message(e)}\n`)
    })

    return new GatewayTransport(client)
  }

  async post(message: DiscordMessage): Promise<void> {
    const channel = await this.#client.channels.fetch(message.channelId).catch(() => null)
    if (!channel) {
      throw new BotError(
        `No Discord channel ${message.channelId}. Check discord.adminChannelId in the profile, ` +
          `and that the bot has been invited to that server.`,
      )
    }
    // Not `isTextBased()`: a category, a forum and a stage are all text-based
    // channels you cannot say anything in, and `send` is absent on each.
    if (!channel.isSendable()) {
      throw new BotError(
        `Discord channel ${message.channelId} is a ${channel.type} — nothing can be posted to ` +
          `it. gridmom wants an ordinary text channel.`,
      )
    }
    // Nothing this bot posts should ever ping anybody. The claim announcement
    // is the only message on the livery path that is not ephemeral, and its
    // text carries an entry list name — which is attacker-supplied on a league
    // with open sign-ups, and `@` passes SAFE_COMPONENT. Signing up as
    // "@everyone" and running /livery claim was a guild-wide ping on demand.
    await channel.send({ content: message.content, allowedMentions: { parse: [] } })
  }

  /**
   * Publishes the command list to one guild.
   *
   * Guild-scoped, not global. Guild commands update the moment this returns;
   * global ones propagate on Discord's own schedule, which turns "I renamed an
   * option" into "why is it still the old one" for an hour. champctl is a
   * single-league tool and there is no second guild to serve.
   *
   * `set` rather than `create`: it replaces the list, so a subcommand that has
   * been removed from `commands.ts` disappears from Discord rather than
   * lingering as something a driver can run and champctl will not answer.
   */
  async registerCommands(guildId: string, commands: readonly CommandDefinition[]): Promise<void> {
    const application = this.#client.application
    if (!application) {
      throw new BotError("Discord has not told us who this bot is yet — cannot register commands.")
    }
    try {
      // Cast at the boundary, deliberately. `commands.ts` holds the plain JSON
      // Discord's API documents so it can be asserted without this library;
      // discord.js types the same JSON through its own builder unions, and the
      // one place they meet is here.
      await application.commands.set(
        commands.map((c) => ({
          name: c.name,
          description: c.description,
          dmPermission: c.dmPermission,
          options: c.options,
        })) as unknown as ApplicationCommandDataResolvable[],
        guildId,
      )
    } catch (e) {
      throw new BotError(
        `Could not register commands in guild ${guildId}: ${message(e)}. The bot needs the ` +
          `applications.commands scope — re-invite it with that ticked if it was added without.`,
      )
    }
  }

  /**
   * Answers `/livery` until something stops the process.
   *
   * **Deferred immediately.** Discord gives three seconds to acknowledge an
   * interaction, and a 20 MB attachment does not download in three seconds — so
   * the reply is deferred first and edited when there is something to say.
   * Without that, every real upload fails with "the application did not
   * respond" *and* still lands in the queue, which is the worst pair.
   *
   * **Ephemeral, always.** A refusal usually names something embarrassing in
   * somebody's zip, and an upload link is a bearer credential. Neither belongs
   * in a channel.
   */
  listen(router: CommandRouter, options: { adminChannelId?: string } = {}): void {
    this.#client.on(Events.InteractionCreate, (interaction: Interaction) => {
      if (!interaction.isChatInputCommand()) return
      void this.#dispatch(interaction, router, options.adminChannelId)
    })
  }

  async #dispatch(
    interaction: ChatInputCommandInteraction,
    router: CommandRouter,
    adminChannelId?: string,
  ): Promise<void> {
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    } catch {
      // Nothing can be said to a driver whose interaction we failed to
      // acknowledge, and running the command anyway would queue an upload they
      // were told nothing about.
      return
    }

    try {
      const reply = await router.handle(toSlashCommand(interaction))
      await interaction.editReply({ content: reply.content })

      if (reply.announcement && adminChannelId) {
        // After the driver's own reply, and separately: a failure to post the
        // announcement must not turn a successful claim into an error message.
        await this.post({ channelId: adminChannelId, content: reply.announcement }).catch(() => {})
      }
    } catch (e) {
      // The exception itself never reaches the driver — it is champctl being
      // broken rather than anything they did, and a stack trace gives them
      // nothing to act on.
      process.stderr.write(`/${interaction.commandName} failed: ${message(e)}\n`)
      await interaction
        .editReply({
          content: "Something went wrong at my end rather than with your file. Tell an admin.",
        })
        .catch(() => {})
    }
  }

  async close(): Promise<void> {
    await this.#client.destroy()
  }
}

/**
 * A `discord.js` interaction as champctl's own shape.
 *
 * The whole adapter, and the reason nothing else in `src/bot` imports
 * `discord.js`: past this function it is ids, strings and one thunk.
 */
export function toSlashCommand(interaction: ChatInputCommandInteraction): SlashCommand {
  const options: Record<string, string> = {}
  for (const option of interaction.options.data[0]?.options ?? interaction.options.data) {
    if (typeof option.value === "string") options[option.name] = option.value
  }

  const file = interaction.options.getAttachment("file")
  const attachment: IncomingAttachment | undefined = file
    ? {
        filename: file.name,
        size: file.size,
        // Fetched when asked for, not before, so the router can refuse an
        // oversized attachment without pulling it over the wire first. Discord's
        // CDN URLs now carry expiring signed parameters, so this has to happen
        // while the interaction is still in flight rather than from a queue.
        download: async () => {
          const res = await fetch(file.url)
          if (!res.ok) {
            throw new BotError(
              `Discord wouldn't give me that file back (${res.status}). Try uploading it again.`,
            )
          }
          return new Uint8Array(await res.arrayBuffer())
        },
      }
    : undefined

  // `member.roles` arrives in the payload, so no GuildMembers intent and no
  // fetch. In a DM there is no member at all, which is the case the clamp
  // reports as "a DM has no roles in it".
  const roleIds =
    interaction.inCachedGuild() && interaction.member
      ? [...interaction.member.roles.cache.keys()]
      : Array.isArray((interaction.member as { roles?: unknown } | null)?.roles)
        ? ((interaction.member as unknown as { roles: string[] }).roles ?? [])
        : []

  return {
    name: interaction.commandName,
    ...(interaction.options.getSubcommand(false)
      ? { subcommand: interaction.options.getSubcommand(false) as string }
      : {}),
    options,
    ...(attachment ? { attachment } : {}),
    userId: interaction.user.id,
    username: interaction.user.username,
    ...(interaction.guildId ? { guildId: interaction.guildId } : {}),
    channelId: interaction.channelId,
    roleIds,
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
