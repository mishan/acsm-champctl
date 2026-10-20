/**
 * `/season`: the Racers choose next season's cars, then its tracks. Each is
 * nominated, then voted on with a ballot under GridMom's post, where a Racer
 * ticks every nominee they'd race. The top few go through; a tie at the cut is
 * left to the admins.
 *
 * Tallies stay hidden until a vote closes, so early leaders don't sway it.
 */

import type { InstalledContent, InstalledItem } from "../acsm/types.js"
import type { CommandReply, MenuSelection, SlashCommand } from "../bot/transport.js"
import type { Kind, Nomination, SeasonVote, SqliteSeasonStore } from "./store.js"

/** What each Racer may nominate in a phase. */
export const NOMINATIONS_EACH = 2
/** Discord's limit on a select menu's options, and so on a ballot. */
export const MAX_NOMINEES = 25

export interface BallotOption {
  label: string
  value: string
  description?: string
}

/** The season channel: announcements, nominations, ballots and results. */
export interface SeasonChannel {
  /** `pingRoles` are the roles it may notify; nobody else is. */
  post(content: string, pingRoles?: readonly string[]): Promise<void>
  /** A post with a ballot under it, ticking any number of `options`; its message id. */
  postBallot(
    content: string,
    customId: string,
    options: readonly BallotOption[],
    pingRoles?: readonly string[],
  ): Promise<string>
  /** Takes the ballot off its post, once its vote has closed. */
  closeBallot(messageId: string): Promise<void>
}

export interface SeasonRouterOptions {
  store: SqliteSeasonStore
  /** Who may start a season vote and end a phase early: Track Staff. */
  adminRoleId: string
  /** Who nominates and votes: the Racers. */
  voterRoleId: string
  channel: SeasonChannel
  /** What's installed on the server, to nominate from. */
  content: () => Promise<InstalledContent>
  now?: () => Date
  log?: (line: string) => void
}

type Choice = { name: string; value: string }

const NOUN: Record<Kind, { one: string; many: string }> = {
  cars: { one: "car", many: "cars" },
  tracks: { one: "track", many: "tracks" },
}

/** A Discord timestamp: each reader sees it in their own time zone. */
const when = (d: Date) =>
  `<t:${Math.floor(d.getTime() / 1000)}:f> (<t:${Math.floor(d.getTime() / 1000)}:R>)`

