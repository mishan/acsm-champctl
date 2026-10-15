/**
 * `/incident`: a driver reports a moment from a recorded session, the bot
 * opens a channel for it with everything the recording shows, and a steward
 * records what was decided.
 *
 * Plain data in and out, like the livery router: Discord stays in
 * `bot/discord.ts`, and every refusal and reply here is tested with objects.
 *
 * A driver is who `/livery claim` says they are. Their car in a recording is
 * found by the GUID the entry list gives that name, or by the name itself in
 * a recording made before the recorder kept GUIDs.
 */

import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import type { AcsmReader } from "../acsm/client.js"
import type { Championship } from "../acsm/types.js"
import { classes, normGuid, slots } from "../acsm/view.js"
import type { CommandReply, DiscordFile, SlashCommand } from "../bot/transport.js"
import type { DriverClaim } from "../liveries/claims.js"
import { type Evidence, type EvidenceRequest, gatherEvidence } from "../spectator/evidence.js"
import {
  carAt,
  indexJournal,
  type JournalCar,
  type JournalIndex,
  journalNames,
} from "./journals.js"
import type { Incident, SqliteIncidentStore } from "./store.js"

/** Where a report is discussed: a channel the stewards and both drivers can see. */
export interface IncidentChannels {
  /** A new private channel for the stewards and these Discord users; its id. */
  create(name: string, userIds: readonly string[]): Promise<string>
  /** `pings` are the users it may notify; nobody else is, whatever the text says. */
  post(
    channelId: string,
    content: string,
    files?: readonly DiscordFile[],
    pings?: readonly string[],
  ): Promise<void>
  /** Nobody but the bot can post in it any more; everyone who could see it still can. Renamed `name`. */
  lock(channelId: string, name: string): Promise<void>
}

export interface IncidentRouterOptions {
  recordings: string
  acRoot: string
  /** This deployment's /replays, for the clip's link. */
  replayUrl?: string
  /** The championship whose claims say who a driver is. */
  championshipId?: string
  reader: AcsmReader
  claims: {
    forDiscordUser(championshipId: string, discordUserId: string): Promise<DriverClaim | undefined>
    forEntrant(championshipId: string, entrantName: string): Promise<DriverClaim | undefined>
  }
  store: SqliteIncidentStore
  channels: IncidentChannels
  stewardRoleId: string
  /** The league's, for the times sessions are listed under. */
  timeZone: string
  gather?: (q: EvidenceRequest) => Promise<Evidence>
  now?: () => Date
  log?: (line: string) => void
}

export interface Choice {
  name: string
  value: string
}

/** Discord takes at most this many choices, and this much in each. */
const MAX_CHOICES = 25
const MAX_CHOICE_CHARS = 100
/** Sessions this old aren't offered: stewarding is about this week's racing. */
const OFFERED_DAYS = 14
const SESSION_TYPES: Record<number, string> = { 1: "Practice", 2: "Qualifying", 3: "Race" }
const SOMETHING_ELSE = "other"
/** Undecided reports one driver can have open at once: each is a channel and a video render. */
const MAX_OPEN = 3
const ENTRY_LIST_TTL_MS = 60_000
/** Discord's limit for one message. */
const MESSAGE_LIMIT = 2000

export class IncidentRouter {
  readonly #o: IncidentRouterOptions
  /** Drivers whose report is being filed: a double-tap shouldn't open two channels. */
  readonly #filing = new Set<string>()
  /** Channels a decision is going out in: two stewards at once shouldn't both decide. */
  readonly #deciding = new Set<string>()
  #entryList: { at: number; value: Promise<Championship | undefined> } | undefined
  /** Renders run one at a time; a race night's reports can wait their turn. */
  #rendering: Promise<unknown> = Promise.resolve()

  constructor(options: IncidentRouterOptions) {
    this.#o = options
  }

