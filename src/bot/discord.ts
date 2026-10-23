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
 * No intents are requested unless the profile sets `discord.qualiVoiceMove`,
 * and `/livery` did not change that. Intents are a
 * subscription to events; interactions arrive without one, and the roles and
 * channel a clamp needs are in the interaction payload rather than behind
 * `GuildMembers`. The alternative — taking a driver's zip off an ordinary
 * message — would have needed `MessageContent`, which is privileged and would
 * let this token read every message in every channel it can see. Asking for
 * nothing still means the token this job runs under can do nothing but talk and
 * answer.
 *
 * Moving people out of a voice channel needs to know who is in it, and that
 * only reaches a bot as voice-state events: `GuildVoiceStates`, plus `Guilds`
 * for the guild those states hang off. Neither is privileged, and neither lets
 * the bot read a message.
 */

import {
  type ApplicationCommandDataResolvable,
  type AutocompleteInteraction,
  ChannelType,
  type ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type Interaction,
  OverwriteType,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  Routes,
  type APIGuildMember,
} from "discord.js"

import type { CommandDefinition } from "./commands.js"
import {
  BotError,
  type CommandRouter,
  type DiscordMessage,
  type DiscordTransport,
  type IncomingAttachment,
  type SlashCommand,
  type VoiceMove,
} from "./transport.js"

/** How long closing a channel may wait on Discord before the steward is told to try again. */
const LOCK_TIMEOUT_MS = 60_000

