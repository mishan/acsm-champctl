/** Posts what the recorder stored for someone to know, to the bot log. */

import type { DueAlert } from "../spectator/alerts.js"

export interface RecorderAlertSource {
  due(now: Date): DueAlert[]
  told(a: DueAlert, now: Date): void
}

export interface RecorderAlertPosterOptions {
  alerts: RecorderAlertSource
  /**
   * Absent when no channel is set: nothing is marked told, so an alert still
   * open when one is set is posted then.
   */
  post?: (content: string) => Promise<void>
  log: (line: string) => void
}

const RESOLVED = "The recorder has joined the game server again and is recording."

export class RecorderAlertPoster {
  readonly #o: RecorderAlertPosterOptions
  #stopped = false

  constructor(o: RecorderAlertPosterOptions) {
    this.#o = o
  }

  /**
   * Each due alert is marked told only once its post went out; a failed one
   * is retried next tick. Only the store's failures fail the tick: a bot-log
   * channel Discord won't take is no reason for the watchdog to restart the bot.
   */
  async tick(now: Date): Promise<void> {
    const post = this.#o.post
    if (!post) return
    for (const a of this.#o.alerts.due(now)) {
      try {
        await post(a.kind === "open" ? a.message : RESOLVED)
      } catch (e) {
        this.#o.log(`couldn't post a recorder alert: ${e instanceof Error ? e.message : String(e)}`)
        continue
      }
      this.#o.alerts.told(a, now)
    }
  }

  /** Ticks until the returned function is called; never two at once. */
  start(everyMs: number, report?: (ok: boolean, error?: unknown) => void): () => Promise<void> {
    let timer: NodeJS.Timeout | undefined
    let ticking = Promise.resolve()
    const loop = () => {
      ticking = this.tick(new Date())
        .then(
          () => report?.(true),
          (e: unknown) => report?.(false, e),
        )
        .then(() => {
          if (!this.#stopped) timer = setTimeout(loop, everyMs)
        })
    }
    loop()
    return async () => {
      this.#stopped = true
      clearTimeout(timer)
      await ticking
    }
  }
}
