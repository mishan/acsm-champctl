import { zipSync } from "fflate"
import { describe, expect, it } from "vitest"

import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { unzipSync } from "fflate"

import { AcsmError } from "../src/acsm/client.js"
import { USAGE, UsageError, exitFor, main, parseArgs, renderPlan } from "../src/cli/liveries.js"
import { SqliteClaimStore } from "../src/liveries/claims.js"
import { SqliteLiveryStore } from "../src/liveries/store.js"
import type { Entrant } from "../src/acsm/types.js"
import {
  LiveryApplyError,
  MultiClassError,
  PracticeRestartError,
  RosterChangedError,
} from "../src/liveries/apply.js"
import { LiveryPackError, readLiveryPack } from "../src/liveries/pack.js"
import { LiveryPlanError, planLiveries } from "../src/liveries/plan.js"
import { championship, championshipClass, entryList, raceEvent } from "./support/build.js"

const CAR = "rss_formula_hybrid_2021"
const bytes = (s: string) => new TextEncoder().encode(s)
const skin = () => zipSync({ "livery.dds": bytes("x"), "ui_skin.json": bytes("{}") })

const person = (over: Partial<Entrant>): Partial<Entrant> => ({ Model: CAR, Skin: "", ...over })

describe("champctl-liveries arguments", () => {
  it("takes a championship id and a pack", () => {
    expect(parseArgs(["abc", "--zip", "pack.zip"])).toMatchObject({
      championshipId: "abc",
      zip: "pack.zip",
      push: false,
    })
  })

  it("defaults to a preview", () => {
    // The destructive option is the one you have to type, not the one you
    // forget to turn off.
    expect(parseArgs(["abc", "--zip", "p.zip"]).push).toBe(false)
    expect(parseArgs(["abc", "--zip", "p.zip", "--push"]).push).toBe(true)
  })

  it("reads a restart round", () => {
    expect(parseArgs(["abc", "--zip", "p.zip", "--restart", "2"]).restart).toBe(2)
  })

  it("refuses a restart round that is not a round number", () => {
    for (const bad of ["0", "-1", "two", "1.5", ""]) {
      expect(() => parseArgs(["abc", "--zip", "p.zip", "--restart", bad]), bad).toThrowError(
        UsageError,
      )
    }
  })

  it("refuses an option value that is obviously another option", () => {
    // `--zip --push` would otherwise read "--push" as a filename and silently
    // drop the flag, so the write never happens and nothing says why.
    expect(() => parseArgs(["abc", "--zip", "--push"])).toThrowError(/looks like another option/)
  })

  it("refuses an unknown option", () => {
    expect(() => parseArgs(["abc", "--zip", "p.zip", "--force"])).toThrowError(
      /Unknown option --force/,
    )
  })

  it("refuses a second positional, which is usually a forgotten --zip", () => {
    expect(() => parseArgs(["abc", "pack.zip"])).toThrowError(/The pack goes after --zip/)
  })

  it("prints usage on --help without needing anything else", () => {
    expect(parseArgs(["--help"])).toMatchObject({ help: true })
  })
})

