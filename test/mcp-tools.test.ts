import { chmod, mkdtemp, rm, stat } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { type AcsmReader, StaticAcsmReader } from "../src/acsm/client.js"
import type { Championship } from "../src/acsm/types.js"
import { openStores } from "../src/cli/mcp.js"
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
  const tools = (standings: () => Promise<unknown> = async () => undefined, page?: string) =>
    championshipTools({ reader: reader(standings, page), profile })

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

  it("reads the championship page when Server Manager wants a login for its standings", async () => {
    // BATL's build, logged out: the endpoint refuses, the page has the table.
    const page =
      `<html><body><div class="tab-pane" id="drivers"><table class="table"><thead><tr><th>#</th>` +
      `<th>Driver</th><th>Points</th></tr></thead><tbody><tr><td>1</td><td>Ana</td><td><span>97</span></td></tr>` +
      `</tbody></table></div></body></html>`
    const refused = async () => Promise.reject(new Error("login required"))
    expect(await run(tools(refused, page), "get_standings", { championship: ID })).toBe(
      "Standings (Server Manager's page):\n\n1. Ana, 97 pts",
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

  it("lists every upload waiting to be applied, however many came after it", async () => {
    const profile = await loadProfile("batl")
    const tools = storeTools({ reader: reader(async () => undefined), profile, stores })
    const submit = (driver: string, minute: number) =>
      stores.queue.submit({
        discordUserId: driver,
        championshipId: ID,
        driverName: driver,
        carModel: "car",
        skinFolder: driver,
        body: new Uint8Array([1]),
        at: new Date(Date.UTC(2026, 9, 15, 0, minute)),
      })
    await submit("Ana", 0)
    // Fifty uploads since, all refused: more than the history keeps.
    for (let i = 1; i <= 50; i++) {
      const r = await submit(`Driver ${i}`, i)
      await stores.queue.markRefused(r.submission.id, "not a skin", new Date())
    }
    const status = await run(tools, "livery_status", { championship: ID })
    expect(status).toContain("1 uploads waiting to be applied:\n- Ana, car")
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

describe("opening the bot's store to read", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-store-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("changes nothing: not the file's mode, and nothing in it can be written", async () => {
    const path = join(dir, "store.db")
    ;(await SqliteIncidentStore.open(path)).close()
    await chmod(path, 0o640)
    const store = SqliteIncidentStore.openForReading(path)
    expect(store.list()).toEqual([])
    expect(() =>
      store.file(
        {
          reporterDiscord: "1",
          reporter: "Ana",
          other: "Bo",
          journal: "j",
          atMs: 0,
          description: "x",
        },
        new Date(),
      ),
    ).toThrow(/readonly/)
    store.close()
    expect((await stat(path)).mode & 0o777).toBe(0o640)
  })

  it.each([
    ["one a newer champctl wrote", 99],
    ["one this champctl hasn't migrated yet", 0],
  ])("refuses %s rather than misread it", async (_, version) => {
    const path = join(dir, "store.db")
    ;(await SqliteIncidentStore.open(path)).close()
    const db = new DatabaseSync(path)
    db.prepare("UPDATE champctl_schema SET version = ? WHERE component = 'incidents'").run(version)
    db.close()
    expect(() => SqliteIncidentStore.openForReading(path)).toThrow(/schema version/)
  })

  it("leaves the store's tools out, rather than failing the server, when it won't open", async () => {
    const path = join(dir, "store.db")
    ;(await SqliteIncidentStore.open(path)).close()
    const db = new DatabaseSync(path)
    db.prepare("UPDATE champctl_schema SET version = 99 WHERE component = 'incidents'").run()
    db.close()
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    expect(openStores(path)).toBeUndefined()
    expect(String(stderr.mock.calls[0]?.[0])).toMatch(/serving without the store's tools/)
    stderr.mockRestore()
  })
})