export interface GatewayOptions {
  token: string
  /** How long to wait for the gateway handshake. */
  readyTimeoutMs?: number
  /** Subscribe to voice states, which `moveVoiceMembers` reads. */
  voice?: boolean
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
    const client = new Client({
      intents: options.voice ? [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] : [],
      // discord.js's 15 s is too short for an incident's video on a slow
      // moment: one timed out four times over and the upload was lost.
      rest: { timeout: 60_000 },
    })
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
    // Where the id came from is the caller's to say. This named
    // discord.adminChannelId whatever was posting, so a wrong announce channel
    // sent the operator to check the one setting that was right.
    const source = message.source ?? "the channel id"
    if (!channel) {
      throw new BotError(
        `No Discord channel ${message.channelId}. Check ${source}, and that the bot has been ` +
          `invited to that server and can see the channel.`,
      )
    }
    // Not `isTextBased()`: a category, a forum and a stage are all text-based
    // channels you cannot say anything in, and `send` is absent on each.
    if (!channel.isSendable()) {
      throw new BotError(
        `Discord channel ${message.channelId} is a ${channel.type} — nothing can be posted to ` +
          `it. champctl needs an ordinary text channel; check ${source}.`,
      )
    }
    // Nothing this bot posts should ever ping anybody. The claim announcement
    // is the only message on the livery path that is not ephemeral, and its
    // text carries an entry list name — which is attacker-supplied on a league
    // with open sign-ups, and `@` passes SAFE_COMPONENT. Signing up as
    // "@everyone" and running /livery claim was a guild-wide ping on demand.
    // `pings` names users outright, by id: nothing in the text can widen it.
    await channel.send({
      content: message.content,
      allowedMentions: {
        parse: [],
        ...(message.pings?.length ? { users: [...message.pings] } : {}),
        ...(message.pingRoles?.length ? { roles: [...message.pingRoles] } : {}),
      },
      ...(message.files?.length
        ? {
            files: message.files.map((f) => ({
              attachment: Buffer.from(f.data),
              name: f.name,
              // Discord caps alt text at 1024 characters.
              ...(f.description ? { description: f.description.slice(0, 1024) } : {}),
            })),
          }
        : {}),
    })
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
      if (interaction.isAutocomplete()) {
        void this.#suggest(interaction, router)
        return
      }
      if (!interaction.isChatInputCommand()) return
      void this.#dispatch(interaction, router, options.adminChannelId)
    })
  }

  /** Suggestions as an option is typed. Nothing, rather than an error, if the router fails. */
  async #suggest(interaction: AutocompleteInteraction, router: CommandRouter): Promise<void> {
    const focused = interaction.options.getFocused(true).name
    const command: SlashCommand = {
      name: interaction.commandName,
      ...(interaction.options.getSubcommand(false)
        ? { subcommand: interaction.options.getSubcommand(false) as string }
        : {}),
      options: stringOptions(interaction.options.data),
      userId: interaction.user.id,
      username: interaction.user.username,
      ...(interaction.guildId ? { guildId: interaction.guildId } : {}),
      channelId: interaction.channelId,
      roleIds: memberRoleIds(interaction.member),
    }
    const choices = router.autocomplete
      ? await router.autocomplete(command, focused).catch((e: unknown) => {
          process.stderr.write(
            `autocomplete for /${command.name} ${focused} failed: ${message(e)}\n`,
          )
          return []
        })
      : []
    await interaction.respond(choices).catch(() => {})
  }

  /**
   * A text channel in a category that only a role, some members and the bot
   * can see: an incident's, for the stewards and the drivers in it.
   *
   * @everyone's role has the guild's id, so nothing needs fetching for it.
   */
  async createPrivateChannel(
    guildId: string,
    o: { parentId: string; name: string; roleIds: readonly string[]; userIds: readonly string[] },
  ): Promise<string> {
    const guild = await this.#client.guilds.fetch(guildId)
    const can = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.AttachFiles,
    ]
    const me = this.#client.user?.id
    const channel = await guild.channels
      .create({
        name: o.name,
        type: ChannelType.GuildText,
        parent: o.parentId,
        permissionOverwrites: [
          { id: guildId, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
          ...o.roleIds.map((id) => ({ id, type: OverwriteType.Role, allow: can })),
          ...o.userIds.map((id) => ({ id, type: OverwriteType.Member, allow: can })),
          // Polls are the bot's alone: drivers and voters vote, they don't start them.
          ...(me
            ? [
                {
                  id: me,
                  type: OverwriteType.Member,
                  allow: [...can, PermissionFlagsBits.SendPolls],
                },
              ]
            : []),
        ],
      })
      .catch((e: unknown) => {
        // Discord's own error codes, so the admin is pointed at the right thing.
        const code = (e as { code?: unknown }).code
        throw new BotError(
          `Couldn't create the incident's channel: ${message(e)}. ` +
            (code === 30013
              ? "Discord allows 50 channels in a category: move or delete decided incidents' channels."
              : code === 50013
                ? "The bot needs Manage Channels and Manage Roles, and on the category every permission it gives a driver."
                : "Check that discord.incidents.categoryId is a category in this server."),
        )
      })
    return channel.id
  }

  /** A poll, one answer each unless `multiselect`; its message id. */
  async postPoll(
    channelId: string,
    question: string,
    answers: readonly string[],
    hours: number,
    post: { multiselect?: boolean; content?: string; pingRoles?: readonly string[] } = {},
  ): Promise<string> {
    const channel = await this.#client.channels.fetch(channelId)
    if (!channel?.isSendable()) throw new BotError(`${channelId} isn't a channel I can post in.`)
    const sent = await channel.send({
      ...(post.content ? { content: post.content } : {}),
      poll: {
        question: { text: question },
        answers: answers.map((text) => ({ text })),
        duration: hours,
        allowMultiselect: post.multiselect ?? false,
      },
      allowedMentions: { parse: [], roles: [...(post.pingRoles ?? [])] },
    })
    return sent.id
  }

  async endPoll(channelId: string, messageId: string): Promise<void> {
    const channel = await this.#client.channels.fetch(channelId)
    if (!channel?.isTextBased()) throw new BotError(`${channelId} isn't a text channel I can see.`)
    const poll = (await channel.messages.fetch({ message: messageId, force: true })).poll
    if (poll && !poll.resultsFinalized) await poll.end()
  }

  /** A poll's votes per answer, in the order posted, fetched fresh: no intents means no vote events. */
  async pollResults(
    channelId: string,
    messageId: string,
  ): Promise<{ finalized: boolean; counts: number[] }> {
    const channel = await this.#client.channels.fetch(channelId)
    if (!channel?.isTextBased()) throw new BotError(`${channelId} isn't a text channel I can see.`)
    const poll = (await channel.messages.fetch({ message: messageId, force: true })).poll
    if (!poll) throw new BotError(`message ${messageId} in ${channelId} has no poll.`)
    const answers = [...poll.answers.values()].sort((a, b) => a.id - b.id)
    return { finalized: poll.resultsFinalized, counts: answers.map((a) => a.voteCount) }
  }

  /**
   * Nobody but the bot can post in the channel or its threads any more; who
   * could see it still can. Then renamed, and into `closedCategoryId` if there
   * is one, keeping those permissions rather than taking the category's.
   */
  async lockChannel(channelId: string, name: string, closedCategoryId?: string): Promise<void> {
    // Forced: with no intents the cached copy never hears of an overwrite a
    // steward added by hand, and that member would keep posting.
    const channel = await this.#client.channels.fetch(channelId, { force: true })
    if (!channel || channel.type !== ChannelType.GuildText) {
      throw new BotError(`${channelId} isn't a text channel I can see.`)
    }
    const me = this.#client.user?.id
    const shut =
      PermissionFlagsBits.SendMessages |
      PermissionFlagsBits.SendMessagesInThreads |
      PermissionFlagsBits.CreatePublicThreads |
      PermissionFlagsBits.CreatePrivateThreads
    const overwrites = [...channel.permissionOverwrites.cache.values()].map((o) => {
      const keep = o.id === me || o.id === channel.guildId
      return {
        id: o.id,
        type: o.type,
        allow: keep ? o.allow.bitfield : o.allow.bitfield & ~shut,
        deny: keep ? o.deny.bitfield : o.deny.bitfield | shut,
      }
    })
    // One edit, not one per overwrite and another to rename: Discord limits
    // permission changes to a couple at a time, and the bot waited out its
    // limit without a word while a steward watched "thinking…".
    let timer: NodeJS.Timeout | undefined
    const held = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new BotError(
              "Discord is holding back changes to this channel. Try again in a few minutes.",
            ),
          ),
        LOCK_TIMEOUT_MS,
      )
    })
    try {
      await Promise.race([
        channel.edit({
          name,
          permissionOverwrites: overwrites,
          ...(closedCategoryId ? { parent: closedCategoryId, lockPermissions: false } : {}),
        }),
        held,
      ])
    } catch (e) {
      if (e instanceof BotError) throw e
      throw new BotError(
        `Couldn't close the incident's channel: ${message(e)}. ` +
          ((e as { code?: unknown }).code === 30013
            ? "Discord allows 50 channels in a category: move or delete old ones."
            : "Check discord.incidents.closedCategoryId, and that the bot can see that category."),
      )
    } finally {
      clearTimeout(timer)
    }
  }

  async #dispatch(
    interaction: ChatInputCommandInteraction,
    router: CommandRouter,
    adminChannelId?: string,
  ): Promise<void> {
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    } catch (e) {
      // Nothing can be said to a driver whose interaction we failed to
      // acknowledge, and running the command anyway would queue an upload they
      // were told nothing about. Logged, though: the driver sees only Discord's
      // "the application did not respond", and this line was all an operator
      // could have had to go on — and there wasn't one.
      process.stderr.write(`${commandLine(interaction)}: couldn't acknowledge it (${message(e)})\n`)
      return
    }

    try {
      const reply = await router.handle(toSlashCommand(interaction))
      await interaction.editReply({ content: reply.content })
      // One line per command, with the start of what the driver was told. The
      // replies are ephemeral, so without this an operator asked "why didn't
      // my upload work" has nothing to look at.
      process.stdout.write(`${commandLine(interaction)}: ${firstLine(reply.content)}\n`)

      if (reply.announcement && adminChannelId) {
        // After the driver's own reply, and separately: a failure to post the
        // announcement must not turn a successful claim into an error message.
        await this.post({
          channelId: adminChannelId,
          content: reply.announcement,
          source: "discord.adminChannelId in the profile",
        }).catch(() => {})
      }
    } catch (e) {
      // The exception itself never reaches the driver — it is champctl being
      // broken rather than anything they did, and a stack trace gives them
      // nothing to act on.
      process.stderr.write(`${commandLine(interaction)} failed: ${message(e)}\n`)
      await interaction
        .editReply({
          content:
            "Something went wrong at my end rather than with anything you did. Tell an admin.",
        })
        .catch(() => {})
    }
  }

  /**
   * Who holds a role, bots aside. Read over REST, which needs the Server
   * Members intent switched on in the Developer Portal but no subscription to
   * member events.
   */
  async roleHolders(guildId: string, roleId: string): Promise<string[]> {
    const holders: string[] = []
    let after = "0"
    for (;;) {
      const page = (await this.#client.rest
        .get(Routes.guildMembers(guildId), {
          query: new URLSearchParams({ limit: "1000", after }),
        })
        .catch((e: unknown) => {
          throw new BotError(
            `Couldn't list the server's members: ${message(e)}. Turn on the Server Members ` +
              "intent under Bot in the Discord Developer Portal.",
          )
        })) as APIGuildMember[]
      for (const m of page) {
        if (m.user && !m.user.bot && m.roles.includes(roleId)) holders.push(m.user.id)
      }
      const last = page.at(-1)?.user?.id
      if (page.length < 1000 || !last) return holders
      after = last
    }
  }

  /** Gives or takes a role; false when the member has left the server. */
  async setRole(guildId: string, userId: string, roleId: string, on: boolean): Promise<boolean> {
    const route = Routes.guildMemberRole(guildId, userId, roleId)
    try {
      await (on ? this.#client.rest.put(route) : this.#client.rest.delete(route))
      return true
    } catch (e) {
      if ((e as { code?: unknown }).code === RESTJSONErrorCodes.UnknownMember) return false
      throw new BotError(
        `Couldn't ${on ? "give" : "take"} <@&${roleId}> ${on ? "to" : "from"} <@${userId}>: ` +
          `${message(e)}. The bot needs Manage Roles, and its own role above that one.`,
      )
    }
  }

  /**
   * Moves everyone in one voice channel of a guild to another.
   *
   * Off the guild's voice states rather than `channel.members`, which also
   * needs each member cached — and a member Discord never sent is someone
   * silently left behind in Pit Lane.
   */
  async moveVoiceMembers(guildId: string, fromId: string, toId: string): Promise<VoiceMove> {
    const guild = await this.#client.guilds.fetch(guildId)
    const voiceChannel = async (id: string, key: string) => {
      const channel = await guild.channels.fetch(id).catch(() => null)
      if (!channel?.isVoiceBased()) {
        throw new BotError(
          `${id} isn't a voice channel in this server. Check discord.qualiVoiceMove.${key}.`,
        )
      }
      return channel
    }
    // The source too: a wrong one is an empty channel, and "moved 0" every week.
    await voiceChannel(fromId, "fromChannelId")
    const to = await voiceChannel(toId, "toChannelId")
    const result: VoiceMove = { moved: [], failed: [] }
    for (const state of guild.voiceStates.cache.values()) {
      if (state.channelId !== fromId) continue
      const who = state.member?.displayName ?? state.id
      try {
        await state.setChannel(to, "Qualifying has started")
        result.moved.push(who)
      } catch (e) {
        result.failed.push({ who, why: message(e) })
      }
    }
    return result
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
  const options = stringOptions(interaction.options.data)

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

  const roleIds = memberRoleIds(interaction.member)

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

/** A command's string options by name, from inside its subcommand if it has one. */
function stringOptions(
  data: readonly {
    name: string
    value?: unknown
    options?: readonly { name: string; value?: unknown }[]
  }[],
): Record<string, string> {
  const options: Record<string, string> = {}
  for (const option of data[0]?.options ?? data) {
    if (typeof option.value === "string") options[option.name] = option.value
    // Numbers and yes-or-no, such as how many cars a season vote picks.
    else if (typeof option.value === "number" || typeof option.value === "boolean")
      options[option.name] = String(option.value)
  }
  return options
}

/**
 * The member's role ids, as the interaction payload carried them.
 *
 * Never `member.roles.cache`. With no intents the bot never receives a guild's
 * roles, but discord.js still caches every guild from READY as an unavailable
 * stub — so the interaction counts as "in a cached guild", the member is built
 * as a GuildMember, and its role cache is the payload's ids filtered through
 * that empty role list. Every member came out holding @everyone and nothing
 * else, and a role clamp turned everyone away. The ids themselves survive as
 * `_roles` on the GuildMember, and as `roles` on the raw member discord.js
 * hands over for a guild it hasn't cached at all.
 *
 * Neither shape recognised means no roles, which a role clamp refuses. In a DM
 * there is no member at all — the case the clamp reports as "a DM has no roles
 * in it".
 */
function memberRoleIds(member: unknown): string[] {
  if (member === null || typeof member !== "object") return []
  const m = member as { _roles?: unknown; roles?: unknown }
  const ids = Array.isArray(m._roles) ? m._roles : Array.isArray(m.roles) ? m.roles : []
  return ids.filter((id): id is string => typeof id === "string")
}

/** "/livery upload from someone", for the log. */
function commandLine(interaction: ChatInputCommandInteraction): string {
  const sub = interaction.options.getSubcommand(false)
  return `${new Date().toISOString()} /${interaction.commandName}${sub ? ` ${sub}` : ""} from ${interaction.user.username}`
}

/** The first line of a reply, short enough for a log line. */
function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? ""
  return line.length > 160 ? `${line.slice(0, 159)}…` : line
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
