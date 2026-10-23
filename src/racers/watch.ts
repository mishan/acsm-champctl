/**
 * Keeps the Racers role to the people racing (`discord.racers`).
 *
 * Signed up means a Steam id on the entry list of a championship that isn't
 * finished and was created after the last one that is: the season running and
 * the next. A Discord account is matched to Steam ids through its claims, so a
 * racer who claimed in any season is known when they sign up for the next one.
 *
 * Each tick:
 * - Anyone signed up is given the role, and the admins told.
 * - A season opening for sign-ups pings the role once; after that, every
 *   REMIND, the holders not on its entry list are named, until it stops
 *   taking sign-ups.
 * - Once the last season has finished and the next has opened, holders not
 *   signed up lose the role `graceDays` after whichever came later. The
 *   admins hear who a day before, and again once it's done.
 *
 * The seasons already finished when it first runs are left alone: their grace
 * ran out before anyone was told about it.
 */

import type { AcsmReader } from "../acsm/client.js"
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
  guids: Set<string>
  /** Taking sign-ups, with no round started yet. */
  open: boolean
  link?: string
}

export class RacersWatch {
  readonly #o: RacersWatchOptions
  /** Finished seasons, which don't change, so they're read once. */
  readonly #finished = new Map<string, Season>()
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
          const why = message(e)
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
      (s) => s.finishedAt === undefined && (!last || s.created > last.created),
    )
    const signedUp = new Set(next.flatMap((s) => [...s.guids]))
    const links = await this.#o.links.guidsByUser()
    const on = (user: string, guids: Set<string>) =>
      [...(links.get(user) ?? [])].some((g) => guids.has(g))
    const holders = new Set(await this.#o.role.holders())

    const given: string[] = []
    for (const user of links.keys()) {
      if (this.#stopped) return
      if (holders.has(user) || !on(user, signedUp)) continue
      if (!(await this.#o.role.add(user))) continue
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
      for (const content of mentioning(
        `Still to sign up for **${s.name}**:`,
        missing,
        `${link}\nSigned up and still named here? Run \`/racer claim\` with your name on the entry list, so I know it's you.`,
      )) {
        await this.#o.post(content, { users: missing })
      }
      marks.set(`remind:${s.id}`, now)
    }

    if (!last || marks.get(`done:${last.id}`)) return
    const opens = next.flatMap((s) => marks.get(`open:${s.id}`)?.getTime() ?? [])
    if (opens.length === 0) return
    const deadline =
      Math.max(last.finishedAt as number, Math.min(...opens)) + this.#o.graceDays * DAY
    const missing = [...holders].filter((u) => !on(u, signedUp))
    const nextNames = next.map((s) => `**${s.name}**`).join(" or ")
    if (t >= deadline - DAY && !marks.get(`warned:${last.id}`)) {
      if (missing.length) {
        await this.#tell(
          `<t:${Math.floor(deadline / 1000)}:R> I'll take <@&${this.#o.roleId}> from`,
          missing,
          `who aren't signed up for ${nextNames}.`,
        )
      }
      marks.set(`warned:${last.id}`, now)
    }
    if (t < deadline) return
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
    for (const content of mentioning(head, users, ` ${tail}`)) await this.#o.notify(content)
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
      const done = finishedAt(c)
      const form = c.SignUpForm
      const closes = form?.RegistrationClosesAt
      const link = signUpLink(c, this.#o.baseUrl)
      const s: Season = {
        id,
        name: c.Name?.trim() || id,
        created: Date.parse(c.Created ?? "") || 0,
        ...(done ? { finishedAt: done.getTime() } : {}),
        guids: rosterGuids(c),
        open:
          form?.Enabled === true &&
          !events(c).some(eventHasStarted) &&
          (isZeroTime(closes) || Date.parse(closes as string) > t),
        ...(link ? { link } : {}),
      }
      if (done) this.#finished.set(id, s)
      seasons.push(s)
    }
    return seasons
  }
}

/** `head`, the users as mentions, and `tail`, in as few messages as fit. */
function mentioning(head: string, users: readonly string[], tail: string): string[] {
  if (users.length === 0) return []
  const out: string[] = []
  let line = head
  for (const u of users) {
    const add = ` <@${u}>`
    if (line.length + add.length + tail.length > MESSAGE_LIMIT) {
      out.push(line)
      line = ""
    }
    line += add
  }
  out.push(line + tail)
  return out
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