  /** Reads the newest recordings now, so the first driver to report doesn't wait on it. */
  async warm(count = 4): Promise<void> {
    for (const j of (await journalNames(this.#o.recordings)).slice(0, count)) {
      await indexJournal(this.#o.recordings, j.file).catch(() => undefined)
    }
  }

  async autocomplete(command: SlashCommand, focused: string): Promise<Choice[]> {
    const typed = (command.options[focused] ?? "").toLowerCase()
    const matching = (choices: Choice[]) =>
      choices.filter((c) => c.name.toLowerCase().includes(typed)).slice(0, MAX_CHOICES)
    if (focused === "race") return matching(await this.#sessionChoices())
    const index = await this.#index(command.options["race"])
    if (!index) return []
    if (focused === "other_driver") {
      const names = [...new Set(index.cars.map((c) => clip(c.driver)))]
      return matching(names.map((n) => ({ name: n, value: n })))
    }
    if (focused === "what") {
      const who = await this.#who(command.userId, false)
      const mine =
        who?.claim && who.championship
          ? this.#reporterCars(who.claim.entrantName, index, who.championship)
          : []
      const choices: Choice[] = []
      for (const c of index.collisions) {
        const other = otherInContact(index, c, mine)
        if (!other) continue
        choices.push({
          name: clip(
            `${clock(c.at - index.start)} · contact with ${other.driver}, ${Math.round(c.impactSpeedKmh)} km/h`,
          ),
          value: `c:${c.index}`,
        })
      }
      return [
        ...matching(choices).slice(0, MAX_CHOICES - 1),
        { name: "Something else: name the driver and the time below", value: SOMETHING_ELSE },
      ]
    }
    return []
  }

  async handle(command: SlashCommand): Promise<CommandReply> {
    if (command.subcommand === "report") return this.#report(command)
    if (command.subcommand === "decide") return this.#decide(command)
    return { content: `I don't know /incident ${command.subcommand ?? ""}.` }
  }

  async #report(command: SlashCommand): Promise<CommandReply> {
    const now = (this.#o.now ?? (() => new Date()))()
    const who = await this.#who(command.userId, true)
    if (!who) {
      return {
        content: "Incident reports aren't set up yet: no championship is pinned. Tell an admin.",
      }
    }
    const { claim, championship } = who
    if (!claim) {
      return {
        content:
          "First tell champctl which driver you are, with `/livery claim` and your name as it " +
          "appears on the entry list. Then report the incident.",
      }
    }
    const index = await this.#index(command.options["race"])
    if (!index)
      return { content: "Pick the race from the list, so I know which recording to look at." }
    // Without the entry list there's no GUID to check a car against, and a name alone proves nothing.
    if (!championship) {
      return {
        content:
          "I can't read the championship's entry list right now. Try again in a few minutes.",
      }
    }
    const mine = this.#reporterCars(claim.entrantName, index, championship)
    if (mine.length === 0) {
      return {
        content: `I can't find ${claim.entrantName} in the recording of that session. If you drove in it, tell a steward.`,
      }
    }

    const what = command.options["what"] ?? ""
    let me: JournalCar | undefined
    let other: JournalCar | undefined
    let atMs: number
    let collisionIndex: number | undefined
    if (what.startsWith("c:")) {
      const c = index.collisions[Number(what.slice(2))]
      other = c && otherInContact(index, c, mine)
      if (!c || !other) {
        return { content: "Pick what happened from the list: that one isn't a contact of yours." }
      }
      me = mine.find(
        (m) => m === carAt(index, c.carId, c.at) || m === carAt(index, c.otherCarId ?? -1, c.at),
      )
      atMs = c.at - index.start
      collisionIndex = c.index
    } else if (what === SOMETHING_ELSE) {
      const name = command.options["other_driver"] ?? ""
      if (!index.cars.some((c) => clip(c.driver) === name)) {
        return { content: "For something else, pick the other driver from the list too." }
      }
      const when = parseClock(command.options["when"] ?? "")
      if (when === undefined) {
        return {
          content:
            "For something else, say when as the time into the session, the way the replay shows it: `12:59`.",
        }
      }
      if (when > index.end - index.start) {
        return {
          content: `The recording of that session only runs to ${clock(index.end - index.start)}.`,
        }
      }
      atMs = when
      // Whoever held each slot then: a slot can change hands during a session.
      const then = index.start + atMs
      const holding = (c: JournalCar) => carAt(index, c.carId, then) === c
      me = mine.find(holding)
      if (!me) return { content: `You weren't on the server at ${clock(atMs)} in that session.` }
      other = index.cars.find((c) => clip(c.driver) === name && holding(c))
      if (!other)
        return { content: `${name} wasn't on the server at ${clock(atMs)} in that session.` }
    } else {
      return { content: "Pick what happened from the list." }
    }
    if (!me || !other || other.carId === me.carId) {
      return { content: "Pick another driver: an incident is between two cars." }
    }

    const description = (command.options["description"] ?? "").trim()
    if (!description) return { content: "Say what happened, in a sentence or two." }

    const already = this.#o.store.existing(command.userId, index.file, atMs)
    if (already) {
      return {
        content: `You've already reported that as incident #${already.number}${already.channelId ? `: <#${already.channelId}>` : ""}.`,
      }
    }
    if (this.#o.store.openCount(command.userId) >= MAX_OPEN) {
      return {
        content: `You have ${MAX_OPEN} reports the stewards haven't decided yet. Once they have, report this one.`,
      }
    }
    // Claimed with no await since the check above, so a second tap can't slip between them.
    if (this.#filing.has(command.userId)) {
      return { content: "I'm still filing your last report. Give it a minute." }
    }
    this.#filing.add(command.userId)
    try {
      return await this.#file(
        command,
        who.championshipId,
        championship,
        claim.entrantName,
        index,
        me,
        other,
        atMs,
        collisionIndex,
        description,
        now,
      )
    } finally {
      this.#filing.delete(command.userId)
    }
  }

  async #file(
    command: SlashCommand,
    championshipId: string,
    championship: Championship,
    reporter: string,
    index: JournalIndex,
    me: JournalCar,
    other: JournalCar,
    atMs: number,
    collisionIndex: number | undefined,
    description: string,
    now: Date,
  ): Promise<CommandReply> {
    const entrant = entrantFor(championship, other)
    const otherEntrant = entrant ?? other.driver
    // Someone not on the entry list has no claim, whatever they called themselves.
    const otherClaim = entrant
      ? await this.#o.claims.forEntrant(championshipId, entrant)
      : undefined

    const incident = this.#o.store.file(
      {
        reporterDiscord: command.userId,
        reporter,
        other: otherEntrant,
        ...(otherClaim ? { otherDiscord: otherClaim.discordUserId } : {}),
        journal: index.file,
        atMs,
        ...(collisionIndex === undefined ? {} : { collisionIndex }),
        description,
      },
      now,
    )
    let channelId: string
    try {
      channelId = await this.#o.channels.create(channelName(incident), [
        command.userId,
        ...(otherClaim ? [otherClaim.discordUserId] : []),
      ])
      this.#o.store.setChannel(incident.number, channelId)
    } catch (e) {
      this.#o.log?.(`incident #${incident.number}: ${message(e)}`)
      return { content: `I couldn't open a channel for the report. Tell an admin: ${message(e)}` }
    }

