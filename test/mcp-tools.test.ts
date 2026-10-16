import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { type AcsmReader, StaticAcsmReader } from "../src/acsm/client.js"
import type { Championship } from "../src/acsm/types.js"
import { SqliteIncidentStore } from "../src/incidents/store.js"
import { SqliteClaimStore } from "../src/liveries/claims.js"
import { SqliteSubmissionQueue } from "../src/liveries/queue.js"
import { SqliteLiveryStore } from "../src/liveries/store.js"
import type { McpTool } from "../src/mcp/server.js"
import { championshipTools, storeTools } from "../src/mcp/tools.js"
import { loadProfile } from "../src/profile/load.js"
import { championship, championshipClass, entryList } from "./support/build.js"

const ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
const champ: Championship = championship({
  ID,
  Name: "October",
  Classes: [
    championshipClass({
      Name: "RSS",
      Entrants: entryList([{ Name: "Ana", GUID: "76561198000000001", Skin: "red" }, {}]),
    }),
  ],
})

/** A static reader whose standings answer, or fail, as each test needs. */
function reader(standings: () => Promise<unknown>, page = "<html></html>"): AcsmReader {
  const r = new StaticAcsmReader([champ])
  return Object.assign(Object.create(Object.getPrototypeOf(r)) as AcsmReader, r, {
    exportChampionship: (id: string) => r.exportChampionship(id),
    listChampionships: () => r.listChampionships(),
    standings,
    championshipPage: async () => page,
  })
}

const run = async (tools: McpTool[], name: string, args: object = {}) => {
  const content = await tools.find((t) => t.name === name)!.run({ ...args })
  return content.map((c) => (c.type === "text" ? c.text : `[${c.mimeType}]`)).join("\n")
}

describe("championship tools", async () => {
  const profile = await loadProfile("batl")
  const tools = (standings: () => Promise<unknown> = async () => undefined) =>
    championshipTools({ reader: reader(standings), profile })

  it("lists the championships and describes one, open slots and all", async () => {
    expect(await run(tools(), "list_championships")).toBe(`${ID}  October`)
    expect(await run(tools(), "get_entry_list", { championship: ID })).toBe(
      "RSS:\n  CAR_0: Ana, GUID 76561198000000001, any_car_model / red\n  CAR_1: (open slot), any_car_model / default skin",
    )
  })

  it("takes Server Manager's standings where it serves them", async () => {
    const standings = async () => ({
      Classes: [{ Name: "RSS", Standings: [{ DriverName: "Ana", Points: 43 }] }],
    })
    expect(await run(tools(standings), "get_standings", { championship: ID })).toBe(
      "Standings (Server Manager):\n\nRSS:\n1. Ana, 43 pts",
    )
  })

  it("falls back to the results when Server Manager won't say, and says when they can't be scored", async () => {
    // The default points award pole and fastest lap, which champctl won't guess at.
    const refused = async () => Promise.reject(new Error("login required"))
    await expect(run(tools(refused), "get_standings", { championship: ID })).rejects.toThrow(
      /can't work these standings out: RSS awards points for pole position/,
    )
  })

  it("runs GridMom's checks", async () => {
    expect(await run(tools(), "check_championship", { championship: ID })).toMatch(/October/)
  })

  it("says so when asked for a championship that isn't there", async () => {
    await expect(run(tools(), "get_championship", { championship: "nope" })).rejects.toThrow()
  })
})

describe("store tools", () => {
  let stores: {
    claims: SqliteClaimStore
    liveries: SqliteLiveryStore
    queue: SqliteSubmissionQueue
    incidents: SqliteIncidentStore
  }
  beforeEach(async () => {
    stores = {
      claims: await SqliteClaimStore.open(":memory:"),
      liveries: await SqliteLiveryStore.open(":memory:"),
      queue: await SqliteSubmissionQueue.open(":memory:"),
      incidents: await SqliteIncidentStore.open(":memory:"),
    }
  })
  afterEach(() => {
    for (const s of Object.values(stores)) s.close()
  })

  it("lists incident reports newest first, and only the undecided ones when asked", async () => {
    const profile = await loadProfile("batl")
    const tools = storeTools({ reader: reader(async () => undefined), profile, stores })
    for (const [atMs, decided] of [
      [779_000, true],
      [5_000, false],
    ] as const) {
      const i = stores.incidents.file(
        {
          reporterDiscord: "1",
          reporter: "Ana",
          other: "Bo",
          journal: "race.ndjson.gz",
          atMs,
          description: "turned in on me",
        },
        new Date("2026-10-15T04:00:00Z"),
      )
      stores.incidents.setChannel(i.number, `c${i.number}`)
      if (decided)
        stores.incidents.decide(i.number, "Racing incident", "s", new Date("2026-10-15T05:00:00Z"))
    }
    const all = await run(tools, "list_incident_reports")
    expect(all.split("\n").filter((l) => l.startsWith("#"))).toEqual([
      "#2, filed 2026-10-15T04:00:00.000Z: Ana reports Bo, 0:05 into race.ndjson.gz.",
      "#1, filed 2026-10-15T04:00:00.000Z: Ana reports Bo, 12:59 into race.ndjson.gz.",
    ])
    expect(all).toContain("Decided 2026-10-15T05:00:00.000Z: Racing incident")
    expect(await run(tools, "list_incident_reports", { open: true })).not.toContain("#1,")
  })
})
