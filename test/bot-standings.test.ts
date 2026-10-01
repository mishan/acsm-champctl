/**
 * What `champctl-bot standings` tells cron: the exit code for each way a run
 * can end.
 *
 * `resolveStandings` has its own tests in standings.test.ts, which check what
 * it returns and what it says on stderr. None of them looked at the number
 * cron actually reads, and that is where these bugs were: a disagreement
 * between the sources exited 0, and an unreadable export exited 3.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { StaticAcsmReader, type AcsmReader } from "../src/acsm/client.js"
import type { Championship } from "../src/acsm/types.js"
import { parseArgs, runStandings } from "../src/cli/bot.js"
import { championship, championshipClass, raceEvent } from "./support/build.js"

const ID = "abc"

/** One raced round, ada ahead of bo, on a points table the export can score. */
const scorable = (over: Partial<Championship> = {}): Championship =>
  championship({
    ID,
    Name: "BATL September",
    Classes: [championshipClass({ Points: { Places: [25, 18], BestLap: 0, PolePosition: 0 } })],
    Events: [
      raceEvent({
        StartedTime: "2026-08-05T19:00:00-07:00",
        Sessions: {
          RACE: {
            Name: "Race",
            Results: { Result: [{ DriverName: "ada" }, { DriverName: "bo" }] },
          },
        },
      }),
    ],
    IgnoreXWorstEvents: 0,
    ...over,
  })

/** ACSM's answer, agreeing with `scorable` unless told otherwise. */
const acsmSays = (ada: number, bo: number) => async (): Promise<unknown> => ({
  Classes: [
    {
      Name: "RSS",
      Standings: [
        { DriverName: "ada", Points: ada },
        { DriverName: "bo", Points: bo },
      ],
    },
  ],
})

const gone = async (): Promise<never> => {
  throw new Error("404 Not Found")
}

/** A reader serving `champ` as its export, or failing it, and `standings` as told. */
function reader(champ: Championship | "gone", standings: () => Promise<unknown>): AcsmReader {
  const inner = new StaticAcsmReader(champ === "gone" ? [] : [champ])
  return {
    listChampionships: () => inner.listChampionships(),
    exportChampionship: champ === "gone" ? gone : (id: string) => inner.exportChampionship(id),
    exportChampionshipRaw: (id: string) => inner.exportChampionshipRaw(id),
    standings,
    championshipPage: () => inner.championshipPage(),
    healthcheck: () => inner.healthcheck(),
    listContent: () => inner.listContent(),
  }
}

let err = ""
let posted: string[] = []
const post = async (messages: readonly string[]) => {
  posted.push(...messages)
}

beforeEach(() => {
  err = ""
  posted = []
  vi.spyOn(process.stdout, "write").mockImplementation(() => true)
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err += String(chunk)
    return true
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

const run = (r: AcsmReader, ...flags: string[]) =>
  runStandings(r, parseArgs(["standings", ID, ...flags]), "https://acsm.example", post)

describe("champctl-bot standings exit codes", () => {
  it("exits 0 when ACSM and the export agree", async () => {
    expect(await run(reader(scorable(), acsmSays(25, 18)))).toBe(0)
    expect(posted).not.toEqual([])
  })

  it("exits 1 when they disagree, still posting ACSM's numbers", async () => {
    // Reported on stderr and exited 0, so from cron the cross-check that keeps
    // the fallback honest was reporting to nobody.
    expect(await run(reader(scorable(), acsmSays(999, 18)))).toBe(1)
    expect(posted.join("\n")).toContain("999")
    expect(err).toContain("disagreement")
  })

  it("exits 1 when ACSM answers in a shape champctl can't read, even with the export to fall on", async () => {
    const unreadable = async (): Promise<unknown> => ({ Classes: [{ Name: "RSS", Drivers: [] }] })
    expect(await run(reader(scorable(), unreadable))).toBe(1)
    expect(posted).not.toEqual([])
  })

  it("exits 0 on an OSS build, where the endpoint not answering is normal", async () => {
    expect(await run(reader(scorable(), gone))).toBe(0)
  })

  it("exits 2 when the export is asked for and can't be scored", async () => {
    const drops = scorable({ IgnoreXWorstEvents: 1 })
    expect(await run(reader(drops, gone), "--source", "export")).toBe(2)
    expect(posted).toEqual([])
  })

  it("exits 2 when --source endpoint rules out the export and the endpoint is gone", async () => {
    expect(await run(reader(scorable(), gone), "--source", "endpoint")).toBe(2)
  })

  it("exits 2 when the export can't be read, as the usage says, not 3", async () => {
    // This escaped to runCli, which calls every throw "the run itself failed".
    expect(await run(reader("gone", acsmSays(25, 18)))).toBe(2)
    expect(err).toContain("Couldn't read championship abc")
  })

  it("still posts ACSM's table under --source endpoint when only the export is unreadable", async () => {
    // There the export was only ever for the heading.
    expect(await run(reader("gone", acsmSays(25, 18)), "--source", "endpoint")).toBe(0)
    expect(posted[0]).toContain(`**${ID} — RSS**`)
  })
})
