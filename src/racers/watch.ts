/**
 * Keeps the Racers role to the people racing (`discord.racers`).
 *
 * Signed up means a Steam id on the entry list of a championship that isn't
 * finished and has started or taken sign-ups: the seasons running and the
 * next. One that has done neither is a draft. A Discord account is matched to Steam ids through its claims, so a
 * racer who claimed in any season is known when they sign up for the next one.
 *
 * Each tick:
 * - Anyone signed up is given the role, and the admins told.
 * - A season opening for sign-ups pings the role once; after that, every
 *   REMIND, the holders not on its entry list are named, until it stops
 *   taking sign-ups.
 * - Once the last season has finished and the next has opened (or, if it
 *   never took sign-ups, started), holders not signed up lose the role
 *   `graceDays` after whichever came later. The
 *   admins hear who a day before, and again once it's done.
 *
 * The seasons already finished when it first runs are left alone: their grace
 * ran out before anyone was told about it.
 */

import { type AcsmReader, asMessage } from "../acsm/client.js"
import type { Championship } from "../acsm/types.js"
import { eventHasStarted, events, isZeroTime, rosterGuids } from "../acsm/view.js"
import { signUpLink } from "../bot/announce.js"
import { MESSAGE_LIMIT } from "../bot/transport.js"
import { finishedAt } from "../bot/trophies.js"
import type { RacerMarks } from "./store.js"

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
/** How often the Racers who haven't signed up are named. */
const REMIND = 3 * DAY
/**
 * A season with a round never raced, none scheduled, and nothing raced for
 * this long is over: a cancelled round would otherwise keep it running for
 * good, and its entrants signed up. Long enough for a break over the holidays.
 */
const STALE = 42 * DAY

export interface RacerRole {
  /** Who holds the role, bots aside. */
  holders(): Promise<string[]>
  /** False when they aren't in the server any more. */
  add(userId: string): Promise<boolean>
  remove(userId: string): Promise<void>
}

export interface RacersWatchOptions {
  reader: AcsmReader
  links: {
    guidsByUser(): Promise<Map<string, Set<string>>>
    fillGuids(championshipId: string, championship: Championship): Promise<void>
  }
  role: RacerRole
  roleId: string
  marks: RacerMarks
  graceDays: number
  baseUrl: string
  /** Says something in the Racers' channel, notifying only `users` and `roles`. */
  post: (content: string, ping: { users?: string[]; roles?: string[] }) => Promise<void>
  /** Tells the admins, notifying nobody. */
  notify: (content: string) => Promise<void>
  log: (line: string) => void
}

interface Season {
  id: string
  name: string
  created: number
  finishedAt?: number
  /** When its first round started, if one has. */
  startedAt?: number
  guids: Set<string>
  /** Taking sign-ups, with no round started yet. */
  open: boolean
  link?: string
}

export class RacersWatch {
  readonly #o: RacersWatchOptions
  /** Finished seasons, which don't change, so they're read once. */
  readonly #finished = new Map<string, Season>()
  /** Claimants no longer in the server, not asked about again until a restart. */
  readonly #gone = new Set<string>()
  /** The last failure the admins were told about, so each tick doesn't repeat it. */
  #told = ""
  #stopped = false

  constructor(options: RacersWatchOptions) {
    this.#o = options
  }

