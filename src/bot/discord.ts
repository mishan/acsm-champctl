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
 * No intents are requested. Intents are a subscription to events, the report
 * reads nothing, and the ones that matter later — message content in
 * particular — are privileged and have to be turned on deliberately in
 * Discord's own developer portal. Asking for nothing now means the token this
 * job runs under can do nothing but talk.
 */

import { Client, Events } from "discord.js"

import { BotError, type DiscordMessage, type DiscordTransport } from "./transport.js"

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
        const settle = (err?: Error) => {
          clearTimeout(timer)
          if (err) {
            reject(err)
          } else {
            resolve()
          }
        }
        client.once(Events.ClientReady, () => settle())
        client.once(Events.Error, (e: Error) => settle(e))
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
    await channel.send(message.content)
  }

  async close(): Promise<void> {
    await this.#client.destroy()
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
