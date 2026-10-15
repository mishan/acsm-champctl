/**
 * Posts a championship's standings once a round has been raced, rather than at
 * a time cron guesses.
 *
 * "Raced" is the event's `CompletedTime`, which ACSM stamps when the last
 * session ends: on BATL, a qualifying and two races, the stamp landed as the
 * second race finished, and not before. A session's results appear as each
 * one ends, so they would post the standings after the first race.
 *
 * Only completions it sees happen are posted. On starting, every event already
 * raced is taken as posted, so a restart doesn't repeat last week's; and a
 * stamp older than RECENT is never posted, so a championship that was
 * unreadable at start and readable later doesn't either. A round that finished
 * while the bot was down goes unposted, which `champctl-bot standings` covers.
 */

import type { AcsmReader } from "../acsm/client.js"
import { events, isZeroTime } from "../acsm/view.js"

const MINUTE = 60_000
/** How often the championship list is re-read, for one created mid-season. */
const REFRESH = 15 * MINUTE
/** A stamp older than this is a round raced before the bot was watching. */
const RECENT = 3 * 60 * MINUTE

export interface StandingsWatchOptions {
  reader: AcsmReader
  /** Posts the standings of the championship with this id. */
  post: (championshipId: string, name: string) => Promise<void>
  log: (line: string) => void
}

export class StandingsWatch {
  readonly #o: StandingsWatchOptions
  /** `${championshipId}#${eventIndex}` for every completion already dealt with. */
  readonly #seen = new Set<string>()
  /** Championships whose rounds are all raced, and long enough ago. */
  readonly #finished = new Set<string>()
  #active: string[] = []
  #refreshedAt = Number.NEGATIVE_INFINITY
  #primed = false
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
    if (t - this.#refreshedAt >= REFRESH) await this.#refresh(t)
    for (const id of this.#active) {
      let c: Awaited<ReturnType<AcsmReader["exportChampionship"]>>
      try {
        c = await this.#o.reader.exportChampionship(id)
      } catch (e) {
        this.#o.log(`standings: couldn't read championship ${id}: ${message(e)}`)
        continue
      }
      if (this.#stopped) return
      const all = events(c)
      for (let index = 0; index < all.length; index++) {
        const done = all[index]?.CompletedTime
        if (!done || isZeroTime(done)) continue
        const key = `${id}#${index}`
        if (this.#seen.has(key)) continue
        this.#seen.add(key)
        if (!this.#primed || !(t - Date.parse(done) <= RECENT)) continue
        const name = c.Name?.trim() || id
        this.#o.log(`standings: ${name} round ${index + 1} is raced; posting the standings`)
        await this.#o.post(id, name).catch((e: unknown) => {
          this.#o.log(`standings: couldn't post ${name}'s standings: ${message(e)}`)
        })
      }
    }
    this.#primed = true
  }

  /** The championships with a round still to race, or one raced recently. */
  async #refresh(t: number): Promise<void> {
    const active: string[] = []
    for (const summary of await this.#o.reader.listChampionships()) {
      const id = summary.ID
      if (!id || this.#finished.has(id)) continue
      try {
        const all = events(await this.#o.reader.exportChampionship(id))
        const raced = all.map((ev) => ev.CompletedTime).filter((d) => d && !isZeroTime(d))
        const last = Math.max(...raced.map((d) => Date.parse(d!)))
        if (all.length > 0 && raced.length === all.length && t - last > RECENT) {
          this.#finished.add(id)
          continue
        }
        active.push(id)
      } catch (e) {
        // Kept, so one failed read doesn't drop tonight's championship.
        if (this.#active.includes(id)) active.push(id)
        this.#o.log(`standings: couldn't read championship ${id}: ${message(e)}`)
      }
    }
    this.#active = active
    this.#refreshedAt = t
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