  /** Ticks until the returned function is called; never two at once. */
  start(everyMs = 15 * MINUTE): () => Promise<void> {
    let timer: NodeJS.Timeout | undefined
    let ticking = Promise.resolve()
    const loop = () => {
      ticking = this.tick(new Date())
        .then(() => {
          this.#told = ""
        })
        .catch(async (e: unknown) => {
          const why = asMessage(e)
          this.#o.log(`racers: ${why}`)
          if (why === this.#told) return
          this.#told = why
          await this.#o.notify(`I couldn't look after the Racers role: ${why}`).catch(() => {})
        })
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
    const seasons = await this.#read(t)
    const marks = this.#o.marks
    if (!marks.get("primed")) {
      for (const s of seasons) if (s.finishedAt !== undefined) marks.set(`done:${s.id}`, now)
      marks.set("primed", now)
    }

    const last = seasons
      .filter((s) => s.finishedAt !== undefined)
      .reduce<Season | undefined>(
        (a, s) => (a && (a.finishedAt as number) >= (s.finishedAt as number) ? a : s),
        undefined,
      )
    const next = seasons.filter(
      (s) =>
        s.finishedAt === undefined &&
        (s.startedAt !== undefined || s.open || marks.get(`open:${s.id}`) !== undefined),
    )
    const signedUp = new Set(next.flatMap((s) => [...s.guids]))
    const links = await this.#o.links.guidsByUser()
    const on = (user: string, guids: Set<string>) =>
      [...(links.get(user) ?? [])].some((g) => guids.has(g))
    const holders = new Set(await this.#o.role.holders())

    const given: string[] = []
    for (const user of links.keys()) {
      if (this.#stopped) return
      if (holders.has(user) || this.#gone.has(user) || !on(user, signedUp)) continue
      if (!(await this.#o.role.add(user))) {
        this.#gone.add(user)
        continue
      }
      holders.add(user)
      given.push(user)
    }
    if (given.length) {
      this.#o.log(`racers: gave the role to ${given.join(", ")}`)
      await this.#tell(`Gave <@&${this.#o.roleId}> to`, given, "who signed up.")
    }

    for (const s of next.filter((s) => s.open)) {
      const opened = marks.get(`open:${s.id}`)
      const link = s.link ? `\nSign up: ${s.link}` : ""
      if (!opened) {
        await this.#o.post(`<@&${this.#o.roleId}> Sign-ups are open for **${s.name}**!${link}`, {
          roles: [this.#o.roleId],
        })
        marks.set(`open:${s.id}`, now)
        marks.set(`remind:${s.id}`, now)
        continue
      }
      if (t - (marks.get(`remind:${s.id}`) ?? opened).getTime() < REMIND) continue
      const missing = [...holders].filter((u) => !on(u, s.guids))
      for (const { content, users } of mentioning(
        `Still to sign up for **${s.name}**:`,
        missing,
        `${link}\nSigned up and still named here? Run \`/racer claim\` with your name on the entry list, so I know it's you.`,
      )) {
        await this.#o.post(content, { users })
      }
      marks.set(`remind:${s.id}`, now)
    }

    if (!last || marks.get(`done:${last.id}`)) return
    // The seasons after the last, not a series running alongside it.
    const after = next.filter((s) => s.created > last.created)
    const opens = after.flatMap((s) => marks.get(`open:${s.id}`)?.getTime() ?? s.startedAt ?? [])
    if (opens.length === 0) return
    const deadline =
      Math.max(last.finishedAt as number, Math.min(...opens)) + this.#o.graceDays * DAY
    const missing = [...holders].filter((u) => !on(u, signedUp))
    const nextNames = after.map((s) => `**${s.name}**`).join(" or ")
    const warned = marks.get(`warned:${last.id}`)
    if (!warned) {
      if (t < deadline - DAY) return
      // A day's notice even when the bot was down for the day before.
      const when = Math.max(deadline, t + DAY)
      if (missing.length) {
        await this.#tell(
          `<t:${Math.floor(when / 1000)}:R> I'll take <@&${this.#o.roleId}> from`,
          missing,
          `who aren't signed up for ${nextNames}.`,
        )
      }
      marks.set(`warned:${last.id}`, now)
      return
    }
    if (t < Math.max(deadline, warned.getTime() + DAY)) return
    const taken: string[] = []
    for (const user of missing) {
      if (this.#stopped) return
      await this.#o.role.remove(user)
      taken.push(user)
    }
    marks.set(`done:${last.id}`, now)
    if (taken.length) {
      this.#o.log(`racers: took the role from ${taken.join(", ")}`)
      await this.#tell(
        `Took <@&${this.#o.roleId}> from`,
        taken,
        `who didn't sign up for ${nextNames}.`,
      )
    }
  }

  async #tell(head: string, users: string[], tail: string): Promise<void> {
    for (const { content } of mentioning(head, users, ` ${tail}`)) await this.#o.notify(content)
  }

  async #read(t: number): Promise<Season[]> {
    const seasons: Season[] = [...this.#finished.values()]
    for (const summary of await this.#o.reader.listChampionships()) {
      const id = summary.ID
      if (!id || this.#finished.has(id)) continue
      // A season that can't be read can't be checked, and acting on the rest
      // would take the role from everyone signed up for it.
      const c = await this.#o.reader.exportChampionship(id)
      await this.#o.links.fillGuids(id, c)
      const rounds = events(c)
      const raced = Math.max(
        Number.NEGATIVE_INFINITY,
        ...rounds.flatMap((ev) =>
          isZeroTime(ev.CompletedTime) ? [] : [Date.parse(ev.CompletedTime as string)],
        ),
      )
      const scheduled = rounds.some(
        (ev) =>
          !eventHasStarted(ev) &&
          !isZeroTime(ev.Scheduled) &&
          Date.parse(ev.Scheduled as string) > t,
      )
      const complete = finishedAt(c)?.getTime()
      const done =
        complete ??
        (Number.isFinite(raced) && !scheduled && t - raced > STALE ? raced + STALE : undefined)
      const started = Math.min(
        Number.POSITIVE_INFINITY,
        ...rounds.flatMap((ev) =>
          [
            ev.StartedTime,
            ev.CompletedTime,
            ...Object.values(ev.Sessions ?? {}).map((x) => x?.StartedTime),
          ].flatMap((at) => (isZeroTime(at) ? [] : [Date.parse(at as string)])),
        ),
      )
      const form = c.SignUpForm
      const closes = form?.RegistrationClosesAt
      const link = signUpLink(c, this.#o.baseUrl)
      const s: Season = {
        id,
        name: c.Name?.trim() || id,
        created: Date.parse(c.Created ?? "") || 0,
        ...(done !== undefined ? { finishedAt: done } : {}),
        ...(Number.isFinite(started) ? { startedAt: started } : {}),
        guids: rosterGuids(c),
        open:
          form?.Enabled === true &&
          !rounds.some(eventHasStarted) &&
          (isZeroTime(closes) || Date.parse(closes as string) > t),
        ...(link ? { link } : {}),
      }
      // Not one only gone quiet: a round rescheduled brings it back.
      if (complete !== undefined) this.#finished.set(id, s)
      seasons.push(s)
    }
    return seasons
  }
}

/**
 * `head`, the users as mentions, and `tail`, in as few messages as fit, each
 * with the users it mentions: Discord notifies at most 100 a message.
 */
function mentioning(
  head: string,
  users: readonly string[],
  tail: string,
): { content: string; users: string[] }[] {
  if (users.length === 0) return []
  const out: { content: string; users: string[] }[] = []
  let line = { content: head, users: [] as string[] }
  for (const u of users) {
    const add = ` <@${u}>`
    if (line.content.length + add.length + tail.length > MESSAGE_LIMIT) {
      out.push(line)
      line = { content: "", users: [] }
    }
    line.content += add
    line.users.push(u)
  }
  line.content += tail
  out.push(line)
  return out
}