describe("rendering a livery plan", () => {
  const champ = (entrants: Partial<Entrant>[], events = [raceEvent({ EntryList: {} })]) =>
    championship({
      Name: "September 2026",
      Classes: [championshipClass({ Entrants: entryList(entrants) })],
      Events: events,
    })

  const packOf = (...drivers: string[]) =>
    readLiveryPack(zipSync(Object.fromEntries(drivers.map((d) => [`${CAR}/${d}.zip`, skin()]))))

  it("shows the skin each driver moves from and to", () => {
    const plan = planLiveries(
      champ([person({ Name: "Misha", Skin: "misha_old" })]),
      "champ-1",
      packOf("Misha"),
    )
    const out = renderPlan(plan)
    expect(out).toContain("September 2026 — liveries")
    expect(out).toContain("misha_old → Misha")
  })

  it("says (no skin) rather than printing nothing", () => {
    const plan = planLiveries(champ([person({ Name: "Misha" })]), "champ-1", packOf("Misha"))
    expect(renderPlan(plan)).toContain("(no skin) → Misha")
  })

  it("marks an already-assigned driver as a file replacement, not as nothing", () => {
    // Both drivers are in the run. The difference the preview has to show is
    // what each one does: postaL's row changes the entry list, Misha's replaces
    // the files the entry list already points at. Reading "nothing to do" next
    // to a driver whose livery is in the pack is how a corrected livery got
    // left on the cutting-room floor.
    const plan = planLiveries(
      champ([person({ Name: "Misha", Skin: "Misha" }), person({ Name: "postaL" })]),
      "champ-1",
      packOf("Misha", "postaL"),
    )
    const out = renderPlan(plan)
    expect(out).toMatch(/Misha\s+Misha \(already assigned, files replaced\)/)
    expect(out).toContain("1 of 2 changes the entry list")
    expect(out).toContain("(no skin) → postaL")
    expect(out).toContain("1 of 2")
  })

  it("warns loudly about a round the change would not reach", () => {
    // The failure this exists to prevent: the write lands in the database and
    // the race still runs the old livery.
    const uuid = "11111111-1111-1111-1111-111111111111"
    const plan = planLiveries(
      champ(
        [person({ Name: "Misha", InternalUUID: uuid })],
        [
          raceEvent({
            EntryList: entryList([person({ Name: "Misha", InternalUUID: uuid })]),
          }),
        ],
      ),
      "champ-1",
      packOf("Misha"),
    )
    expect(renderPlan(plan)).toContain("Rounds 1 keep their own entry-list skins")
  })

  it("says nothing about unreachable rounds when there are none", () => {
    const plan = planLiveries(champ([person({ Name: "Misha" })]), "champ-1", packOf("Misha"))
    expect(renderPlan(plan)).not.toContain("keep their own entry-list skins")
  })

  it("mentions rounds that have already been raced, and that it is cosmetic", () => {
    const plan = planLiveries(
      champ(
        [person({ Name: "Misha" })],
        [
          raceEvent({
            EntryList: {},
            StartedTime: "2026-09-02T20:00:00Z",
            CompletedTime: "2026-09-02T21:00:00Z",
            Sessions: { RACE: { Name: "Race", Results: { Type: "RACE" } } },
          }),
        ],
      ),
      "champ-1",
      packOf("Misha"),
    )
    expect(renderPlan(plan)).toContain("Rounds 1 have already been raced")
  })

  it("says nothing about racing when only the practice server has run", () => {
    // The output Misha saw: round 1 untouched, its looping practice live, and
    // champctl announcing it had been raced.
    const plan = planLiveries(
      champ(
        [person({ Name: "Misha" })],
        [raceEvent({ EntryList: {}, StartedTime: "2026-09-02T19:00:00Z" })],
      ),
      "champ-1",
      packOf("Misha"),
    )
    expect(renderPlan(plan)).not.toContain("already been raced")
  })

  it("names the practice restart when one was asked for", () => {
    const plan = planLiveries(champ([person({ Name: "Misha" })]), "champ-1", packOf("Misha"))
    expect(renderPlan(plan, 2)).toContain("restart round 2's looping practice server")
    expect(renderPlan(plan)).not.toContain("looping practice server")
  })

  it("says the championship goes unwritten when no assignment changes", () => {
    // Not "nothing to do" — the files still go up. What is skipped is the
    // championship POST, which is a whole-championship replace and not
    // something to do for no reason.
    const plan = planLiveries(
      champ([person({ Name: "Misha", Skin: "Misha" })]),
      "champ-1",
      packOf("Misha"),
    )
    const out = renderPlan(plan)
    expect(out).toContain("Every skin is already assigned")
    expect(out).toContain("the championship is not written")
  })
})

