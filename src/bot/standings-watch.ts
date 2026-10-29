/**
 * Posts a championship's standings once a round has been raced, rather than at
 * a time cron guesses.
 *
 * "Raced" is the event's `CompletedTime`, which ACSM stamps when the last
 * session ends: on BATL, a qualifying and two races, the stamp landed as the
 * second race finished, and not before. A session's results appear as each
 * one ends, so they would post the standings after the first race.
 *
 * A round raced in the last RECENT and not in `posted` is posted, so one that
 * finished while the bot was down or restarting goes out when it's back. An
 * older stamp never is: that is `champctl-bot standings`' job.
 */

import type { AcsmReader } from "../acsm/client.js"
import type { Championship, ChampionshipEvent } from "../acsm/types.js"
import { eventHasResults, events, isZeroTime } from "../acsm/view.js"
import type { FinishedChampionships } from "./finished.js"
import { finishedAt } from "./trophies.js"

const MINUTE = 60_000
/** How often the championship list is re-read, for one created mid-season. */
const REFRESH = 15 * MINUTE
/** A stamp older than this is left to `champctl-bot standings`. */
const RECENT = 3 * 60 * MINUTE

export interface PostedRounds {
  has(key: string): boolean
  add(key: string): void
}

export interface StandingsWatchOptions {
  reader: AcsmReader
  /**
   * Posts the standings of the championship with this id. True when they went
   * out but something about them needs a person: ACSM's and champctl's
   * disagreed, or ACSM's couldn't be read. `sent` is called as each message
   * goes out: once one has, a retry would post it twice.
   */
  post: (championshipId: string, name: string, sent: () => void) => Promise<boolean>
  /** Tells the admins: a post that failed or needs checking is otherwise a log line. */
  notify: (content: string) => Promise<void>
  log: (line: string) => void
  finished?: FinishedChampionships
  /** Rounds whose standings went out, by `roundKey`, kept across restarts. */
  posted?: PostedRounds
}

export class StandingsWatch {
  readonly #o: StandingsWatchOptions
  /** `${event}#${CompletedTime}` for every completion already dealt with. */
  readonly #seen = new Set<string>()
  /** Completions the admins were told failed to post, so a retry doesn't tell them again. */
  readonly #failed = new Set<string>()
  /** Championships with every round raced, and long enough ago. */
  readonly #finished = new Set<string>()
  #active: string[] = []
  #refreshedAt = Number.NEGATIVE_INFINITY
  #stopped = false

  constructor(options: StandingsWatchOptions) {
    this.#o = options
    for (const id of options.finished?.all().keys() ?? []) this.#finished.add(id)
  }

  /** Ticks until the returned function is called; never two at once. */
  start(everyMs = 2 * MINUTE, report?: (ok: boolean) => void): () => Promise<void> {
    let timer: NodeJS.Timeout | undefined
    let ticking = Promise.resolve()
    const loop = () => {
      ticking = this.tick(new Date())
        .then(
          () => report?.(true),
          (e: unknown) => {
            this.#o.log(`standings: ${message(e)}`)
            report?.(false)
          },
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
              key: roundKey(ev, index),
              at: Date.parse(ev.CompletedTime),
              index,
            },
          ]
        : [],
    )
    // One post covers every round newly raced: a night run as two events, or
    // a stretch of failed reads, still posts the standings once.
    const fresh = raced.filter(
      (r) => !this.#seen.has(r.key) && !this.#o.posted?.has(r.key) && t - r.at <= RECENT,
    )
    const r = fresh.at(-1)
    if (!r || this.#stopped) return
    for (const f of fresh) this.#seen.add(f.key)
    const name = c.Name?.trim() || id
    this.#o.log(`standings: ${name} round ${r.index + 1} is raced; posting the standings`)
    let sent = false
    try {
      const warned = await this.#o.post(id, name, () => {
        sent = true
      })
      for (const f of fresh) this.#o.posted?.add(f.key)
      if (warned) {
        await this.#tell(
          `${name}'s standings are posted, but ACSM's and champctl's own disagreed, or ACSM's ` +
            `couldn't be read. Worth a look; the log says which.`,
        )
      }
    } catch (e) {
      // Tried again next tick, for as long as the round is RECENT, unless part
      // of it went out already.
      if (sent) for (const f of fresh) this.#o.posted?.add(f.key)
      else for (const f of fresh) this.#seen.delete(f.key)
      if (this.#failed.has(r.key)) return
      this.#failed.add(r.key)
      await this.#tell(
        sent
          ? `Round ${r.index + 1} of ${name} is raced, but only part of the standings went out: ${message(e)}`
          : `Round ${r.index + 1} of ${name} is raced, but I couldn't post the standings: ${message(e)}`,
      )
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
      // Sessions count too: between the races, the last round has results but
      // no stamp, and the newest stamp is last week's.
      const last = finishedAt(c)?.getTime() ?? Number.NEGATIVE_INFINITY
      // A championship with no rounds yet has them all still to come.
      if (all.length > 0 && all.every((ev) => eventHasResults(ev)) && !(t - last <= RECENT)) {
        this.#finished.add(id)
        this.#o.finished?.add(id)
        continue
      } else active.push(id)
      await this.#check(id, c, t)
    }
    this.#active = active
    this.#refreshedAt = t
  }
}

/** A round's completion, as `posted` records it. */
export function roundKey(ev: ChampionshipEvent, index: number): string {
  return `${ev.ID ?? index}#${ev.CompletedTime}`
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