const clip = (s: string, n = 100) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export class SeasonRouter {
  readonly #o: SeasonRouterOptions
  #content: { at: number; value: Promise<InstalledContent> } | undefined
  #advancing = false

  constructor(options: SeasonRouterOptions) {
    this.#o = options
  }

  #now(): Date {
    return (this.#o.now ?? (() => new Date()))()
  }

  async handle(command: SlashCommand): Promise<CommandReply> {
    switch (command.subcommand) {
      case "start":
        return this.#start(command)
      case "nominate":
        return this.#nominate(command)
      case "withdraw":
        return this.#withdraw(command)
      case "status":
        return this.#status()
      case "close":
        return this.#close(command)
      default:
        return { content: `I don't know /season ${command.subcommand ?? ""}.` }
    }
  }

  async autocomplete(command: SlashCommand, focused: string): Promise<Choice[]> {
    if (focused !== "item") return []
    const v = this.#o.store.current()
    const kind = v && nominating(v)
    if (!v || !kind) return []
    const typed = (command.options["item"] ?? "").toLowerCase()
    const matches = (c: Choice) =>
      c.name.toLowerCase().includes(typed) || c.value.toLowerCase().includes(typed)
    const nominated = this.#o.store.nominations(v.id, kind)
    if (command.subcommand === "withdraw") {
      return nominated
        .filter((n) => n.nominatedBy === command.userId)
        .map((n) => ({ name: clip(n.label), value: n.item }))
        .filter(matches)
        .slice(0, 25)
    }
    const taken = new Set(nominated.map((n) => n.item))
    return (await this.#installed(kind))
      .filter((i) => !taken.has(i.id))
      .map((i) => ({ name: clip(i.name), value: i.id }))
      .filter(matches)
      .slice(0, 25)
  }

  /** A Racer's picks on a ballot, replacing any earlier ones. */
  async select(s: MenuSelection): Promise<CommandReply> {
    const [, id, kind] = s.customId.split(":")
    const v = this.#o.store.current()
    if (!v || String(v.id) !== id || v.phase !== `${kind}-vote`) {
      return { content: "This vote has closed." }
    }
    if (!s.roleIds.includes(this.#o.voterRoleId)) {
      return { content: `Only <@&${this.#o.voterRoleId}> vote on next season.` }
    }
    const k = kind as Kind
    const nominees = this.#o.store.nominations(v.id, k)
    const picks = nominees.filter((n) => s.values.includes(n.item))
    this.#o.store.vote(
      v.id,
      k,
      s.userId,
      picks.map((n) => n.item),
      this.#now(),
    )
    return {
      content:
        (picks.length
          ? `Your ballot: ${picks.map((n) => `**${n.label}**`).join(", ")}.`
          : `Your ballot is empty: you're backing none of the ${NOUN[k].many}.`) +
        ` You can change it until the vote closes, ${when(v.phaseEndsAt)}.`,
    }
  }

  /**
   * Moves a season vote on once its phase is over: a nomination phase to its
   * ballot, a vote to its result and the next phase. Run every few minutes.
   */
  async advance(): Promise<void> {
    if (this.#advancing) return
    this.#advancing = true
    try {
      const v = this.#o.store.current()
      if (!v || v.phaseEndsAt > this.#now()) return
      const kind: Kind = v.phase.startsWith("cars") ? "cars" : "tracks"
      if (v.phase.endsWith("-nominate")) await this.#openVote(v, kind)
      else await this.#count(v, kind)
    } catch (e) {
      this.#o.log?.(`season vote: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      this.#advancing = false
    }
  }

  async #start(command: SlashCommand): Promise<CommandReply> {
    if (!command.roleIds.includes(this.#o.adminRoleId)) {
      return { content: `Only <@&${this.#o.adminRoleId}> can start the season vote.` }
    }
    if (this.#o.store.current()) {
      return { content: "A season vote is already running: `/season status` shows where it is." }
    }
    const n = (key: string) => Number(command.options[key])
    const v = this.#o.store.start(
      {
        startedBy: command.userId,
        cars: n("cars"),
        tracks: n("tracks"),
        nominateDays: n("nominate_days"),
        voteDays: n("vote_days"),
      },
      this.#now(),
    )
    await this.#announceNominations(v, "cars")
    return { content: `Started. Car nominations close ${when(v.phaseEndsAt)}.` }
  }

  async #announceNominations(v: SeasonVote, kind: Kind): Promise<void> {
    const { one, many } = NOUN[kind]
    await this.#o.channel.post(
      `**Next season: nominate the ${many}.** <@&${this.#o.voterRoleId}>, nominate up to ` +
        `${NOMINATIONS_EACH} ${many} with \`/season nominate\` until ${when(v.phaseEndsAt)}. ` +
        `Pick one installed on the server, or name a new ${one} and give a link to the mod. ` +
        `Then everyone votes, and the top ${kind === "cars" ? v.cars : v.tracks} go through.`,
      [this.#o.voterRoleId],
    )
  }

  async #nominate(command: SlashCommand): Promise<CommandReply> {
    if (!command.roleIds.includes(this.#o.voterRoleId)) {
      return { content: `Only <@&${this.#o.voterRoleId}> nominate for next season.` }
    }
    const v = this.#o.store.current()
    const kind = v && nominating(v)
    if (!v || !kind) return { content: "Nominations aren't open right now." }
    const { one, many } = NOUN[kind]
    const nominated = this.#o.store.nominations(v.id, kind)
    const mine = nominated.filter((n) => n.nominatedBy === command.userId)
    if (mine.length >= NOMINATIONS_EACH) {
      return {
        content: `You've nominated ${NOMINATIONS_EACH} ${many} already: ${mine.map((n) => `**${n.label}**`).join(" and ")}. \`/season withdraw\` one to nominate another.`,
      }
    }
    if (nominated.length >= MAX_NOMINEES) {
      return {
        content: `The ballot is full: a vote can hold ${MAX_NOMINEES} ${many}, and that many are nominated.`,
      }
    }

    const typed = (command.options["item"] ?? "").trim()
    const link = command.options["link"]?.trim()
    const installed = await this.#installed(kind)
    const found =
      installed.find((i) => i.id === typed) ??
      installed.find((i) => i.name.toLowerCase() === typed.toLowerCase())
    let nomination: Nomination
    if (found) {
      nomination = { item: found.id, label: found.name, nominatedBy: command.userId }
    } else if (!link) {
      return {
        content: `**${typed}** isn't installed on the server. Pick a ${one} from the list, or add a \`link\` to the mod to nominate a new one.`,
      }
    } else if (!/^https?:\/\/\S+$/.test(link)) {
      return { content: "The link needs to be a web address, starting with https://." }
    } else {
      nomination = {
        item: `mod:${typed.toLowerCase().replace(/\s+/g, " ")}`,
        label: clip(typed, 80),
        link,
        nominatedBy: command.userId,
      }
    }
    if (!this.#o.store.nominate(v.id, kind, nomination, this.#now())) {
      const by = nominated.find((n) => n.item === nomination.item)?.nominatedBy
      return {
        content: `**${nomination.label}** is nominated already${by ? `, by <@${by}>` : ""}.`,
      }
    }
    await this.#o.channel.post(
      `<@${command.userId}> nominated **${nomination.label}**${nomination.link ? `: <${nomination.link}>` : ""}`,
    )
    const left = NOMINATIONS_EACH - mine.length - 1
    return {
      content: `Nominated **${nomination.label}**. ${left ? `You can nominate ${left} more.` : `That's your ${NOMINATIONS_EACH}.`}`,
    }
  }

  async #withdraw(command: SlashCommand): Promise<CommandReply> {
    const v = this.#o.store.current()
    const kind = v && nominating(v)
    if (!v || !kind) return { content: "Nominations aren't open right now." }
    const item = command.options["item"] ?? ""
    const n = this.#o.store.nominations(v.id, kind).find((x) => x.item === item)
    if (!n || !this.#o.store.withdraw(v.id, kind, item, command.userId)) {
      return { content: "That isn't one of your nominations: pick it from the list." }
    }
    await this.#o.channel.post(`<@${command.userId}> withdrew **${n.label}**.`)
    return { content: `Withdrawn: **${n.label}**.` }
  }

  #status(): CommandReply {
    const v = this.#o.store.current()
    if (!v) return { content: "No season vote is running." }
    const kind: Kind = v.phase.startsWith("cars") ? "cars" : "tracks"
    const nominees = this.#o.store.nominations(v.id, kind)
    const what = v.phase.endsWith("-nominate")
      ? `${kind === "cars" ? "Car" : "Track"} nominations`
      : `The ${NOUN[kind].one} vote`
    const list = nominees.map((n) => `- **${n.label}**, by <@${n.nominatedBy}>`).join("\n")
    return {
      content: clip(
        `${what} close ${when(v.phaseEndsAt)}. ${nominees.length} nominated${list ? `:\n${list}` : "."}`,
        2000,
      ),
    }
  }

  async #close(command: SlashCommand): Promise<CommandReply> {
    if (!command.roleIds.includes(this.#o.adminRoleId)) {
      return { content: `Only <@&${this.#o.adminRoleId}> can end a phase early.` }
    }
    const v = this.#o.store.current()
    if (!v) return { content: "No season vote is running." }
    this.#o.store.setPhase(v.id, v.phase, this.#now(), v.ballotMessageId)
    await this.advance()
    return { content: "Closed. The season channel has what comes next." }
  }

  async #openVote(v: SeasonVote, kind: Kind): Promise<void> {
    const nominees = this.#o.store.nominations(v.id, kind)
    const places = kind === "cars" ? v.cars : v.tracks
    if (nominees.length <= places) {
      // Nothing to choose between: straight to the result.
      return this.#count(v, kind)
    }
    const { one, many } = NOUN[kind]
    const ends = new Date(this.#now().getTime() + v.voteDays * 86_400_000)
    const messageId = await this.#o.channel.postBallot(
      `**Vote for next season's ${many}.** <@&${this.#o.voterRoleId}>, tick every ${one} ` +
        `you'd race in the menu below; the top ${places} go through. Voting closes ` +
        `${when(ends)}, and you can change your picks until then. The count stays hidden till it closes.\n\n` +
        nominees
          .map((n) => `- **${n.label}**${n.link ? " (a mod, linked where it was nominated)" : ""}`)
          .join("\n"),
      `season:${v.id}:${kind}`,
      nominees.map((n) => ({
        label: clip(n.label),
        value: n.item,
        ...(n.link ? { description: "A mod, not on the server yet" } : {}),
      })),
      [this.#o.voterRoleId],
    )
    this.#o.store.setPhase(v.id, `${kind}-vote`, ends, messageId)
  }

  /** The result of a phase's vote, posted, and the next phase begun. */
  async #count(v: SeasonVote, kind: Kind): Promise<void> {
    const r = this.outcome(v, kind)
    // Moved on before anything's posted: a post that fails mustn't have the
    // result announced again every few minutes.
    const next = kind === "cars" ? "tracks-nominate" : "done"
    const ends = new Date(this.#now().getTime() + v.nominateDays * 86_400_000)
    this.#o.store.setPhase(v.id, next, ends)
    if (v.ballotMessageId) {
      await this.#o.channel
        .closeBallot(v.ballotMessageId)
        .catch((e: unknown) => this.#o.log?.(`season vote: closing the ballot: ${String(e)}`))
    }
    const { many } = NOUN[kind]
    const lines = [`**Next season's ${many}.** <@&${this.#o.voterRoleId}>`]
    if (r.counts.length === 0) {
      lines.push(`Nobody nominated any ${many}.`)
    } else if (!r.voted) {
      lines.push(
        `${r.counts.length} nominated for ${r.places} ${r.places === 1 ? "place" : "places"}, so no vote was needed.`,
      )
    } else {
      lines.push(`${r.voters} Racers voted:`)
      lines.push(...r.counts.map((c, i) => `${i + 1}. **${c.label}**: ${c.votes}`))
    }
    if (r.winners.length)
      lines.push(`Going through: ${r.winners.map((w) => `**${w}**`).join(", ")}.`)
    if (r.tied.length) {
      lines.push(
        `Tied for the last ${r.places - r.winners.length === 1 ? "place" : `${r.places - r.winners.length} places`}: ` +
          `${r.tied.map((w) => `**${w}**`).join(", ")}. <@&${this.#o.adminRoleId}> will choose.`,
      )
    }
    await this.#o.channel.post(clip(lines.join("\n"), 2000), [this.#o.voterRoleId])
    const after = { ...v, phase: next, phaseEndsAt: ends } as SeasonVote
    if (next === "tracks-nominate") await this.#announceNominations(after, "tracks")
  }

  /** Who goes through on a phase's vote: everyone nominated, when there are no more than the places. */
  outcome(
    v: SeasonVote,
    kind: Kind,
  ): {
    counts: { label: string; votes: number }[]
    voted: boolean
    voters: number
    places: number
    winners: string[]
    tied: string[]
  } {
    const places = kind === "cars" ? v.cars : v.tracks
    const nominees = this.#o.store.nominations(v.id, kind)
    const ballots = this.#o.store.ballots(v.id, kind)
    const counts = nominees
      .map((n) => ({ label: n.label, votes: ballots.filter((b) => b.includes(n.item)).length }))
      // Stable: equal counts keep the order they were nominated in.
      .sort((a, b) => b.votes - a.votes)
    if (nominees.length <= places) {
      return {
        counts,
        voted: false,
        voters: 0,
        places,
        winners: nominees.map((n) => n.label),
        tied: [],
      }
    }
    const cut = counts[places - 1]!.votes
    const tiedAtCut = counts[places]!.votes === cut
    return {
      counts,
      voted: true,
      voters: ballots.filter((b) => b.length > 0).length,
      places,
      winners: counts
        .filter((c, i) => (tiedAtCut ? c.votes > cut : i < places))
        .map((c) => c.label),
      tied: tiedAtCut ? counts.filter((c) => c.votes === cut).map((c) => c.label) : [],
    }
  }

  /** Installed cars or tracks, read once every ten minutes: the listing is ACSM's slowest read. */
  async #installed(kind: Kind): Promise<InstalledItem[]> {
    const now = Date.now()
    if (!this.#content || now - this.#content.at > 10 * 60_000) {
      this.#content = { at: now, value: this.#o.content() }
    }
    const c = await this.#content.value.catch(() => {
      this.#content = undefined
      return { cars: [], tracks: [] }
    })
    return c[kind]
  }
}

function nominating(v: SeasonVote): Kind | undefined {
  return v.phase === "cars-nominate" ? "cars" : v.phase === "tracks-nominate" ? "tracks" : undefined
}