describe("what an error means for the exit code", () => {
  it("calls a refusal a 2 and a failure a 3", () => {
    expect(exitFor(new LiveryPackError("x"))?.code).toBe(2)
    expect(exitFor(new LiveryPlanError("x"))?.code).toBe(2)
    expect(exitFor(new RosterChangedError("x"))?.code).toBe(2)
    expect(exitFor(new MultiClassError(2))?.code).toBe(2)
    expect(exitFor(new PracticeRestartError(1, new Error("x")))?.code).toBe(3)
    expect(exitFor(new LiveryApplyError("x"))?.code).toBe(3)
    expect(exitFor(new AcsmError("x"))?.code).toBe(3)
  })

  it("matches the LiveryApplyError subclasses before LiveryApplyError itself", () => {
    // The part of the mapping that is invisible in the source and breaks
    // silently: all three of these *are* LiveryApplyErrors, so a branch order
    // that reaches the general case first turns every refusal into a 3 telling
    // somebody to report a bug about a championship champctl simply won't write.
    expect(new MultiClassError(2)).toBeInstanceOf(LiveryApplyError)
    expect(new RosterChangedError("x")).toBeInstanceOf(LiveryApplyError)
    expect(new PracticeRestartError(1, new Error("x"))).toBeInstanceOf(LiveryApplyError)
    expect(exitFor(new MultiClassError(2))?.code).toBe(2)
    expect(exitFor(new RosterChangedError("x"))?.code).toBe(2)
  })

  it("leaves a usage mistake to the usage block", () => {
    expect(exitFor(new UsageError("x"))).toBeUndefined()
  })

  it("says where an ACSM error came from", () => {
    expect(exitFor(new AcsmError("500 from /championships"))?.message).toBe(
      "ACSM: 500 from /championships",
    )
  })

  it("no longer has an exit code for a pack that changes nothing", () => {
    // The pack is always uploaded now, so an apply never does nothing and the
    // help must not offer a code for it.
    //
    // Exit 1 has since come back for a different question — an empty queue, no
    // recorded liveries, no claims — which is a real state a script wants to
    // branch on rather than the vanished one. So this checks the meaning is
    // gone rather than the digit.
    expect(USAGE).not.toContain("nothing to do")
    expect(USAGE).not.toContain("already assigned")
    expect(USAGE).toContain("  1  nothing there")
  })
})

describe("champctl-liveries --carset", () => {
  const CHAMP = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

  const scratch = async () => {
    const dir = await mkdtemp(join(tmpdir(), "champctl-carset-"))
    return { dir, db: join(dir, "liveries.db"), out: join(dir, "carset.zip") }
  }

  const captureStdout = () => {
    const written: string[] = []
    const original = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    return { written, restore: () => (process.stdout.write = original) }
  }

  it("parses the flags", () => {
    expect(parseArgs(["abc", "--carset", "out.zip", "--store", "s.db"])).toMatchObject({
      championshipId: "abc",
      carset: "out.zip",
      store: "s.db",
      noStore: false,
    })
    expect(parseArgs(["abc", "--zip", "p.zip", "--no-store"]).noStore).toBe(true)
  })

  it("refuses to upload and build a carset in one run", async () => {
    // They are opposite directions: one writes to the server, the other writes
    // a file for drivers out of what the server already has.
    expect(await main(["abc", "--zip", "p.zip", "--carset", "out.zip"])).toBe(3)
  })

  it("writes an archive Content Manager can install, from what was recorded", async () => {
    const { db, out } = await scratch()
    const store = await SqliteLiveryStore.open(db)
    await store.record(
      CHAMP,
      [
        {
          carModel: CAR,
          driverName: "Misha",
          skinFolder: "Misha",
          files: [
            { name: "livery.dds", bytes: bytes("pixels") },
            { name: "preview.jpg", bytes: bytes("jpeg") },
          ],
          totalBytes: 10,
        },
      ],
      new Date(),
      "zip",
    )
    store.close()

    const out1 = captureStdout()
    const code = await main([CHAMP, "--carset", out, "--store", db])
    out1.restore()

    expect(code).toBe(0)
    const entries = unzipSync(new Uint8Array(await readFile(out)))
    expect(Object.keys(entries)).toContain(`content/cars/${CAR}/skins/Misha/livery.dds`)
    expect(out1.written.join("")).toContain("Content Manager")
  })

  it("exits 1 with an explanation when nothing has been recorded", async () => {
    const { db, out } = await scratch()
    expect(await main([CHAMP, "--carset", out, "--store", db])).toBe(1)
  })

  it("says which drivers will show as blank tiles", async () => {
    const { db, out } = await scratch()
    const store = await SqliteLiveryStore.open(db)
    await store.record(
      CHAMP,
      [
        {
          carModel: CAR,
          driverName: "Bob",
          skinFolder: "Bob",
          files: [{ name: "livery.dds", bytes: bytes("x") }],
          totalBytes: 1,
        },
      ],
      new Date(),
      "zip",
    )
    store.close()

    const captured = captureStdout()
    await main([CHAMP, "--carset", out, "--store", db])
    captured.restore()
    expect(captured.written.join("")).toMatch(/No preview.jpg for Bob/)
  })
})

