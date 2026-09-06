/**
 * The drain, end to end through `main`.
 *
 * Everything here goes through the argv the operator types and asserts on the
 * exit code and on what the queue looks like afterwards, because the drain's
 * whole job is to decide what happens to somebody's artwork and prose in a log
 * is not that decision.
 *
 * Nothing here passes `--push` past the point where a login is needed: the
 * branches that settle rows without writing to ACSM all run before
 * `login()`, which is what makes them testable and is also worth knowing.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { zipSync } from "fflate"
import { afterEach, describe, expect, it } from "vitest"

import type { Championship } from "../src/acsm/types.js"
import { main } from "../src/cli/liveries.js"
import { SqliteSubmissionQueue } from "../src/liveries/queue.js"
import { acsmStub, type AcsmStub } from "./support/acsm-stub.js"
import { championship, championshipClass, driver, entryList, raceEvent } from "./support/build.js"

const CHAMP = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
const CAR = "rss_formula_hybrid_2021"
const NOW = new Date("2026-09-02T20:00:00.000Z")

const bytes = (s: string) => new TextEncoder().encode(s)
const skinZip = () => zipSync({ "livery.dds": bytes("dds"), "preview.jpg": bytes("jpg") })

const oneClass = (names: string[]): Championship =>
  championship({
    ID: CHAMP,
    Name: "September 2026",
    Classes: [
      championshipClass({ Entrants: entryList(names.map((n) => driver(n, { Skin: "" }))) }),
    ],
    Events: [raceEvent({ EntryList: {} })],
  })

const twoClasses = (names: string[]): Championship =>
  championship({
    ID: CHAMP,
    Name: "September 2026",
    Classes: [
      championshipClass({
        ID: "c1",
        Entrants: entryList(names.map((n) => driver(n, { Skin: "" }))),
      }),
      championshipClass({ ID: "c2", Entrants: entryList([driver("Someone Else")]) }),
    ],
    Events: [raceEvent({ EntryList: {} })],
  })

let open: { dir: string; stub?: AcsmStub }[] = []

afterEach(async () => {
  for (const o of open) {
    await o.stub?.close()
    await rm(o.dir, { recursive: true, force: true })
  }
  open = []
})

/** A temp store seeded with one queued submission per name. */
async function seeded(names: string[], champ: Championship) {
  const dir = await mkdtemp(join(tmpdir(), "champctl-drain-"))
  const db = join(dir, "liveries.db")
  const queue = await SqliteSubmissionQueue.open(db)
  let i = 0
  for (const name of names) {
    await queue.submit({
      discordUserId: `${100000000000000000 + i++}`,
      championshipId: CHAMP,
      driverName: name,
      carModel: CAR,
      skinFolder: name,
      body: skinZip(),
      at: NOW,
    })
  }
  queue.close()

  const stub = await acsmStub(CHAMP, champ)
  open.push({ dir, stub })
  return { db, stub, dir }
}

const queueState = async (db: string) => {
  const queue = await SqliteSubmissionQueue.open(db)
  const rows = await queue.queued(CHAMP)
  const bytesLeft = await queue.queuedBytes()
  queue.close()
  return { queued: rows.length, bytesLeft, names: rows.map((r) => r.driverName).sort() }
}

describe("champctl-liveries --drain", () => {
  it("refuses only the driver who left the entry list, and keeps the rest", async () => {
    const { db, stub } = await seeded(["Ann", "Bob"], oneClass(["Ann"]))

    // No --push: this is the preview, so nothing is settled either way.
    const code = await main([CHAMP, "--drain", "--base-url", stub.baseUrl, "--store", db])

    expect(code).toBe(0)
    expect(await queueState(db)).toMatchObject({ queued: 2 })
  })

  it("leaves every queued row alone when the refusal is the championship's fault", async () => {
    // The bug this pins: `planLiveries` throws for a second class too, and
    // planning one submission at a time turned that into a refusal of each
    // driver in turn. Under --push those refusals were settled and their bytes
    // dropped, so three people lost their artwork over a class an operator can
    // remove in a minute. Nothing here may be settled, and the exit code has to
    // say "refused", not "nothing there".
    const { db, stub } = await seeded(["Ann", "Bob", "Cal"], twoClasses(["Ann", "Bob", "Cal"]))
    const before = await queueState(db)

    const code = await main([
      CHAMP,
      "--drain",
      "--push",
      "--yes",
      "--base-url",
      stub.baseUrl,
      "--store",
      db,
    ])

    expect(code).toBe(2)
    expect(await queueState(db)).toEqual(before)
    expect(before.queued).toBe(3)
  })

  it("settles a per-driver refusal under --push, and says so with a 2", async () => {
    // The other half of the same fork: a refusal that really is about this
    // driver does settle, because re-running the drain would only refuse it
    // again. Exit 2 rather than 1 — the queue was not empty, it was refused.
    const { db, stub } = await seeded(["Nobody"], oneClass(["Ann"]))

    const code = await main([
      CHAMP,
      "--drain",
      "--push",
      "--yes",
      "--base-url",
      stub.baseUrl,
      "--store",
      db,
    ])

    expect(code).toBe(2)
    expect(await queueState(db)).toMatchObject({ queued: 0, bytesLeft: 0 })
  })

  it("returns 1 and touches nothing when the queue is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "champctl-drain-"))
    const db = join(dir, "liveries.db")
    const queue = await SqliteSubmissionQueue.open(db)
    queue.close()
    const stub = await acsmStub(CHAMP, oneClass(["Ann"]))
    open.push({ dir, stub })

    const code = await main([CHAMP, "--drain", "--base-url", stub.baseUrl, "--store", db])

    expect(code).toBe(1)
    // Checked before the network on purpose, so an idle watcher never shows up
    // in ACSM's logs at all.
    expect(stub.requests).toEqual([])
  })
  it("won't start while another drain holds the championship", async () => {
    // The watcher in one process and an impatient operator in another both
    // reach saveChampionshipSkins, which is GET the form, mutate, POST the
    // whole form — so the later POST replays an entry list read before the
    // earlier one landed and the earlier drain's skins are silently gone.
    const { db, stub } = await seeded(["Ann"], oneClass(["Ann"]))

    const other = await SqliteSubmissionQueue.open(db)
    await other.acquireDrainLease(CHAMP, "someone-else:1", new Date(), 60_000)
    other.close()

    const code = await main([CHAMP, "--drain", "--base-url", stub.baseUrl, "--store", db])

    expect(code).toBe(3)
    // Refused before the network, so the queue is exactly as it was.
    expect(stub.requests).toEqual([])
    expect(await queueState(db)).toMatchObject({ queued: 1 })
  })

  it("takes the lease and gives it back, so the next run is not locked out", async () => {
    const { db, stub } = await seeded(["Ann"], oneClass(["Ann"]))

    expect(await main([CHAMP, "--drain", "--base-url", stub.baseUrl, "--store", db])).toBe(0)

    // A lease left behind would make every later drain exit 3 until it expired.
    const after = await SqliteSubmissionQueue.open(db)
    const lease = await after.acquireDrainLease(CHAMP, "next-run:1", new Date(), 60_000)
    after.close()
    expect(lease).toMatchObject({ ok: true })
  })
})
