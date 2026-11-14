import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"

import { INCIDENT_MIGRATIONS, SqliteIncidentStore } from "../src/incidents/store.js"
import { migrate } from "../src/sqlite.js"

const temps: string[] = []
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

const AT = new Date("2026-11-12T04:30:00.000Z")
const filing = {
  reporterDiscord: "100",
  reporter: "Ana",
  other: "Bea",
  journal: "2026-11-11-vir/race.ndjson.gz",
  atMs: 60_000,
  description: "Into turn 1",
}

describe("incident drafts", () => {
  it("are numbered once, however often opening is tried, and become the incident", async () => {
    const store = await SqliteIncidentStore.open(":memory:")
    const d = store.draft({ ...filing, otherDiscord: "200" }, AT)
    store.setDraftChannel(d.id, "c1")
    const first = store.reserve(d.id, AT)
    const again = store.reserve(d.id, AT)
    expect(again?.number).toBe(first?.number)
    expect(store.list()).toEqual([])

    expect(store.withdraw(d.id)).toBe(false)
    expect(store.opened(d.id)).toBe(true)
    expect(store.draftById(d.id)).toBeUndefined()
    expect(store.byChannel("c1")).toMatchObject({ number: first?.number, otherDiscord: "200" })
  })

  it("are found by the moment they report, and only their reporter's", async () => {
    const store = await SqliteIncidentStore.open(":memory:")
    const d = store.draft(filing, AT)
    expect(store.draftOf("100", filing.journal, 64_000)?.id).toBe(d.id)
    expect(store.draftOf("100", filing.journal, 66_000)).toBeUndefined()
    expect(store.draftOf("101", filing.journal, 60_000)).toBeUndefined()
    expect(store.opened(d.id)).toBe(false)
    expect(store.withdraw(d.id)).toBe(true)
    expect(store.draftOf("100", filing.journal, 60_000)).toBeUndefined()
  })

  it("go stale after a day, or at once when being opened", async () => {
    const store = await SqliteIncidentStore.open(":memory:")
    const old = store.draft(filing, new Date(AT.getTime() - 25 * 3600_000))
    const opening = store.draft({ ...filing, atMs: 0 }, AT)
    store.reserve(opening.id, AT)
    store.draft({ ...filing, atMs: 9000 }, new Date(AT.getTime() - 23 * 3600_000))
    expect(store.staleDrafts(new Date(AT.getTime() - 24 * 3600_000)).map((d) => d.id)).toEqual([
      old.id,
      opening.id,
    ])
  })

  it("count toward their reporter's open reports, once each", async () => {
    const store = await SqliteIncidentStore.open(":memory:")
    const d = store.draft(filing, AT)
    store.draft({ ...filing, atMs: 0 }, AT)
    store.draft({ ...filing, reporterDiscord: "101" }, AT)
    expect(store.openCount("100")).toBe(2)
    store.setDraftChannel(d.id, "c1")
    store.reserve(d.id, AT)
    expect(store.openCount("100")).toBe(2)
    store.opened(d.id)
    expect(store.openCount("100")).toBe(2)
  })

  it("leave a database an older champctl, without them, can still open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "champctl-incidents-"))
    temps.push(dir)
    const path = join(dir, "db.sqlite")
    ;(await SqliteIncidentStore.open(path)).close()
    const db = new DatabaseSync(path)
    // 2: the incidents schema of the release before drafts.
    try {
      expect(() => migrate(db, "incidents", INCIDENT_MIGRATIONS.slice(0, 2))).not.toThrow()
    } finally {
      db.close()
    }
  })
})