    // The channel's there now, and the evidence is worth posting whatever happens to this.
    try {
      const session = `${SESSION_TYPES[index.session.type] ?? index.session.name} at ${index.session.track}`
      const otherWho = otherClaim ? `<@${otherClaim.discordUserId}>` : `**${otherEntrant}**`
      await this.#o.channels.post(
        channelId,
        `**Incident #${incident.number}**: <@${command.userId}> reports ${otherWho}. ${session}, ` +
          `${clock(atMs)} into the session.\n> ${description.replace(/\n/g, "\n> ")}` +
          (otherClaim
            ? ""
            : `\n\n${otherEntrant} hasn't claimed their name with \`/livery claim\`, so they can't see this channel yet.`),
        [],
        otherClaim ? [otherClaim.discordUserId] : [],
      )
    } catch (e) {
      this.#o.log?.(`incident #${incident.number}: ${message(e)}`)
    }

    try {
      const gather = this.#o.gather ?? gatherEvidence
      const request: EvidenceRequest = {
        journal: join(this.#o.recordings, index.file),
        acRoot: this.#o.acRoot,
        // Beside the session, in its round's folder.
        outDir: join(this.#o.recordings, dirname(index.file)),
        stem: `incident-${incident.number}`,
        carIds: [me.carId, other.carId],
        atMs,
        ...(collisionIndex === undefined ? {} : { collisionIndex }),
      }
      const run = this.#rendering.then(() => gather(request))
      this.#rendering = run.catch(() => undefined)
      const evidence = await run
      await this.#postEvidence(channelId, evidence, dirname(index.file))
    } catch (e) {
      this.#o.log?.(`incident #${incident.number}: ${message(e)}`)
      await this.#o.channels.post(
        channelId,
        `I couldn't gather the recording's evidence for this one: ${message(e)}. The stewards can still look at the replay.`,
      )
    }

    return {
      content: `Filed as incident #${incident.number}: <#${channelId}>. The stewards will look at it there.`,
    }
  }

  async #postEvidence(channelId: string, e: Evidence, round: string): Promise<void> {
    for (const part of chunks([
      "**What the recording shows**",
      ...e.summary.map((s) => `- ${s}`),
    ])) {
      await this.#o.channels.post(channelId, part)
    }
    if (e.call) {
      await this.#o.channels.post(
        channelId,
        `**${e.call[0]}**\n${e.call
          .slice(1)
          .map((r) => `- ${r}`)
          .join("\n")}`,
        e.drawing
          ? [
              {
                name: "approach.png",
                data: e.drawing,
                description: "The two cars' approach, from above",
              },
            ]
          : [],
      )
    }
    const link = this.#o.replayUrl
      ? `${this.#o.replayUrl.replace(/\/+$/, "")}/${(round === "." ? [e.clip] : [round, e.clip]).map(encodeURIComponent).join("/")}`
      : `\`${e.clip}\` on the replays page`
    await this.#o.channels.post(
      channelId,
      `Overhead video below, and a replay clip to watch in the game: ${link}`,
      [
        {
          name: "overhead.mp4",
          data: await readFile(e.video),
          description: "Both cars from above",
        },
      ],
    )
  }

  async #decide(command: SlashCommand): Promise<CommandReply> {
    const incident = this.#o.store.byChannel(command.channelId)
    if (!incident) return { content: "Use `/incident decide` in the incident's own channel." }
    if (!command.roleIds.includes(this.#o.stewardRoleId)) {
      return { content: "Only the stewards can decide an incident." }
    }
    if (incident.decision !== undefined) {
      return { content: `Incident #${incident.number} was already decided: ${incident.decision}` }
    }
    const outcome = (command.options["outcome"] ?? "").trim()
    if (!outcome) return { content: "Say what was decided." }
    if (this.#deciding.has(command.channelId)) {
      return { content: "Another steward is deciding this one right now." }
    }
    this.#deciding.add(command.channelId)
    try {
      return await this.#record(command, incident, outcome)
    } finally {
      this.#deciding.delete(command.channelId)
    }
  }

  async #record(command: SlashCommand, incident: Incident, outcome: string): Promise<CommandReply> {
    const now = (this.#o.now ?? (() => new Date()))()
    const who = [incident.reporterDiscord, incident.otherDiscord]
      .filter(Boolean)
      .map((id) => `<@${id}>`)
    await this.#o.channels.post(
      command.channelId,
      `**Decision on incident #${incident.number}**, by <@${command.userId}>:\n> ${outcome.replace(/\n/g, "\n> ")}\n\n${who.join(" ")}`,
      [],
      [incident.reporterDiscord, ...(incident.otherDiscord ? [incident.otherDiscord] : [])],
    )
    await this.#o.channels.lock(command.channelId, channelName(incident, "closed"))
    // Last, so a decision that didn't reach the channel can be made again.
    this.#o.store.decide(incident.number, outcome, command.userId, now)
    return { content: `Recorded. The channel is read-only now, kept for the record.` }
  }

  async #sessionChoices(): Promise<Choice[]> {
    const oldest = Date.now() - OFFERED_DAYS * 24 * 3600_000
    const out: Choice[] = []
    for (const j of await journalNames(this.#o.recordings)) {
      if (!(j.started >= oldest)) break
      const when = new Intl.DateTimeFormat("en-US", {
        timeZone: this.#o.timeZone,
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(j.started)
      // "interlagos-1975-race": the session type last, as the recorder names it.
      const type = j.rest.slice(j.rest.lastIndexOf("-") + 1)
      const track = j.rest.slice(0, Math.max(0, j.rest.lastIndexOf("-")))
      out.push({
        name: clip(`${type.charAt(0).toUpperCase()}${type.slice(1)} · ${track} · ${when}`),
        value: j.key,
      })
      if (out.length === MAX_CHOICES) break
    }
    return out
  }

  /** A recent session's index, by its key; Discord lets a driver type any key, not just one offered. */
  async #index(key: string | undefined): Promise<JournalIndex | undefined> {
    const oldest = Date.now() - OFFERED_DAYS * 24 * 3600_000
    const j = (await journalNames(this.#o.recordings)).find((n) => n.key === key)
    if (!j || !(j.started >= oldest)) return undefined
    return indexJournal(this.#o.recordings, j.file).catch(() => undefined)
  }

  /**
   * The reporter's cars in a recording, every slot they held, through their
   * claim and the entry list's GUID. By name only where there's no GUID to go
   * on: anyone can call themselves anything in the game.
   */
  #reporterCars(entrantName: string, index: JournalIndex, c: Championship): JournalCar[] {
    const guid = guidFor(c, entrantName)
    // A car with a GUID is theirs only by it, when the entry list has theirs to
    // compare; older recordings have some cars without.
    return index.cars.filter((car) =>
      guid && car.guid ? normGuid(car.guid) === guid : sameName(car.driver, entrantName),
    )
  }

  /** The championship and who this Discord user is in it, or nothing to go on. */
  /**
   * `fresh` for a report; autocomplete takes one up to a minute old, since every
   * keystroke asks and Server Manager's rate limit is shared with the rest of the bot.
   */
  async #who(discordUserId: string, fresh: boolean) {
    const championshipId = this.#o.championshipId
    if (!championshipId) return undefined
    const claim = await this.#o.claims.forDiscordUser(championshipId, discordUserId)
    const now = Date.now()
    if (fresh || !this.#entryList || now - this.#entryList.at > ENTRY_LIST_TTL_MS) {
      const value = this.#o.reader.exportChampionship(championshipId).catch(() => undefined)
      this.#entryList = { at: now, value }
    }
    return { championshipId, claim, championship: await this.#entryList.value }
  }
}

/** The other car in a contact, when one of the two was the reporter's at the time. */
function otherInContact(
  index: JournalIndex,
  c: JournalIndex["collisions"][number],
  mine: readonly JournalCar[],
): JournalCar | undefined {
  if (c.otherCarId === undefined) return undefined
  const a = carAt(index, c.carId, c.at)
  const b = carAt(index, c.otherCarId, c.at)
  if (a && mine.includes(a)) return b
  if (b && mine.includes(b)) return a
  return undefined
}

function entrants(c: Championship) {
  return classes(c).flatMap((cls) => slots(cls.Entrants).map((s) => s.entrant))
}

function guidFor(c: Championship, name: string): string | undefined {
  const e = entrants(c).find((x) => sameName(x.Name ?? "", name))
  return e?.GUID ? normGuid(e.GUID) : undefined
}

function entrantFor(c: Championship, car: JournalCar): string | undefined {
  const all = entrants(c)
  const byGuid = car.guid
    ? all.find((e) => e.GUID && normGuid(e.GUID) === normGuid(car.guid))
    : undefined
  // By name only where one side has no GUID, as for the reporter: a guest
  // calling themselves a driver's name isn't that driver.
  const byName = all.find((e) => (!car.guid || !e.GUID) && sameName(e.Name ?? "", car.driver))
  return (byGuid ?? byName)?.Name
}

const sameName = (a: string, b: string): boolean =>
  a.normalize("NFC").trim().toLowerCase() === b.normalize("NFC").trim().toLowerCase()

function channelName(i: Incident, state: "incident" | "closed" = "incident"): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
  return `${state}-${i.number}-${slug(i.reporter)}-${slug(i.other)}`.slice(0, 100)
}

/** "12:59" into ms; undefined unless it's a time into the session. */
export function parseClock(value: string): number | undefined {
  const parts = value.trim().split(":")
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return undefined
  const n = parts.map(Number)
  if (n.some((v, i) => i > 0 && v >= 60)) return undefined
  return Math.round(n.reduce((t, v) => t * 60 + v, 0) * 1000)
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

const clip = (s: string): string =>
  s.length > MAX_CHOICE_CHARS ? `${s.slice(0, MAX_CHOICE_CHARS - 1)}…` : s

/** Lines into messages under Discord's limit, never splitting a line. */
function chunks(lines: readonly string[]): string[] {
  const out: string[] = []
  let current = ""
  for (const line of lines) {
    if (current && current.length + 1 + line.length > MESSAGE_LIMIT) {
      out.push(current)
      current = ""
    }
    current = current ? `${current}\n${line}` : line.slice(0, MESSAGE_LIMIT)
  }
  if (current) out.push(current)
  return out
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
