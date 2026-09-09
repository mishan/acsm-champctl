import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { describe, expect, it } from "vitest"

import type { Entrant } from "../src/acsm/types.js"
import {
  SqliteClaimStore,
  claimAnnouncement,
  claimProblem,
  resolveUploader,
  type DriverClaim,
} from "../src/liveries/claims.js"
import { championship, championshipClass, entryList } from "./support/build.js"

const CAR = "rss_formula_hybrid_2021"
const CHAMP = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
const MISHA = "111111111111111111"
const IMPOSTOR = "222222222222222222"

const person = (over: Partial<Entrant>): Partial<Entrant> => ({ Model: CAR, Skin: "", ...over })

const champ = (names: string[] = ["Misha", "postaL", "Shoebacca"]) =>
  championship({
    Name: "September 2026",
    Classes: [championshipClass({ Entrants: entryList(names.map((Name) => person({ Name }))) })],
  })

const claim = (over: Partial<DriverClaim> = {}): DriverClaim => ({
  championshipId: CHAMP,
  discordUserId: MISHA,
  entrantName: "Misha",
  discordHandle: "misha",
  claimedAt: "2026-09-01T20:00:00.000Z",
  ...over,
})

describe("claimProblem", () => {
  it("allows a name that is on the entry list", () => {
    expect(claimProblem(champ(), "Misha", MISHA, undefined)).toBeUndefined()
  })

  it("refuses a name that isn't on the entry list", () => {
    expect(claimProblem(champ(), "Nobody", MISHA, undefined)).toMatch(/isn't on the entry list/)
  })

  it("points at the near miss when the name differs only in case", () => {
    // The same mistake the livery plan sees, against the same list, so it gets
    // the same help rather than a second wording of it.
    const problem = claimProblem(champ(), "misha", MISHA, undefined)
    expect(problem).toMatch(/"Misha"/)
    expect(problem).toMatch(/differs only in case or spacing/)
  })

  it("refuses an empty name with the instruction rather than a near-miss list", () => {
    expect(claimProblem(champ(), "  ", MISHA, undefined)).toMatch(/exactly as it appears/)
  })

  it("matches an entrant name whose accents are decomposed", () => {
    // A driver typing on a Mac sends the decomposed form of the same text.
    expect(claimProblem(champ(["Häkkinen"]), "Ha\u0308kkinen", MISHA, undefined)).toBeUndefined()
  })

  /**
   * Found here rather than at upload time, on purpose.
   *
   * ACSM stores names champctl cannot turn into a folder, so this is reachable
   * with nobody having done anything wrong — and the worst moment to learn that
   * only an admin can fix it is while holding a zip.
   */
  it("refuses a name ACSM allows but champctl can't make a folder from", () => {
    const problem = claimProblem(champ([".hidden"]), ".hidden", MISHA, undefined)
    expect(problem).toMatch(/can't be one/)
    expect(problem).toMatch(/An admin has to rename/)
    expect(problem).toMatch(/nothing you can do from here/)
  })

  it("refuses a name another account already holds", () => {
    expect(claimProblem(champ(), "Misha", IMPOSTOR, claim())).toMatch(/already been claimed/)
  })

  it("does not say who holds it", () => {
    // Whoever this is already knows, or is trying it on. Handing them the
    // account that owns the name is not champctl's job either way.
    const problem = claimProblem(champ(), "Misha", IMPOSTOR, claim()) ?? ""
    expect(problem).not.toContain(MISHA)
    expect(problem).not.toContain("misha")
  })

  it("lets an account re-claim the name it already holds", () => {
    expect(claimProblem(champ(), "Misha", MISHA, claim())).toBeUndefined()
  })
})

describe("claimAnnouncement", () => {
  it("names the account and the entrant", () => {
    const line = claimAnnouncement(claim())
    expect(line).toContain("misha")
    expect(line).toContain(MISHA)
    expect(line).toContain("Misha")
  })

  it("says when the sign-up handle agrees", () => {
    const line = claimAnnouncement(claim(), {
      hint: { entrantName: "Misha", handle: "misha", seenAt: "2026-08-01T00:00:00.000Z" },
    })
    expect(line).toMatch(/Matches the Discord handle on their sign-up/)
  })

  it("flags a mismatch for a human without calling it fraud", () => {
    // People change handles, and the sign-up answer is overwritable by anyone
    // who knows a public Steam id. A mismatch is evidence, not proof.
    const line = claimAnnouncement(claim(), {
      hint: { entrantName: "Misha", handle: "someone_else", seenAt: "2026-08-01T00:00:00.000Z" },
    })
    expect(line).toMatch(/not the account that claimed/)
    expect(line).toMatch(/Worth a look/)
  })

  it("says plainly when there is nothing to compare against", () => {
    expect(claimAnnouncement(claim())).toMatch(/No Discord handle on their sign-up/)
  })

  it("compares handles case-insensitively", () => {
    const line = claimAnnouncement(claim({ discordHandle: "Misha" }), {
      hint: { entrantName: "Misha", handle: "misha", seenAt: "2026-08-01T00:00:00.000Z" },
    })
    expect(line).toMatch(/Matches/)
  })
})

describe("SqliteClaimStore", () => {
  const open = () => SqliteClaimStore.open(":memory:")

  it("records a claim and finds it both ways round", async () => {
    const store = await open()
    const result = await store.claim(CHAMP, champ(), "Misha", MISHA, { discordHandle: "misha" })
    expect(result.ok).toBe(true)

    expect(await store.forDiscordUser(CHAMP, MISHA)).toMatchObject({ entrantName: "Misha" })
    expect(await store.forEntrant(CHAMP, "Misha")).toMatchObject({ discordUserId: MISHA })
    store.close()
  })

  it("refuses a second account claiming the same driver", async () => {
    const store = await open()
    await store.claim(CHAMP, champ(), "Misha", MISHA)
    const second = await store.claim(CHAMP, champ(), "Misha", IMPOSTOR)
    expect(second).toMatchObject({ ok: false })
    expect(await store.forEntrant(CHAMP, "Misha")).toMatchObject({ discordUserId: MISHA })
    store.close()
  })

  it("leaves nothing behind when it refuses", async () => {
    const store = await open()
    expect(await store.claim(CHAMP, champ(), "Nobody", MISHA)).toMatchObject({ ok: false })
    expect(await store.list(CHAMP)).toEqual([])
    store.close()
  })

  it("sends an account that wants a different name to an admin", async () => {
    // Entrant names are per championship, so a driver who races as "Misha" in
    // September and "Misha [BATL]" in October does have to move. Doing it
    // themselves released the old name as a side effect, and §2 says re-claim
    // is operator-only for exactly that reason.
    const store = await open()
    await store.claim(CHAMP, champ(), "Misha", MISHA)
    const moved = await store.claim(CHAMP, champ(["Misha [BATL]"]), "Misha [BATL]", MISHA)

    expect(moved).toMatchObject({ ok: false })
    expect((moved as { reason: string }).reason).toMatch(/already claimed as "Misha"/)
    store.close()
  })

  it("does not free the old name for somebody else on the way", async () => {
    // The impersonation this closes: take an unclaimed name, drop your own,
    // and the name you had raced under is open for anyone.
    const store = await open()
    await store.claim(CHAMP, champ(), "Misha", MISHA)
    await store.claim(CHAMP, champ(["Misha [BATL]", "Misha"]), "Misha [BATL]", MISHA)
    expect(await store.claim(CHAMP, champ(), "Misha", IMPOSTOR)).toMatchObject({ ok: false })
    expect(await store.forEntrant(CHAMP, "Misha")).toMatchObject({ discordUserId: MISHA })
    store.close()
  })

  it("still moves an account once an admin has released the old claim", async () => {
    const store = await open()
    await store.claim(CHAMP, champ(), "Misha", MISHA)
    await store.release(CHAMP, MISHA)
    expect(await store.claim(CHAMP, champ(["Misha [BATL]"]), "Misha [BATL]", MISHA)).toMatchObject({
      ok: true,
    })
    store.close()
  })

  it("re-claiming the same name is not reported as a replacement", async () => {
    const store = await open()
    await store.claim(CHAMP, champ(), "Misha", MISHA)
    const again = await store.claim(CHAMP, champ(), "Misha", MISHA)
    expect(again).toEqual({ ok: true, claim: expect.objectContaining({ entrantName: "Misha" }) })
    store.close()
  })

  it("normalises the stored name, so a decomposed claim resolves later", async () => {
    const store = await open()
    await store.claim(CHAMP, champ(["Häkkinen"]), "Ha\u0308kkinen", MISHA)
    expect(await store.forDiscordUser(CHAMP, MISHA)).toMatchObject({ entrantName: "Häkkinen" })
    store.close()
  })

  it("releases a claim so the name is free again", async () => {
    const store = await open()
    await store.claim(CHAMP, champ(), "Misha", MISHA)
    expect(await store.release(CHAMP, MISHA)).toMatchObject({ entrantName: "Misha" })
    expect(await store.forEntrant(CHAMP, "Misha")).toBeUndefined()
    expect(await store.claim(CHAMP, champ(), "Misha", IMPOSTOR)).toMatchObject({ ok: true })
    store.close()
  })

  it("releasing an account that holds nothing is not an error", async () => {
    const store = await open()
    expect(await store.release(CHAMP, MISHA)).toBeUndefined()
    store.close()
  })

  it("lists claims by entrant name", async () => {
    const store = await open()
    await store.claim(CHAMP, champ(), "Shoebacca", MISHA)
    await store.claim(CHAMP, champ(), "Misha", IMPOSTOR)
    expect((await store.list(CHAMP)).map((c) => c.entrantName)).toEqual(["Misha", "Shoebacca"])
    store.close()
  })

  it("keeps the sign-up hint apart from the claim", async () => {
    // Never consulted to decide anything: this column is overwritable by whoever
    // knows a public Steam id.
    const store = await open()
    await store.rememberHandleHint("Misha", "misha", new Date("2026-08-01T00:00:00.000Z"))
    expect(await store.handleHint("Misha")).toMatchObject({ handle: "misha" })
    expect(await store.forEntrant(CHAMP, "Misha")).toBeUndefined()

    // And it does not let anyone through: a hint is not a claim.
    expect(await store.claim(CHAMP, champ(), "Nobody", MISHA)).toMatchObject({ ok: false })
    store.close()
  })

  it("replaces a hint rather than accumulating them", async () => {
    const store = await open()
    await store.rememberHandleHint("Misha", "old_handle", new Date("2026-07-01T00:00:00.000Z"))
    await store.rememberHandleHint("Misha", "new_handle", new Date("2026-08-01T00:00:00.000Z"))
    expect(await store.handleHint("Misha")).toMatchObject({ handle: "new_handle" })
    store.close()
  })

  it("has no hint for an entrant nobody filled the question in for", async () => {
    const store = await open()
    expect(await store.handleHint("Misha")).toBeUndefined()
    store.close()
  })
})

describe("resolveUploader", () => {
  it("takes the car from the entrant, not from anything the submitter chose", async () => {
    // The whole point of the identity work: the CLI path reads a car model off
    // a folder name and has to refuse when it disagrees with the entry list.
    // Here that refusal is unreachable.
    expect(resolveUploader(champ(), claim())).toEqual({
      ok: true,
      uploader: { driverName: "Misha", carModel: CAR },
    })
  })

  it("tells an unclaimed driver exactly what to run", async () => {
    const result = resolveUploader(champ(), undefined)
    expect(result).toMatchObject({ ok: false })
    expect((result as { reason: string }).reason).toMatch(/\/livery claim/)
    expect((result as { reason: string }).reason).toMatch(/"misha" won't do/)
  })

  it("names the championship when a claim doesn't match its entry list", async () => {
    // Claims outlive a championship; entrant names do not. A driver in two
    // series needs to know which one they are missing from.
    const result = resolveUploader(champ(["postaL"]), claim())
    expect((result as { reason: string }).reason).toMatch(/September 2026/)
    expect((result as { reason: string }).reason).toMatch(/if your name changed/i)
  })

  it("refuses an entrant with no car assigned yet", async () => {
    // A sign-up slot before ACSM has replaced the any_car_model sentinel. The
    // livery would go somewhere no car will look for it.
    const c = championship({
      Name: "September 2026",
      Classes: [
        championshipClass({ Entrants: entryList([{ Name: "Misha", Model: "", Skin: "" }]) }),
      ],
    })
    expect((resolveUploader(c, claim()) as { reason: string }).reason).toMatch(/no car assigned/)
  })

  it("resolves through the store, end to end", async () => {
    const store = await SqliteClaimStore.open(":memory:")
    await store.claim(CHAMP, champ(), "Misha", MISHA, { discordHandle: "misha" })
    const resolved = resolveUploader(champ(), await store.forDiscordUser(CHAMP, MISHA))
    expect(resolved).toMatchObject({ ok: true, uploader: { carModel: CAR } })
    store.close()
  })
})

describe("claims are per championship", () => {
  const OTHER = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff"
  const open = () => SqliteClaimStore.open(":memory:")

  it("lets one account claim a name in each series", async () => {
    // A league running a second series had this silently replace the first
    // claim, and the driver's next upload there was refused with a message
    // about not being on the entry list — which points at the wrong problem.
    const store = await open()
    expect(await store.claim(CHAMP, champ(), "Misha", MISHA)).toMatchObject({ ok: true })
    expect(await store.claim(OTHER, champ(), "Misha", MISHA)).toMatchObject({ ok: true })
    expect(await store.forDiscordUser(CHAMP, MISHA)).toMatchObject({ entrantName: "Misha" })
    expect(await store.forDiscordUser(OTHER, MISHA)).toMatchObject({ entrantName: "Misha" })
    store.close()
  })

  it("lets two different people hold the same name in different series", async () => {
    const store = await open()
    await store.claim(CHAMP, champ(), "Misha", MISHA)
    expect(await store.claim(OTHER, champ(), "Misha", IMPOSTOR)).toMatchObject({ ok: true })
    store.close()
  })

  it("still refuses a second account in the same series", async () => {
    const store = await open()
    await store.claim(CHAMP, champ(), "Misha", MISHA)
    expect(await store.claim(CHAMP, champ(), "Misha", IMPOSTOR)).toMatchObject({ ok: false })
    store.close()
  })

  it("lists and releases only this series' claims", async () => {
    const store = await open()
    await store.claim(CHAMP, champ(), "Misha", MISHA)
    await store.claim(OTHER, champ(), "postaL", MISHA)

    expect((await store.list(CHAMP)).map((c) => c.entrantName)).toEqual(["Misha"])
    await store.release(CHAMP, MISHA)
    expect(await store.list(CHAMP)).toEqual([])
    expect((await store.list(OTHER)).map((c) => c.entrantName)).toEqual(["postaL"])
    store.close()
  })
})

describe("migrating a database written before claims were per championship", () => {
  const openGlobal = async (dir: string) => {
    const db = new DatabaseSync(join(dir, "liveries.db"))
    db.exec(`
      CREATE TABLE driver_discord (
        discord_user_id  TEXT PRIMARY KEY,
        entrant_name     TEXT NOT NULL,
        discord_handle   TEXT,
        claimed_at       TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX driver_discord_name ON driver_discord (entrant_name);
      CREATE TABLE signup_handle (
        entrant_name  TEXT PRIMARY KEY,
        handle        TEXT NOT NULL,
        seen_at       TEXT NOT NULL
      ) STRICT;
      INSERT INTO driver_discord VALUES ('${MISHA}', 'Misha', 'misha', '2026-09-01T20:00:00.000Z');
    `)
    db.close()
  }

  it("keeps the claim, rather than making everyone re-claim", async () => {
    // The only databases this can meet are ones champctl itself wrote, and a
    // migration that dropped their rows would silently un-claim a whole grid.
    const dir = await mkdtemp(join(tmpdir(), "champctl-claims-migrate-"))
    await openGlobal(dir)

    const store = await SqliteClaimStore.open(join(dir, "liveries.db"))
    expect(await store.forDiscordUser(CHAMP, MISHA)).toMatchObject({ entrantName: "Misha" })
    // Any championship, because the old row did not say which.
    expect(await store.forDiscordUser("some-other-championship", MISHA)).toMatchObject({
      entrantName: "Misha",
    })
    store.close()
    await rm(dir, { recursive: true, force: true })
  })

  it("lets a real claim take over from the carried-forward one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "champctl-claims-migrate-"))
    await openGlobal(dir)

    const store = await SqliteClaimStore.open(join(dir, "liveries.db"))
    expect(await store.claim(CHAMP, champ(), "Misha", MISHA)).toMatchObject({ ok: true })
    expect(await store.forDiscordUser(CHAMP, MISHA)).toMatchObject({ championshipId: CHAMP })
    store.close()
    await rm(dir, { recursive: true, force: true })
  })

  it("refuses a second account the name the carried-forward claim already holds", async () => {
    // claim() matched championship_id exactly, so the legacy row was invisible
    // to the holder check while forEntrant still resolved it — both accounts
    // then answered to "Misha" and could upload onto the same car.
    const dir = await mkdtemp(join(tmpdir(), "champctl-claims-migrate-"))
    await openGlobal(dir)

    const store = await SqliteClaimStore.open(join(dir, "liveries.db"))
    expect(await store.claim(CHAMP, champ(), "Misha", IMPOSTOR)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("already been claimed"),
    })
    expect(await store.forEntrant(CHAMP, "Misha")).toMatchObject({ discordUserId: MISHA })
    store.close()
    await rm(dir, { recursive: true, force: true })
  })

  it("holds the carried-forward claimant to the name they already have", async () => {
    const dir = await mkdtemp(join(tmpdir(), "champctl-claims-migrate-"))
    await openGlobal(dir)

    const store = await SqliteClaimStore.open(join(dir, "liveries.db"))
    expect(await store.claim(CHAMP, champ(), "postaL", MISHA)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("already claimed"),
    })
    store.close()
    await rm(dir, { recursive: true, force: true })
  })

  it("runs once, not on every open", async () => {
    const dir = await mkdtemp(join(tmpdir(), "champctl-claims-migrate-"))
    await openGlobal(dir)
    for (let i = 0; i < 3; i += 1) {
      const store = await SqliteClaimStore.open(join(dir, "liveries.db"))
      expect(await store.list(CHAMP)).toHaveLength(1)
      store.close()
    }
    await rm(dir, { recursive: true, force: true })
  })

  it("refuses a database from a newer champctl rather than writing to it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "champctl-claims-migrate-"))
    const path = join(dir, "liveries.db")
    const db = new DatabaseSync(path)
    db.exec(`
      CREATE TABLE champctl_schema (component TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT;
      INSERT INTO champctl_schema VALUES ('claims', 99);
    `)
    db.close()

    await expect(SqliteClaimStore.open(path)).rejects.toThrow(/newer version/)
    await rm(dir, { recursive: true, force: true })
  })
})