describe("champctl-liveries --claims", () => {
  const CHAMP = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
  const MISHA = "111111111111111111"

  const scratch = async () => {
    const dir = await mkdtemp(join(tmpdir(), "champctl-claims-"))
    return { db: join(dir, "liveries.db") }
  }

  const captureStdout = () => {
    const written: string[] = []
    const original = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    return { written, restore: () => (process.stdout.write = original) }
  }

  const roster = () =>
    championship({
      Name: "September 2026",
      Classes: [championshipClass({ Entrants: entryList([person({ Name: "Misha" })]) })],
    })

  it("parses the flags", () => {
    expect(parseArgs(["abc", "--claims"]).claims).toBe(true)
    expect(parseArgs(["abc", "--release", MISHA]).release).toBe(MISHA)
  })

  it("won't list claims and upload in the same run", async () => {
    expect(await main(["abc", "--claims", "--zip", "p.zip"])).toBe(3)
  })

  it("lists who is claimed as whom, with the sign-up beside it", async () => {
    const { db } = await scratch()
    const store = await SqliteClaimStore.open(db)
    await store.claim(CHAMP, roster(), "Misha", MISHA, { discordHandle: "misha" })
    await store.rememberHandleHint("Misha", "someone_else", new Date())
    store.close()

    const out = captureStdout()
    const code = await main([CHAMP, "--claims", "--store", db])
    out.restore()

    expect(code).toBe(0)
    expect(out.written.join("")).toContain("Misha")
    expect(out.written.join("")).toMatch(/sign-up says "someone_else"/)
  })

  it("exits 1 and says why when nobody has claimed anything", async () => {
    const { db } = await scratch()
    const out = captureStdout()
    const code = await main([CHAMP, "--claims", "--store", db])
    out.restore()
    expect(code).toBe(1)
    expect(out.written.join("")).toMatch(/nobody can upload a livery through Discord/)
  })

  it("releases a claim and says the name is free", async () => {
    const { db } = await scratch()
    const store = await SqliteClaimStore.open(db)
    await store.claim(CHAMP, roster(), "Misha", MISHA)
    store.close()

    const out = captureStdout()
    const code = await main([CHAMP, "--release", MISHA, "--push", "--yes", "--store", db])
    out.restore()

    expect(code).toBe(0)
    expect(out.written.join("")).toMatch(/free for someone else to claim/)
  })

  it("previews a release rather than doing it without --push", async () => {
    // Irreversible, leaves no audit row, and frees the name for anyone to
    // take — so a mistyped-but-valid Discord id was the one mistake in this
    // CLI that handed somebody else a driver's identity.
    const { db } = await scratch()
    const store = await SqliteClaimStore.open(db)
    await store.claim(CHAMP, roster(), "Misha", MISHA)
    store.close()

    const out = captureStdout()
    const code = await main([CHAMP, "--release", MISHA, "--store", db])
    out.restore()

    expect(code).toBe(0)
    expect(out.written.join("")).toMatch(/Re-run with --push/)

    const after = await SqliteClaimStore.open(db)
    expect(await after.forDiscordUser(CHAMP, MISHA)).toMatchObject({ entrantName: "Misha" })
    after.close()
  })

  it("exits 1 releasing an account that holds nothing", async () => {
    const { db } = await scratch()
    expect(await main([CHAMP, "--release", MISHA, "--store", db])).toBe(1)
  })
})
