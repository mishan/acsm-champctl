/**
 * Keeps the one championship info message up to date: posted once, then
 * edited whenever what it would say changes. `/championship info` refreshes it
 * on demand, and can delete the message it replaces.
 *
 * It shows the newest championship that has started racing or is taking
 * sign-ups, so next season takes over as soon as it opens. One that has done
 * neither is a draft, and isn't shown.
 */

import { createHash } from "node:crypto"

import { type AcsmReader, asMessage } from "../acsm/client.js"
import type { Championship } from "../acsm/types.js"
import { eventHasStarted, events } from "../acsm/view.js"
import type { CommandReply, CommandRouter, SlashCommand } from "../bot/transport.js"
import type { LeagueProfile } from "../profile/types.js"
import { type InfoEmbed, infoEmbed } from "./embed.js"
import type { InfoStore } from "./store.js"

const MINUTE = 60_000
/** Track names change when someone installs one, which is rare. */
const NAMES_FOR = 6 * 60 * MINUTE

export interface InfoChannel {
  post(embed: InfoEmbed): Promise<string>
  /** False when the message is gone. */
  edit(messageId: string, embed: InfoEmbed): Promise<boolean>
  exists(messageId: string): Promise<boolean>
  remove(messageId: string): Promise<void>
}

export interface ChampionshipInfoOptions {
  reader: AcsmReader
  profile: LeagueProfile
  baseUrl: string
  links: readonly { label: string; url: string }[]
  /** Where this championship's carset downloads from, if it has anything in it. */
  carsetUrl?: (id: string, c: Championship) => Promise<string | undefined>
  store: InfoStore
  channel: InfoChannel
  log: (line: string) => void
}

export class ChampionshipInfo {
  readonly #o: ChampionshipInfoOptions
  #names: { at: number; map: ReadonlyMap<string, string> } | undefined
  /** When each championship was created, which never changes, to skip reading the old ones. */
  readonly #created = new Map<string, number>()
  /** One refresh at a time, so a command and a tick can't both post. */
  #running: Promise<unknown> = Promise.resolve()

  constructor(options: ChampionshipInfoOptions) {
    this.#o = options
  }

