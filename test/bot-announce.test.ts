/**
 * `champctl-bot announce` end to end: the real `main`, a profile on disk, and
 * the export over loopback HTTP.
 *
 * Exit codes are what cron reads, and every path to one runs through code the
 * unit tests in announce.test.ts never reach — which channel the command
 * resolves, what an unreadable export becomes, and which refusals count as a
 * quiet week. `--dry-run` everywhere a post would happen, so nothing needs a
 * token; the token is also blanked, so a developer's own cannot make a test
 * log in.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ChampionshipEvent } from "../src/acsm/types.js"
import { main, TOKEN_ENV } from "../src/cli/bot.js"
import { acsmStub, type AcsmStub } from "./support/acsm-stub.js"
import { championship, raceEvent, testProfile } from "./support/build.js"

const ID = "11111111-1111-1111-1111-111111111111"
const ANNOUNCE = "2".repeat(18)

/** Before the builder's 2 September round, so it is still ahead. */
const NOW = "2026-08-24T12:00:00-07:00"

let out = ""
let err = ""
let dir = ""
let stub: AcsmStub | undefined

beforeEach(() => {
  out = ""
  err = ""
  dir = mkdtempSync(join(tmpdir(), "champctl-announce-"))
  vi.stubEnv(TOKEN_ENV, "")
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out += String(chunk)
    return true
  })
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err += String(chunk)
    return true
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await stub?.close()
  stub = undefined
  rmSync(dir, { recursive: true, force: true })
})

/** Serves `events` as championship `ID`, writes a profile pointing at it, and runs. */
async function run(
  events: ChampionshipEvent[],
  argv: string[],
  discord: Record<string, string> = { announceChannelId: ANNOUNCE },
): Promise<number> {
  stub = await acsmStub(ID, championship({ ID, Events: events }))
  const profile = join(dir, "league.json")
  writeFileSync(profile, JSON.stringify({ ...testProfile(), acsmBaseUrl: stub.baseUrl, discord }))
  return main(["announce", ...argv, "--profile", profile, "--no-cache", "--now", NOW])
}

const raced = () =>
  raceEvent({
    StartedTime: "2026-08-05T19:00:00-07:00",
    CompletedTime: "2026-08-05T20:30:00-07:00",
  })

describe("champctl-bot announce", () => {
  it("posts the next round and exits 0", async () => {
    expect(await run([raceEvent()], [ID, "--dry-run"])).toBe(0)
    expect(out).toContain("round 1: suzuka")
    expect(out).toContain("Announced round 1.")
  })

  it("reads --now, so a week that has gone by is not announced", async () => {
    // 2 September is still ahead at NOW and gone by a fortnight later; if --now
    // were ignored the answer would depend on the day the suite ran.
    expect(
      await run(
        [raceEvent(), raceEvent({ Scheduled: "2026-09-09T19:00:00-07:00" })],
        [ID, "--dry-run"],
      ),
    ).toBe(0)
    expect(out).toContain("Announced round 1.")
  })

  it("exits 0 when the season has nothing left, since that is its ordinary end", async () => {
    expect(await run([raced()], [ID, "--dry-run"])).toBe(0)
    expect(out).toContain("Nothing left to announce")
  })

  it("exits 2 for a round that doesn't exist, rather than reading as a post", async () => {
    // This exited 0, the same as a clean post, so a typo'd round in a cron
    // entry announced nothing every week and looked fine doing it.
    expect(await run([raceEvent()], [ID, "2", "--dry-run"])).toBe(2)
    expect(err).toContain("There is no round 2")
  })

  it("exits 2 for an explicit round that has already been raced", async () => {
    expect(await run([raced(), raceEvent()], [ID, "1", "--dry-run"])).toBe(2)
    expect(err).toContain("already been raced")
  })

  it("exits 2 for a championship it can't read, as the usage says", async () => {
    // The stub 404s every other id. This escaped to runCli and exited 3, which
    // is "the run itself failed" — the code a timer pages somebody over.
    expect(await run([raceEvent()], ["22222222-2222-2222-2222-222222222222", "--dry-run"])).toBe(2)
    expect(err).toContain("Couldn't read championship 22222222-2222-2222-2222-222222222222")
  })

  it("refuses to post without the announce channel, even with the admin one set", async () => {
    // No fallback between the two, end to end: gridmom's channel is the admins'
    // and quotes the entry list. Refused before the export is fetched or
    // Discord is touched.
    const code = await run([raceEvent()], [ID], { adminChannelId: "1".repeat(18) })
    expect(code).toBe(3)
    expect(err).toContain("Set discord.announceChannelId")
    expect(stub?.requests).toEqual([])
  })
})
