/**
 * champctl's reading side as MCP tools: championships, standings, GridMom's
 * findings, liveries and stewarding. Nothing here can change a championship:
 * it holds the credential-free ACSM reader, and opens the stores only to read.
 */

import type { AcsmReader } from "../acsm/client.js"
import type { Championship } from "../acsm/types.js"
import { classes, eventHasResults, events, slots, trackLabel } from "../acsm/view.js"
import {
  computeStandings,
  isUnscorable,
  parseStandings,
  parseStandingsPage,
  type StandingsClass,
} from "../bot/standings.js"
import { check } from "../gridmom/index.js"
import { formatText } from "../gridmom/report.js"
import type { SqliteIncidentStore } from "../incidents/store.js"
import type { SqliteClaimStore } from "../liveries/claims.js"
import type { SqliteSubmissionQueue } from "../liveries/queue.js"
import type { SqliteLiveryStore } from "../liveries/store.js"
import type { PitTable } from "../pits/table.js"
import type { LeagueProfile } from "../profile/types.js"
import { type Content, type McpTool, NO_ARGS } from "./server.js"

export interface ChampctlToolOptions {
  reader: AcsmReader
  profile: LeagueProfile
  pits?: PitTable
  /** The bot's store, where claims, liveries and incident reports are kept. */
  stores?: {
    claims: SqliteClaimStore
    liveries: SqliteLiveryStore
    queue: SqliteSubmissionQueue
    incidents: SqliteIncidentStore
  }
}

const CHAMPIONSHIP_ARG = {
  type: "object",
  properties: { championship: { type: "string", description: "An id from list_championships." } },
  required: ["championship"],
  additionalProperties: false,
}

const text = (t: string): Content[] => [{ type: "text", text: t }]

export function championshipTools(o: ChampctlToolOptions): McpTool[] {
  const read = async (args: Record<string, unknown>): Promise<[string, Championship]> => {
    const id = args["championship"]
    if (typeof id !== "string" || !id)
      throw new Error("championship must be an id from list_championships")
    return [id, await o.reader.exportChampionship(id)]
  }

  const tools: McpTool[] = [
    {
      name: "list_championships",
      description: "Every championship on the league's Server Manager, with its id.",
      inputSchema: NO_ARGS,
      async run() {
        const list = await o.reader.listChampionships()
        return text(list.map((c) => `${c.ID ?? "?"}  ${c.Name ?? ""}`).join("\n") || "None.")
      },
    },
    {
      name: "get_championship",
      description:
        "A championship's classes, cars and grid size, and its rounds: track, schedule, and whether each has been raced.",
      inputSchema: CHAMPIONSHIP_ARG,
      async run(args) {
        const [id, c] = await read(args)
        const lines = [`${c.Name ?? id} (${id})`, "", "Classes:"]
        for (const cls of classes(c)) {
          const grid = slots(cls.Entrants).filter((s) => (s.entrant.Name ?? "").trim()).length
          lines.push(
            `- ${cls.Name ?? "?"}: ${grid} entrants, cars ${(cls.AvailableCars ?? []).join(", ")}`,
          )
        }
        lines.push("", "Rounds:")
        events(c).forEach((ev, i) => {
          const scheduled =
            ev.Scheduled && !ev.Scheduled.startsWith("0001") ? `, scheduled ${ev.Scheduled}` : ""
          lines.push(
            `${i + 1}. ${trackLabel(ev.RaceSetup) || "no track"}${scheduled}, ${eventHasResults(ev) ? "raced" : "not raced"}`,
          )
        })
        return text(lines.join("\n"))
      },
    },
    {
      name: "get_entry_list",
      description:
        "A championship's entry list, class by class: each slot's driver, GUID, team, car and skin.",
      inputSchema: CHAMPIONSHIP_ARG,
      async run(args) {
        const [, c] = await read(args)
        const lines: string[] = []
        for (const cls of classes(c)) {
          lines.push(`${cls.Name ?? "?"}:`)
          for (const s of slots(cls.Entrants)) {
            const e = s.entrant
            const who = (e.Name ?? "").trim() || "(open slot)"
            lines.push(
              `  ${s.key}: ${who}${e.GUID ? `, GUID ${e.GUID}` : ""}${e.Team ? `, team ${e.Team}` : ""}, ${e.Model ?? "?"} / ${e.Skin || "default skin"}`,
            )
          }
        }
        return text(lines.join("\n") || "No entrants.")
      },
    },
    {
      name: "get_standings",
      description:
        "A championship's standings by class: Server Manager's own where it serves them, else worked out from the results.",
      inputSchema: CHAMPIONSHIP_ARG,
      async run(args) {
        const [id, c] = await read(args)
        const { from, classes: standings } = await standingsOf(o.reader, id, c)
        const lines = [`Standings (${from}):`]
        for (const cls of standings) {
          // A single unnamed class is the whole field: no heading for it.
          lines.push("", ...(cls.name ? [`${cls.name}:`] : []))
          for (const r of cls.rows) lines.push(`${r.position}. ${r.driver}, ${r.points} pts`)
        }
        return text(lines.join("\n"))
      },
    },
    {
      name: "check_championship",
      description:
        "GridMom's check of a championship: what's wrong or risky in its setup, rounds, entry list and schedule, most serious first.",
      inputSchema: CHAMPIONSHIP_ARG,
      async run(args) {
        const [, c] = await read(args)
        const report = check(c, o.profile, o.pits ? { pits: o.pits } : {})
        return text(formatText(report))
      },
    },
  ]
  return tools
}

