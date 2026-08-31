/**
 * The Discord boundary (plan §7).
 *
 * Everything above this line deals in strings. That is what lets the nightly
 * report be tested without a gateway, a token or a network — `RecordingTransport`
 * below is the entire test double — and it keeps `discord.js` to one module, the
 * same way `acsm/client.ts` is the only place that knows about HTTP.
 *
 * There is nothing here for reading *from* Discord. The bot holds no ACSM
 * credentials and never will (plan §7), so the only thing this side of champctl
 * can do to a league is say something in a channel.
 */

/** A thing to say, and where. */
export interface DiscordMessage {
  channelId: string
  content: string
}

export interface DiscordTransport {
  post(message: DiscordMessage): Promise<void>
  /** Releases the connection. Safe to call on a transport that never opened one. */
  close(): Promise<void>
}

/**
 * Discord's per-message character limit.
 *
 * It refuses an over-long message outright — HTTP 400, code 50035 — rather than
 * truncating it, so a report that grows past this posts *nothing*. That failure
 * mode is the wrong way round for a nightly job: the championships with the
 * most to say are the ones whose report goes missing, and the run still exits
 * having reported findings it never delivered. `reportMessages` splits.
 */
export const MESSAGE_LIMIT = 2000

/** Anything the bot refuses to do, with a sentence saying why. */
export class BotError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BotError"
  }
}

/**
 * Keeps what it was asked to post. Used by the tests, and by `--dry-run`.
 *
 * A dry run being the same class the tests assert against is deliberate: it
 * means the thing a person previews before wiring up a cron is produced by the
 * code path under test, rather than by a second formatter that agrees with it
 * today.
 */
export class RecordingTransport implements DiscordTransport {
  readonly posted: DiscordMessage[] = []

  async post(message: DiscordMessage): Promise<void> {
    this.posted.push(message)
  }

  async close(): Promise<void> {}
}
