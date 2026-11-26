import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { SqliteRecorderAlerts } from "../src/spectator/alerts.js"

let dir: string
let s: SqliteRecorderAlerts
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "recorder-alerts-"))
  s = await SqliteRecorderAlerts.open(join(dir, "store.db"))
})
afterEach(async () => {
  s.close()
  await rm(dir, { recursive: true, force: true })
})

const T0 = Date.parse("2026-11-26T20:00:00Z")
const at = (minutes: number) => new Date(T0 + minutes * 60_000)
const HOUR = 60
const kinds = (minutes: number) => s.due(at(minutes)).map((a) => `${a.kind} ${a.message}`)

describe("recorder alerts", () => {
  it("is owed a post when raised, with the latest message, then not for a day", () => {
    s.raise("join", "first", at(0))
    s.raise("join", "second", at(1))
    const [a] = s.due(at(1))
    expect(a).toMatchObject({ key: "join", kind: "open", message: "second" })
    s.told(a!, at(1))
    expect(kinds(2)).toEqual([])
    expect(kinds(24 * HOUR)).toEqual([])
    expect(kinds(24 * HOUR + 1)).toEqual(["open second"])
  })

  it("owes word of a resolution only once the alert was posted", () => {
    s.raise("join", "m", at(0))
    s.resolve("join", at(1))
    expect(kinds(2), "resolved before anyone was told").toEqual([])

    s.raise("join", "m", at(3))
    s.told(s.due(at(3))[0]!, at(3))
    s.resolve("join", at(4))
    const [r] = s.due(at(4))
    expect(r?.kind).toBe("resolved")
    s.told(r!, at(4))
    expect(kinds(5)).toEqual([])
    expect(kinds(48 * HOUR)).toEqual([])
  })

  it("starts over when reopened after resolving", () => {
    s.raise("join", "old", at(0))
    s.told(s.due(at(0))[0]!, at(0))
    s.resolve("join", at(1))
    s.told(s.due(at(1))[0]!, at(1))
    s.raise("join", "new", at(2))
    expect(kinds(2)).toEqual(["open new"])
    s.told(s.due(at(2))[0]!, at(2))
    s.resolve("join", at(3))
    expect(kinds(3), "its resolution owed again").toEqual(["resolved new"])
  })

  it("doesn't mark a reopened alert told by a post of the earlier opening", () => {
    s.raise("join", "old", at(0))
    s.told(s.due(at(0))[0]!, at(0))
    s.resolve("join", at(1))
    const resolution = s.due(at(1))[0]!
    s.raise("join", "new", at(2))
    s.told(resolution, at(2))
    expect(kinds(2)).toEqual(["open new"])
    const stale = { ...s.due(at(2))[0]!, openedAt: T0 }
    s.told(stale, at(2))
    expect(kinds(3)).toEqual(["open new"])
  })

  it("owes the resolution of an alert that resolved while its post was going out", () => {
    s.raise("join", "m", at(0))
    const a = s.due(at(0))[0]!
    s.resolve("join", at(1))
    s.told(a, at(1))
    expect(kinds(1)).toEqual(["resolved m"])
  })

  it("keeps alerts across a reopened store", async () => {
    s.raise("join", "m", at(0))
    s.close()
    s = await SqliteRecorderAlerts.open(join(dir, "store.db"))
    expect(kinds(0)).toEqual(["open m"])
  })
})