/** Server Manager's standings where it serves them, else the export's, which some formats can't be scored from. */
async function standingsOf(
  reader: AcsmReader,
  id: string,
  c: Championship,
): Promise<{ from: string; classes: StandingsClass[] }> {
  const endpoint = await reader.standings(id).then(parseStandings, () => undefined)
  if (endpoint) return { from: "Server Manager", classes: endpoint }
  const page = await reader.championshipPage(id).then(parseStandingsPage, () => "absent" as const)
  if (page !== "absent" && page !== "unrecognised")
    return { from: "Server Manager's page", classes: page }
  const computed = computeStandings(c)
  if (isUnscorable(computed)) throw new Error(`can't work these standings out: ${computed.reason}`)
  return { from: "worked out from the results", classes: computed }
}

export function storeTools(o: ChampctlToolOptions): McpTool[] {
  const stores = o.stores
  if (!stores) return []
  return [
    {
      name: "livery_status",
      description:
        "Each driver's livery for a championship: who's claimed their name, what's applied, and uploads queued or refused.",
      inputSchema: CHAMPIONSHIP_ARG,
      async run(args) {
        const id = args["championship"]
        if (typeof id !== "string" || !id)
          throw new Error("championship must be an id from list_championships")
        const [claims, applied, history] = await Promise.all([
          stores.claims.list(id),
          stores.liveries.list(id),
          stores.queue.history(id),
        ])
        const lines = [`${claims.length} drivers have claimed their name.`]
        for (const cl of claims) lines.push(`- ${cl.entrantName}`)
        lines.push("", `${applied.length} liveries applied:`)
        for (const l of applied)
          lines.push(`- ${l.driverName}: ${l.carModel}/${l.skinFolder}, ${l.appliedAt}`)
        const pending = history.filter((s) => s.state === "queued" || s.state === "refused")
        lines.push("", `${pending.length} uploads queued or refused:`)
        for (const s of pending) {
          lines.push(
            `- ${s.driverName}, ${s.carModel}, ${s.state}${s.reason ? `: ${s.reason}` : ""} (${s.submittedAt})`,
          )
        }
        return text(lines.join("\n"))
      },
    },
    {
      name: "list_incident_reports",
      description:
        "Incidents drivers have reported with /incident, newest first: who reported whom, when in which session, what they said, and the stewards' decision if there is one.",
      inputSchema: {
        type: "object",
        properties: { open: { type: "boolean", description: "Only those not yet decided." } },
        additionalProperties: false,
      },
      async run(args) {
        const list = stores.incidents.list({ open: args["open"] === true })
        if (list.length === 0) return text("No incident reports.")
        return text(
          list
            .map((i) => {
              const at = `${Math.floor(i.atMs / 60000)}:${String(Math.floor(i.atMs / 1000) % 60).padStart(2, "0")}`
              return `#${i.number}, filed ${i.filedAt}: ${i.reporter} reports ${i.other}, ${at} into ${i.journal}.\n  "${i.description}"\n  ${i.decision === undefined ? "Not decided yet." : `Decided ${i.decidedAt ?? ""}: ${i.decision}`}`
            })
            .join("\n"),
        )
      },
    },
  ]
}
