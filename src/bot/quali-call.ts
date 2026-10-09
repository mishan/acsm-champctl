/**
 * Calls the grid to Race Control: when a round's qualifying starts, everyone in
 * the Pit Lane voice channel is moved to the push-to-talk one.
 *
 * On the session starting, not on the clock. ACSM stamps
 * `Sessions.QUALIFY.StartedTime` from the UDP new-session callback, and BATL's
 * 2023 exports have it landing four to five minutes after the scheduled quali
 * start — and a restarted practice, or a server that needed a kick, pushes it
 * further. So the schedule only says when to start looking: from shortly
 * before quali, the round's export is read once a tick until the stamp appears.
 *
 * Read-only, like the rest of the bot. Public Access serves the export, and
 * moving members is a Discord permission rather than an ACSM one.
 */

import type { AcsmReader } from "../acsm/client.js"
import type { Championship } from "../acsm/types.js"
import { eventHasResults, eventSession, events, isZeroTime } from "../acsm/view.js"
import type { LeagueProfile, QualiVoiceMove } from "../profile/types.js"
import { qualiStart } from "./announce.js"
import type { VoiceMover } from "./transport.js"

const MINUTE = 60_000
/** Start reading the export this long before the scheduled quali. */
const LEAD = 15 * MINUTE
/** And give up this long after it: the round was postponed, or never ran. */
const GRACE = 120 * MINUTE
/**
 * A stamp older than this is a quali already under way — the bot restarted
 * mid-session — and dragging people out of Pit Lane twenty minutes in is worse
 * than not. Kept watching rather than marked done, so a restarted quali,
 * which ACSM stamps afresh, still moves them.
 */
const FRESH = 10 * MINUTE
/**
 * How often the calendar is re-read from every championship. Short enough that
 * a round brought forward is seen before its new quali, not after.
 */
const REFRESH = 15 * MINUTE

interface Round {
  championshipId: string
  name: string
  /** 0-based index into the events, which is the running order. */
  index: number
  quali: number
}

export interface QualiCallOptions {
  reader: AcsmReader
  mover: VoiceMover
  profile: LeagueProfile
  channels: QualiVoiceMove
  log: (line: string) => void
  /** Tells the admins. A failed move on race night is otherwise a log line nobody reads. */
  notify: (content: string) => Promise<void>
}

export class QualiCall {
  readonly #o: QualiCallOptions
  #rounds: Round[] = []
  #refreshedAt = Number.NEGATIVE_INFINITY
  /** Championships with every round raced: re-reading them would buy nothing. */
  readonly #finished = new Set<string>()
  readonly #done = new Set<string>()
  #stopped = false

  constructor(options: QualiCallOptions) {
    this.#o = options
  }

  /**
   * Ticks until the returned function is called. Never two at once: a refresh
   * walks every championship through the rate limiter and can outlast a tick.
   *
   * Stopping waits for a tick in flight, which then moves and says nothing:
   * the caller closes the Discord client next.
   */
  start(everyMs = MINUTE): () => Promise<void> {
    let timer: NodeJS.Timeout | undefined
    let ticking = Promise.resolve()
    const loop = () => {
      ticking = this.tick(new Date())
        .catch((e: unknown) => this.#o.log(`quali call: ${message(e)}`))
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

    for (const round of this.#rounds) {
      const key = `${round.championshipId}#${round.index}`
      if (this.#done.has(key) || t < round.quali - LEAD || t > round.quali + GRACE) continue

      let c: Championship
      try {
        c = await this.#o.reader.exportChampionship(round.championshipId)
      } catch (e) {
        this.#o.log(`quali call: couldn't read championship ${round.championshipId}: ${message(e)}`)
        continue
      }
      if (this.#stopped) return
      const ev = events(c)[round.index]
      const started = ev ? eventSession(ev, "Qualifying")?.StartedTime : undefined
      if (!started || isZeroTime(started)) continue
      const at = Date.parse(started)
      if (!(t - at <= FRESH)) continue

      this.#done.add(key)
      await this.#move(`${round.name} round ${round.index + 1}`)
    }
  }

  async #move(what: string): Promise<void> {
    const { fromChannelId: from, toChannelId: to } = this.#o.channels
    let result: Awaited<ReturnType<VoiceMover["move"]>>
    try {
      result = await this.#o.mover.move(from, to)
    } catch (e) {
      await this.#tell(
        `Qualifying started for ${what}, but I couldn't move anyone from <#${from}> to ` +
          `<#${to}>: ${message(e)}`,
      )
      return
    }
    this.#o.log(`quali call: ${what} — moved ${result.moved.length} to Race Control`)
    if (result.failed.length > 0) {
      const who = result.failed.map((f) => `${f.who} (${f.why})`).join(", ")
      await this.#tell(
        `Qualifying started for ${what}, but I couldn't move ${who} from <#${from}> to <#${to}>. ` +
          `The bot needs Move Members and Connect on both channels.`,
      )
    }
  }

  async #tell(content: string): Promise<void> {
    this.#o.log(`quali call: ${content}`)
    await this.#o.notify(content).catch((e: unknown) => {
      this.#o.log(`quali call: couldn't tell the admins: ${message(e)}`)
    })
  }

  /** Every round not yet raced whose quali hasn't long gone by. */
  async #refresh(t: number): Promise<void> {
    const rounds: Round[] = []
    for (const summary of await this.#o.reader.listChampionships()) {
      const id = summary.ID
      if (!id || this.#finished.has(id)) continue
      try {
        const c = await this.#o.reader.exportChampionship(id)
        const all = events(c)
        if (all.length > 0 && all.every((ev) => eventHasResults(ev))) this.#finished.add(id)
        all.forEach((ev, index) => {
          const quali = qualiStart(ev, this.#o.profile)
          if (!quali?.isValid || eventHasResults(ev) || quali.toMillis() + GRACE < t) return
          rounds.push({
            championshipId: id,
            name: c.Name?.trim() || id,
            index,
            quali: quali.toMillis(),
          })
        })
      } catch (e) {
        // Kept as they were: one failed read must not drop tonight's round.
        rounds.push(...this.#rounds.filter((r) => r.championshipId === id))
        this.#o.log(`quali call: couldn't read championship ${id}: ${message(e)}`)
      }
    }
    this.#rounds = rounds
    this.#refreshedAt = t
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
