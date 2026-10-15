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
import { join } from "node:path"

import type { AcsmReader } from "../acsm/client.js"
import type { Championship } from "../acsm/types.js"
import { classes, normGuid, slots } from "../acsm/view.js"
import type { CommandReply, DiscordFile, SlashCommand } from "../bot/transport.js"
import type { DriverClaim } from "../liveries/claims.js"
import { type Evidence, type EvidenceRequest, gatherEvidence } from "../spectator/evidence.js"
import {
  indexJournal,
  type JournalCar,
  type JournalIndex,
  journalFiles,
  journalPath,
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
  /** Nobody but the bot can post in it any more; everyone who could see it still can. */
  lock(channelId: string): Promise<void>
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
/** Discord's limit for one message. */
const MESSAGE_LIMIT = 2000

export class IncidentRouter {
  readonly #o: IncidentRouterOptions

  constructor(options: IncidentRouterOptions) {
    this.#o = options
  }

  /** Reads the newest recordings now, so the first driver to report doesn't wait on it. */
  async warm(count = 4): Promise<void> {
    for (const f of (await journalFiles(this.#o.recordings)).slice(0, count)) {
      await indexJournal(join(this.#o.recordings, f)).catch(() => undefined)
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
      return matching(index.cars.map((c) => ({ name: clip(c.driver), value: String(c.carId) })))
    }
    if (focused === "what") {
      const me = await this.#reporterCar(command.userId, index)
      const mine = me
        ? index.collisions.filter(
            (c) =>
              c.otherCarId !== undefined && (c.carId === me.carId || c.otherCarId === me.carId),
          )
        : []
      const choices = mine.map((c) => {
        const other = c.carId === me!.carId ? c.drivers[1] : c.drivers[0]
        return {
          name: clip(
            `${clock(c.at - index.start)} · contact with ${other}, ${Math.round(c.impactSpeedKmh)} km/h`,
          ),
          value: `c:${c.index}`,
        }
      })
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
    const championshipId = this.#o.championshipId
    if (!championshipId) {
      return {
        content: "Incident reports aren't set up yet: no championship is pinned. Tell an admin.",
      }
    }
    const claim = await this.#o.claims.forDiscordUser(championshipId, command.userId)
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
    const me = await this.#reporterCar(command.userId, index)
    if (!me) {
      return {
        content: `I can't find ${claim.entrantName} in the recording of that session. If you drove in it, tell a steward.`,
      }
    }

    const what = command.options["what"] ?? ""
    let other: JournalCar | undefined
    let atMs: number
    let collisionIndex: number | undefined
    if (what.startsWith("c:")) {
      const c = index.collisions[Number(what.slice(2))]
      if (!c || c.otherCarId === undefined || (c.carId !== me.carId && c.otherCarId !== me.carId)) {
        return { content: "Pick what happened from the list: that one isn't a contact of yours." }
      }
      other = index.cars.find((x) => x.carId === (c.carId === me.carId ? c.otherCarId : c.carId))
      atMs = c.at - index.start
      collisionIndex = c.index
    } else if (what === SOMETHING_ELSE) {
      other = index.cars.find((x) => String(x.carId) === command.options["other_driver"])
      if (!other) return { content: "For something else, pick the other driver from the list too." }
      const when = parseClock(command.options["when"] ?? "")
      if (when === undefined) {
        return {
          content:
            "For something else, say when as the time into the session, the way the replay shows it: `12:59`.",
        }
      }
      atMs = when
    } else {
      return { content: "Pick what happened from the list." }
    }
    if (!other || other.carId === me.carId) {
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

    const championship = await this.#o.reader
      .exportChampionship(championshipId)
      .catch(() => undefined)
    const otherEntrant = (championship && entrantFor(championship, other)) ?? other.driver
    const otherClaim = championship
      ? await this.#o.claims.forEntrant(championshipId, otherEntrant)
      : undefined

    const incident = this.#o.store.file(
      {
        reporterDiscord: command.userId,
        reporter: claim.entrantName,
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
      return { content: `I couldn't open a channel for the report. Tell an admin: ${message(e)}` }
    }

    try {
      const evidence = await (this.#o.gather ?? gatherEvidence)({
        journal: join(this.#o.recordings, index.file),
        acRoot: this.#o.acRoot,
        outDir: this.#o.recordings,
        stem: `incident-${incident.number}`,
        carIds: [me.carId, other.carId],
        atMs,
        ...(collisionIndex === undefined ? {} : { collisionIndex }),
      })
      await this.#postEvidence(channelId, evidence)
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

  async #postEvidence(channelId: string, e: Evidence): Promise<void> {
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
      ? `${this.#o.replayUrl.replace(/\/+$/, "")}/${encodeURIComponent(e.clip)}`
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
    const now = (this.#o.now ?? (() => new Date()))()
    this.#o.store.decide(incident.number, outcome, command.userId, now)
    const who = [incident.reporterDiscord, incident.otherDiscord]
      .filter(Boolean)
      .map((id) => `<@${id}>`)
    await this.#o.channels.post(
      command.channelId,
      `**Decision on incident #${incident.number}**, by <@${command.userId}>:\n> ${outcome.replace(/\n/g, "\n> ")}\n\n${who.join(" ")}`,
      [],
      [incident.reporterDiscord, ...(incident.otherDiscord ? [incident.otherDiscord] : [])],
    )
    await this.#o.channels.lock(command.channelId)
    return { content: `Recorded. The channel is read-only now, kept for the record.` }
  }

  async #sessionChoices(): Promise<Choice[]> {
    const oldest = Date.now() - OFFERED_DAYS * 24 * 3600_000
    const out: Choice[] = []
    for (const f of await journalFiles(this.#o.recordings)) {
      const started = startedFrom(f)
      if (!(started >= oldest)) continue
      const index = await indexJournal(join(this.#o.recordings, f)).catch(() => undefined)
      // A session nobody drove in has nothing to report.
      if (!index || index.cars.length === 0) continue
      const when = new Intl.DateTimeFormat("en-US", {
        timeZone: this.#o.timeZone,
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(started)
      out.push({
        name: clip(
          `${SESSION_TYPES[index.session.type] ?? index.session.name} · ${index.session.track} · ${when}`,
        ),
        value: f,
      })
      if (out.length === MAX_CHOICES) break
    }
    return out
  }

  async #index(file: string | undefined): Promise<JournalIndex | undefined> {
    const path = file && (await journalPath(this.#o.recordings, file))
    return path ? indexJournal(path).catch(() => undefined) : undefined
  }

  /** The reporter's car in a recording, through their claim and the entry list's GUID. */
  async #reporterCar(discordUserId: string, index: JournalIndex): Promise<JournalCar | undefined> {
    const championshipId = this.#o.championshipId
    if (!championshipId) return undefined
    const claim = await this.#o.claims.forDiscordUser(championshipId, discordUserId)
    if (!claim) return undefined
    const championship = await this.#o.reader
      .exportChampionship(championshipId)
      .catch(() => undefined)
    const guid = championship && guidFor(championship, claim.entrantName)
    return (
      (guid && index.cars.find((c) => c.guid && normGuid(c.guid) === guid)) ||
      index.cars.find((c) => sameName(c.driver, claim.entrantName))
    )
  }
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
  return (byGuid ?? all.find((e) => sameName(e.Name ?? "", car.driver)))?.Name
}

const sameName = (a: string, b: string): boolean =>
  a.normalize("NFC").trim().toLowerCase() === b.normalize("NFC").trim().toLowerCase()

function channelName(i: Incident): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
  return `incident-${i.number}-${slug(i.reporter)}-${slug(i.other)}`.slice(0, 100)
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

function startedFrom(file: string): number {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(file)
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : Number.NaN
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
