/**
 * Posts a championship's standings once a round has been raced, rather than at
 * a time cron guesses.
 *
 * "Raced" is the event's `CompletedTime`, which ACSM stamps when the last
 * session ends: on BATL, a qualifying and two races, the stamp landed as the
 * second race finished, and not before. A session's results appear as each
 * one ends, so they would post the standings after the first race.
 *
 * Only completions it sees happen are posted. A championship's first good
 * read takes every round already raced as posted, so a restart doesn't repeat
 * last week's, even when that read only succeeds on a later tick; and a stamp
 * older than RECENT is never posted. A round that finished while the bot was
 * down goes unposted, which `champctl-bot standings` covers.
 */

import type { AcsmReader } from "../acsm/client.js"
import type { Championship } from "../acsm/types.js"
import { eventHasResults, events, isZeroTime } from "../acsm/view.js"

const MINUTE = 60_000
/** How often the championship list is re-read, for one created mid-season. */
const REFRESH = 15 * MINUTE
/** A stamp older than this is a round raced before the bot was watching. */
const RECENT = 3 * 60 * MINUTE

export interface StandingsWatchOptions {
  reader: AcsmReader
  /**
   * Posts the standings of the championship with this id. True when they went
   * out but something about them needs a person: ACSM's and champctl's
   * disagreed, or ACSM's couldn't be read.
   */
  post: (championshipId: string, name: string) => Promise<boolean>
  /** Tells the admins: a post that failed or needs checking is otherwise a log line. */
  notify: (content: string) => Promise<void>
  log: (line: string) => void
}

export class StandingsWatch {
  readonly #o: StandingsWatchOptions
  /** `${event}#${CompletedTime}` for every completion already dealt with. */
  readonly #seen = new Set<string>()
  /** Championships read at least once, whose old completions are in `#seen`. */
  readonly #primed = new Set<string>()
  /** Championships with every round raced, and long enough ago. */
  readonly #finished = new Set<string>()
  #active: string[] = []
  #refreshedAt = Number.NEGATIVE_INFINITY
  #stopped = false

  constructor(options: StandingsWatchOptions) {
    this.#o = options
  }

  /** Ticks until the returned function is called; never two at once. */
  start(everyMs = 2 * MINUTE): () => Promise<void> {
    let timer: NodeJS.Timeout | undefined
    let ticking = Promise.resolve()
    const loop = () => {
      ticking = this.tick(new Date())
        .catch((e: unknown) => this.#o.log(`standings: ${message(e)}`))
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

  async tick(now: Date): Promise<void> {
    const t = now.getTime()
    if (t - this.#refreshedAt >= REFRESH) {
      // The refresh reads every championship anyway; it checks them as it goes.
      await this.#refresh(t)
      return
    }
    for (const id of this.#active) {
      if (this.#stopped) return
      let c: Championship
      try {
        c = await this.#o.reader.exportChampionship(id)
      } catch (e) {
        this.#o.log(`standings: couldn't read championship ${id}: ${message(e)}`)
        continue
      }
      await this.#check(id, c, t)
    }
  }

  async #check(id: string, c: Championship, t: number): Promise<void> {
    const raced = events(c).flatMap((ev, index) =>
      ev.CompletedTime && !isZeroTime(ev.CompletedTime)
        ? [
            {
              key: `${ev.ID ?? index}#${ev.CompletedTime}`,
              at: Date.parse(ev.CompletedTime),
              index,
            },
          ]
        : [],
    )
    if (!this.#primed.has(id)) {
      for (const r of raced) this.#seen.add(r.key)
      this.#primed.add(id)
      return
    }
    for (const r of raced) {
      if (this.#seen.has(r.key) || !(t - r.at <= RECENT) || this.#stopped) continue
      this.#seen.add(r.key)
      const name = c.Name?.trim() || id
      this.#o.log(`standings: ${name} round ${r.index + 1} is raced; posting the standings`)
      try {
        if (await this.#o.post(id, name)) {
          await this.#tell(
            `${name}'s standings are posted, but ACSM's and champctl's own disagreed, or ACSM's ` +
              `couldn't be read. Worth a look; the log says which.`,
          )
        }
      } catch (e) {
        // Tried again next tick, for as long as the round is RECENT.
        this.#seen.delete(r.key)
        await this.#tell(
          `Round ${r.index + 1} of ${name} is raced, but I couldn't post the standings: ${message(e)}`,
        )
      }
    }
  }

  async #tell(content: string): Promise<void> {
    this.#o.log(`standings: ${content}`)
    await this.#o.notify(content).catch((e: unknown) => {
      this.#o.log(`standings: couldn't tell the admins: ${message(e)}`)
    })
  }

  /** The championships with a round still to race, or one raced recently, checked as read. */
  async #refresh(t: number): Promise<void> {
    const active: string[] = []
    for (const summary of await this.#o.reader.listChampionships()) {
      if (this.#stopped) return
      const id = summary.ID
      if (!id || this.#finished.has(id)) continue
      let c: Championship
      try {
        c = await this.#o.reader.exportChampionship(id)
      } catch (e) {
        // Kept, so one failed read doesn't drop tonight's championship.
        if (this.#active.includes(id)) active.push(id)
        this.#o.log(`standings: couldn't read championship ${id}: ${message(e)}`)
        continue
      }
      // Done the way the quali watch decides it, so a round run without a stamp,
      // or one never run, doesn't keep a championship read every tick for good.
      const all = events(c)
      const last = Math.max(
        Number.NEGATIVE_INFINITY,
        ...all.map((ev) => Date.parse(ev.CompletedTime ?? "")).filter((v) => !Number.isNaN(v)),
      )
      if (all.every((ev) => eventHasResults(ev)) && !(t - last <= RECENT)) {
        this.#finished.add(id)
        if (!this.#primed.has(id)) continue
      } else active.push(id)
      await this.#check(id, c, t)
    }
    this.#active = active
    this.#refreshedAt = t
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