  /** Ticks until the returned function is called; never two at once. */
  start(everyMs = 15 * MINUTE): () => Promise<void> {
    let stopped = false
    let timer: NodeJS.Timeout | undefined
    let ticking = Promise.resolve()
    const loop = () => {
      ticking = this.refresh()
        .then(() => {})
        .catch((e: unknown) => this.#o.log(`info: ${asMessage(e)}`))
        .then(() => {
          if (!stopped) timer = setTimeout(loop, everyMs)
        })
    }
    loop()
    return async () => {
      stopped = true
      clearTimeout(timer)
      await ticking
    }
  }

  /**
   * Posts or edits the message if what it says has changed, or always with
   * `force`; its id, or undefined when there's no championship to show.
   */
  refresh(o: { force?: boolean } = {}): Promise<string | undefined> {
    const run = this.#running.then(() => this.#refresh(o.force ?? false))
    this.#running = run.catch(() => {})
    return run
  }

  remove(messageId: string): Promise<void> {
    return this.#o.channel.remove(messageId)
  }

  async #refresh(force: boolean): Promise<string | undefined> {
    const shown = await this.#featured()
    if (!shown) return undefined
    const carsetUrl = await this.#o.carsetUrl?.(shown.id, shown.c)
    const embed = infoEmbed(shown.c, {
      profile: this.#o.profile,
      baseUrl: this.#o.baseUrl,
      trackNames: await this.#trackNames(),
      links: this.#o.links,
      ...(carsetUrl ? { carsetUrl } : {}),
    })
    // The picture's hash stands in for its bytes, a megabyte or more, in the store.
    const said = JSON.stringify(embed, (_k, v: unknown) =>
      v instanceof Uint8Array ? createHash("sha256").update(v).digest("hex") : v,
    )
    const id = this.#o.store.get("message")
    this.#o.store.set("championship", shown.id)
    if (id && !force && this.#o.store.get("said") === said && (await this.#o.channel.exists(id))) {
      return id
    }
    if (id && (await this.#o.channel.edit(id, embed))) {
      this.#o.store.set("said", said)
      return id
    }
    const posted = await this.#o.channel.post(embed)
    this.#o.store.set("message", posted)
    this.#o.store.set("said", said)
    this.#o.log(`info: posted ${shown.c.Name ?? shown.id} as ${posted}`)
    return posted
  }

  /**
   * Reads only the championship shown and any created since, once it knows
   * when each was created. One that can't be read is skipped, unless it might
   * be the one to show instead: then the message is left as it is.
   */
  async #featured(): Promise<{ id: string; c: Championship } | undefined> {
    const shownId = this.#o.store.get("championship")
    const floor = (shownId && this.#created.get(shownId)) || Number.NEGATIVE_INFINITY
    let best: { id: string; c: Championship; created: number } | undefined
    let unread: unknown
    for (const summary of await this.#o.reader.listChampionships()) {
      const id = summary.ID
      if (!id || (this.#created.get(id) ?? floor) < floor) continue
      let c: Championship
      try {
        c = await this.#o.reader.exportChampionship(id)
      } catch (e) {
        unread = e
        continue
      }
      const created = Date.parse(c.Created ?? "") || 0
      this.#created.set(id, created)
      if (!events(c).some(eventHasStarted) && c.SignUpForm?.Enabled !== true) continue
      if (!best || created > best.created) best = { id, c, created }
    }
    if (unread !== undefined) {
      this.#o.log(`info: couldn't read a championship: ${asMessage(unread)}`)
      if (best?.id !== shownId)
        throw new Error(`couldn't read every championship: ${asMessage(unread)}`)
    }
    return best
  }

  /** Empty, rather than failing, when ACSM won't list them: folder names will do. */
  async #trackNames(): Promise<ReadonlyMap<string, string>> {
    const now = Date.now()
    if (this.#names && now - this.#names.at < NAMES_FOR) return this.#names.map
    try {
      const { tracks } = await this.#o.reader.listContent()
      this.#names = { at: now, map: new Map(tracks.map((t) => [t.id, t.name])) }
    } catch (e) {
      this.#o.log(`info: couldn't read the track names: ${asMessage(e)}`)
      return this.#names?.map ?? new Map()
    }
    return this.#names.map
  }
}

/** `/championship info`, for the admins. */
export class InfoRouter implements CommandRouter {
  constructor(
    readonly o: { info: ChampionshipInfo; adminRoleId: string; guildId: string; channelId: string },
  ) {}

  async handle(command: SlashCommand): Promise<CommandReply> {
    if (!command.roleIds.includes(this.o.adminRoleId)) {
      return { content: "Only admins can update the championship info." }
    }
    const typed = command.options["replace"]?.trim()
    let replace: string | undefined
    if (typed) {
      const m = /^(\d{17,20})$/.exec(typed) ?? /channels\/\d+\/(\d+)\/(\d+)/.exec(typed)
      const [channelId, messageId] = m?.length === 3 ? [m[1], m[2]] : [this.o.channelId, m?.[1]]
      if (!messageId || channelId !== this.o.channelId) {
        return {
          content: `\`replace\` takes a message in <#${this.o.channelId}>: its link (Copy Message Link) or its id.`,
        }
      }
      replace = messageId
    }
    const id = await this.o.info.refresh({ force: true })
    if (!id) return { content: "There's no championship racing or taking sign-ups to show." }
    const link = `https://discord.com/channels/${this.o.guildId}/${this.o.channelId}/${id}`
    if (replace && replace !== id) {
      try {
        await this.o.info.remove(replace)
      } catch (e) {
        return { content: `Updated: ${link}\nI couldn't delete the old one: ${asMessage(e)}` }
      }
    }
    return { content: `Updated: ${link}` }
  }
}
