/**
 * Tells the admins when Server Manager keeps refusing the bot, and when it
 * lets it back in.
 *
 * A CrowdSec ban on the bot's address answers every request 403 for hours,
 * and the bot's loops each log that once a tick to a log nobody reads on race
 * night. Rate limiting is 429, and a minute of it is ordinary; ten is not.
 */

const MINUTE = 60_000

export interface AcsmAccessAlarmOptions {
  notify: (content: string) => Promise<void>
  log: (line: string) => void
  now?: () => number
  /** How long refusals must last before anyone is told. */
  afterMs?: number
}

export class AcsmAccessAlarm {
  readonly #o: AcsmAccessAlarmOptions
  readonly #now: () => number
  readonly #afterMs: number
  #refusedSince: number | undefined
  #told = false

  constructor(options: AcsmAccessAlarmOptions) {
    this.#o = options
    this.#now = options.now ?? Date.now
    this.#afterMs = options.afterMs ?? 10 * MINUTE
  }

  /** `inner`, reporting each answer's status here. */
  fetch(inner: typeof globalThis.fetch): typeof globalThis.fetch {
    return async (input, init) => {
      const res = await inner(input, init)
      this.saw(res.status)
      return res
    }
  }

  saw(status: number): void {
    const now = this.#now()
    if (status === 403 || status === 429) {
      this.#refusedSince ??= now
      if (this.#told || now - this.#refusedSince < this.#afterMs) return
      this.#told = true
      this.#tell(
        `Server Manager has refused every request from the bot for ` +
          `${Math.round((now - this.#refusedSince) / MINUTE)} minutes ` +
          `(${status === 403 ? "403 Forbidden, usually a CrowdSec ban on this address" : "429 Too Many Requests"}). ` +
          `Until it lets the bot back in, there's no quali call or standings post.`,
      )
      return
    }
    if (status >= 200 && status < 400) {
      const told = this.#told
      this.#refusedSince = undefined
      this.#told = false
      if (told) this.#tell("Server Manager is answering the bot again.")
    }
  }

  #tell(content: string): void {
    this.#o.log(`acsm: ${content}`)
    this.#o.notify(content).catch((e: unknown) => {
      this.#o.log(`acsm: couldn't tell the admins: ${e instanceof Error ? e.message : String(e)}`)
    })
  }
}
