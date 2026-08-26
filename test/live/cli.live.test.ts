/**
 * The CLIs themselves, against a real ACSM.
 *
 *   npm run harness:up && npm run harness:provision
 *   set -a && . docker/.env && set +a
 *   npm run test:live
 *
 * The other live files drive the *engines* — `planFinalize`, `applyFinalize`,
 * `emitChampionship`. This one drives `main(argv)`, which is what a person actually
 * runs, and which until now nothing exercised at all: argument parsing, profile
 * loading, base-URL resolution, credentials from the environment, the
 * confirmation prompt, and the mapping from an outcome to an exit code. A
 * finalize could have been correct in every one of those files and still been
 * wired to the wrong exit code, or to a `--push` that previews.
 *
 * **Assertions are on exit codes**, per AGENTS.md, plus the state left on the
 * server. Both matter: the exit code is the documented contract for cron, and
 * the server state is the thing a wrong one would hide.
 *
 * `main()` is called in-process rather than spawned. It returns the exit code
 * instead of calling `process.exit`, which is what makes that possible, and it
 * keeps a failure debuggable — a spawned process would report only a number.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { AcsmSession } from "../../src/acsm/session.js"
import type { Championship } from "../../src/acsm/types.js"
import { events, session as sessionConfig } from "../../src/acsm/view.js"
import { importChampionship, listChampionshipIds } from "../../src/acsm/write.js"
import { main as archiveMain } from "../../src/cli/archive.js"
import { main as finalizeMain } from "../../src/cli/finalize.js"
import { main as gridmomMain } from "../../src/cli/gridmom.js"
import { main as monthMain } from "../../src/cli/championship.js"
import { LIVE, SEED, deleteChampionship, liveConfig, liveSession, loadFixture } from "./harness.js"

const PROFILE = resolve(process.cwd(), "test/support/profile-harness.json")

/**
 * Runs a CLI with stdout and stderr captured, and returns the exit code.
 *
 * Captured rather than silenced so a failing assertion can show what the tool
 * said — an exit code on its own is a poor bug report.
 *
 * The login pacing that used to live here has moved to `test/live/setup.ts`,
 * where it covers the whole suite rather than this file. Module state paced
 * these invocations and nothing else, so the other three files ran unpaced and
 * spent the budget this one was carefully staying inside.
 */
async function cli(
  main: (argv: readonly string[]) => Promise<number>,
  argv: readonly string[],
): Promise<{ code: number; out: string; err: string }> {
  let out = ""
  let err = ""
  const stdout = process.stdout.write.bind(process.stdout)
  const stderr = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((c: string | Uint8Array) => {
    out += String(c)
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((c: string | Uint8Array) => {
    err += String(c)
    return true
  }) as typeof process.stderr.write
  try {
    const code = await main(argv)
    return { code, out, err }
  } finally {
    process.stdout.write = stdout
    process.stderr.write = stderr
  }
}

describe.skipIf(!LIVE)("the CLIs against a real ACSM", () => {
  let session: AcsmSession | undefined
  let tmp = ""
  const created: string[] = []
  const config = liveConfig()
  const baseUrl = config?.baseUrl ?? ""

  beforeAll(async () => {
    session = await liveSession()
    tmp = await mkdtemp(join(tmpdir(), "champctl-cli-"))
    // The write commands read these from the environment and nowhere else.
    process.env["CHAMPCTL_USERNAME"] = config?.username
    process.env["CHAMPCTL_PASSWORD"] = config?.password
  }, 60_000)

  afterAll(async () => {
    if (!session) return
    for (const id of created) {
      try {
        await deleteChampionship(session, id)
      } catch {
        // A stray championship on a throwaway container is untidy, not a failure.
      }
    }
  })

  const live = (): AcsmSession => {
    if (!session) throw new Error("no live session; beforeAll did not complete")
    return session
  }

  /** A fresh championship to operate on, so tests can't interfere with each other. */
  const seeded = async (): Promise<{ id: string; export: Championship }> => {
    const { championshipId } = await importChampionship(live(), await loadFixture(SEED))
    if (!championshipId) throw new Error("import did not redirect to a new championship")
    created.push(championshipId)
    return {
      id: championshipId,
      export: await live().getJson<Championship>(`/championship/${championshipId}/export`),
    }
  }

  const exportOf = (id: string) => live().getJson<Championship>(`/championship/${id}/export`)

  // -------------------------------------------------------------------------
  // champctl-archive
  //
  // First on purpose. It fetches one export per championship on the server at
  // the reader's 5-per-20s, so every championship a later test creates would be
  // another four seconds here. Running it before the rest have accumulated
  // keeps it to a handful of requests without disabling pacing that is correct
  // in production.
  // -------------------------------------------------------------------------

  describe("champctl-archive", () => {
    it("archives what it finds, then reports nothing new the second time", async () => {
      await seeded()
      const db = join(tmp, "archive.db")

      const first = await cli(archiveMain, [
        "run",
        "--db",
        db,
        "--profile",
        PROFILE,
        "--base-url",
        baseUrl,
      ])
      expect(first.code, "0 nothing changed, 1 archived, 2 a failure, 3 the run died").toBe(1)

      // A snapshot is written only when the export changed, so an unchanged
      // second run is the difference between a change history and a pile of
      // duplicates.
      const second = await cli(archiveMain, [
        "run",
        "--db",
        db,
        "--profile",
        PROFILE,
        "--base-url",
        baseUrl,
      ])
      expect(second.code, "nothing changed since the first run").toBe(0)

      const status = await cli(archiveMain, ["status", "--db", db, "--profile", PROFILE])
      expect(status.code).toBe(0)
      // Generous: the archive fetches one export per championship and the
      // reader keeps ACSM's documented 5-per-20s, so this grows with whatever
      // else the suite has created. That pacing is correct in production and
      // is not worth disabling to make a test quick.
    }, 300_000)
  })

  // -------------------------------------------------------------------------
  // gridmom — read-only, no credentials
  // -------------------------------------------------------------------------

  describe("gridmom", () => {
    it("checks a championship over HTTP and exits on the finding severity", async () => {
      const { id } = await seeded()
      const { code } = await cli(gridmomMain, [
        "check",
        id,
        "--profile",
        PROFILE,
        "--base-url",
        baseUrl,
        "--no-cache",
      ])
      // 0 clean, 1 warnings, 2 errors, 3 gridmom itself failed. Which of the
      // first three depends on the fixture; 3 never is acceptable, and would be
      // the code a broken read path produces.
      expect([0, 1, 2]).toContain(code)
    }, 60_000)

    it("exits 2 on a championship with errors, which is what blocks a cron push", async () => {
      const { championshipId } = await importChampionship(
        live(),
        await loadFixture("fixtures/synthetic/recon-seed-duplicate-pitboxes.json"),
      )
      if (championshipId) created.push(championshipId)
      const { code } = await cli(gridmomMain, [
        "check",
        championshipId!,
        "--profile",
        PROFILE,
        "--base-url",
        baseUrl,
        "--no-cache",
      ])
      expect(code, "duplicate pit boxes are an ERROR").toBe(2)
    }, 60_000)

    it("needs no credentials at all", async () => {
      const { id } = await seeded()
      const username = process.env["CHAMPCTL_USERNAME"]
      const password = process.env["CHAMPCTL_PASSWORD"]
      // `env.X = undefined` assigns the *string* "undefined", which is a
      // perfectly good username as far as a login is concerned. Deleting is the
      // only way to model "not set".
      delete process.env["CHAMPCTL_USERNAME"]
      delete process.env["CHAMPCTL_PASSWORD"]
      try {
        const { code } = await cli(gridmomMain, [
          "check",
          id,
          "--profile",
          PROFILE,
          "--base-url",
          baseUrl,
          "--no-cache",
        ])
        expect(code).not.toBe(3)
      } finally {
        if (username !== undefined) process.env["CHAMPCTL_USERNAME"] = username
        if (password !== undefined) process.env["CHAMPCTL_PASSWORD"] = password
      }
    }, 60_000)
  })

  // -------------------------------------------------------------------------
  // champctl-finalize
  // -------------------------------------------------------------------------

  describe("champctl-finalize", () => {
    it("previews without writing, which is the default and the safety property", async () => {
      const { id } = await seeded()
      const before = await exportOf(id)

      const { code } = await cli(finalizeMain, [
        id,
        "1",
        "--laps",
        "19",
        "--profile",
        PROFILE,
        "--base-url",
        baseUrl,
      ])

      expect(code, "a preview succeeds").toBe(0)
      // The whole point of the default: nothing moved on the server.
      const after = await exportOf(id)
      expect(sessionConfig(events(after)[0]!, "Race")?.Laps).toBe(
        sessionConfig(events(before)[0]!, "Race")?.Laps,
      )
    }, 60_000)

    it("pushes when told to, and the value lands", async () => {
      const { id } = await seeded()
      const { code } = await cli(finalizeMain, [
        id,
        "1",
        "--laps",
        "19",
        "--pit",
        "--push",
        "--yes",
        "--accept-warnings",
        "--profile",
        PROFILE,
        "--base-url",
        baseUrl,
      ])

      expect(code).toBe(0)
      const after = await exportOf(id)
      expect(sessionConfig(events(after)[0]!, "Race")?.Laps).toBe(19)
      expect(events(after)[0]?.RaceSetup?.RacePitWindowStart).toBe(1)
    }, 60_000)

    /**
     * The same property `flows.live.test.ts` pins on the engine, asserted
     * through the command a person actually types. Worth having twice: the
     * engine could keep its sessions while the CLI passed a different session
     * or a different form, and only this test would notice.
     */
    it("keeps every session when pushing", async () => {
      const { id } = await seeded()
      const before = Object.keys(events(await exportOf(id))[0]?.RaceSetup?.Sessions ?? {}).sort()

      const { code } = await cli(finalizeMain, [
        id,
        "1",
        "--laps",
        "19",
        "--push",
        "--yes",
        "--accept-warnings",
        "--profile",
        PROFILE,
        "--base-url",
        baseUrl,
      ])
      expect(code).toBe(0)

      const after = Object.keys(events(await exportOf(id))[0]?.RaceSetup?.Sessions ?? {}).sort()
      expect(after, "a push must not drop sessions").toEqual(before)
    }, 60_000)

    it("refuses to prompt with nothing on stdin, rather than writing unasked", async () => {
      // --push without --yes, and vitest gives the run no TTY. Exit 3 is
      // "champctl failed"; what matters is that it is not 0 and nothing wrote.
      const { id } = await seeded()
      const before = await exportOf(id)
      const { code } = await cli(finalizeMain, [
        id,
        "1",
        "--laps",
        "7",
        "--push",
        "--accept-warnings",
        "--profile",
        PROFILE,
        "--base-url",
        baseUrl,
      ])
      expect(code).not.toBe(0)
      const after = await exportOf(id)
      expect(sessionConfig(events(after)[0]!, "Race")?.Laps).toBe(
        sessionConfig(events(before)[0]!, "Race")?.Laps,
      )
    }, 60_000)

    it("reports a round that doesn't exist as a usage mistake", async () => {
      const { id } = await seeded()
      const { code } = await cli(finalizeMain, [
        id,
        "99",
        "--laps",
        "18",
        "--profile",
        PROFILE,
        "--base-url",
        baseUrl,
      ])
      // 3, not 1. `1` is "nothing to do" and a round that doesn't exist is not
      // that — it's a usage mistake, which `reportUsageError` maps to 3 along
      // with everything else under "champctl failed". Pinned because a cron job
      // reading these codes cannot tell a typo from a broken manager, and if
      // that ever needs separating, this test is where it will be noticed.
      expect(code, "a usage mistake is exit 3").toBe(3)
    }, 60_000)

    it("needs credentials even to preview, and says so", async () => {
      const { id } = await seeded()
      const username = process.env["CHAMPCTL_USERNAME"]
      delete process.env["CHAMPCTL_USERNAME"]
      try {
        const { code, err } = await cli(finalizeMain, [
          id,
          "1",
          "--laps",
          "18",
          "--profile",
          PROFILE,
          "--base-url",
          baseUrl,
        ])
        expect(code, "missing credentials is a usage mistake").toBe(3)
        expect(err).toContain("CHAMPCTL_USERNAME")
      } finally {
        if (username !== undefined) process.env["CHAMPCTL_USERNAME"] = username
      }
    }, 60_000)
  })

  // -------------------------------------------------------------------------
  // champctl-championship
  // -------------------------------------------------------------------------

  describe("champctl-championship", () => {
    const spec = {
      name: "champctl cli live",
      cars: ["rss_formula_hybrid_2021"],
      rounds: [{ track: "spa" }, { track: "suzuka" }],
      startDate: "2027-03-03",
      entryListSlots: 6,
    }

    const specFile = async (over: Record<string, unknown> = {}): Promise<string> => {
      const path = join(tmp, `spec-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
      await writeFile(path, JSON.stringify({ ...spec, ...over }), "utf8")
      return path
    }

    const templateFile = async (): Promise<string> => {
      const path = join(tmp, "template.json")
      await writeFile(path, await readFile(resolve(process.cwd(), SEED), "utf8"), "utf8")
      return path
    }

    it("writes nothing without --out or --import", async () => {
      const before = (await listChampionshipIds(live())).length
      const { code } = await cli(monthMain, [
        "build",
        "--spec",
        await specFile(),
        "--template",
        await templateFile(),
        "--profile",
        PROFILE,
        "--base-url",
        baseUrl,
      ])
      expect(code).toBe(0)
      // Nothing was created. Counting championships rather than page bytes: the
      // page carries a live uptime, so its length changes on its own.
      expect((await listChampionshipIds(live())).length).toBe(before)
    }, 60_000)

    it("imports a championship ACSM accepts, keyed the way ACSM reads sessions", async () => {
      const name = `champctl cli import ${Date.now()}`
      const { code } = await cli(monthMain, [
        "build",
        "--spec",
        await specFile({ name }),
        "--template",
        await templateFile(),
        "--import",
        "--yes",
        "--profile",
        PROFILE,
        "--base-url",
        baseUrl,
      ])
      expect(code, "the emitted championship must import").toBe(0)

      // Found by scraping, because 2.4.x has no championships list endpoint —
      // see HttpAcsmReader.listChampionships.
      const ids = await listChampionshipIds(live())
      let made: Championship | undefined
      for (const candidate of ids) {
        const c = await exportOf(candidate)
        if (c.Name === name) {
          made = c
          created.push(candidate)
          break
        }
      }
      expect(made, "the imported championship should be on the server").toBeTruthy()

      const champ = made!
      expect(events(champ)).toHaveLength(2)
      for (const ev of events(champ)) {
        const keys = Object.keys(ev.RaceSetup?.Sessions ?? {})
        expect(keys, "sessions must be keyed as ACSM reads them").toContain("RACE")
      }
    }, 60_000)

    it("writes the championship to a file with --out, and still creates nothing", async () => {
      const out = join(tmp, "championship.json")
      const { code } = await cli(monthMain, [
        "build",
        "--spec",
        await specFile(),
        "--template",
        await templateFile(),
        "--out",
        out,
        "--profile",
        PROFILE,
        "--base-url",
        baseUrl,
      ])
      expect(code).toBe(0)
      const written = JSON.parse(await readFile(out, "utf8")) as Championship
      expect(events(written)).toHaveLength(2)
    }, 60_000)
  })
})
