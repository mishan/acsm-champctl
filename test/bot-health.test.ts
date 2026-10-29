import { describe, expect, it } from "vitest"

import { SqliteRestartStore, Watchdog } from "../src/bot/health.js"

const MINUTE = 60_000

describe("Watchdog", () => {
  it.each([
    ["ticks that keep failing", [false]],
    ["a tick that never ends", []],
  ])("gives up on %s after 30 minutes", (_, reports: boolean[]) => {
    let now = 0
    const dog = new Watchdog(() => now)
    const report = dog.watch("The quali call", MINUTE)
    for (now = MINUTE; now < 30 * MINUTE; now += MINUTE) for (const ok of reports) report(ok)
    expect(dog.stale()).toBeUndefined()
    now += MINUTE
    expect(dog.stale()).toMatch(/^The quali call has had no good tick for 31 minutes/)
  })

  it("keeps a working loop, and gives a slow one three of its intervals", () => {
    let now = 0
    const dog = new Watchdog(() => now)
    const quali = dog.watch("The quali call", MINUTE)
    dog.watch("The Racers watch", 15 * MINUTE)
    for (now = MINUTE; now < 45 * MINUTE; now += MINUTE) quali(true)
    expect(dog.stale()).toBeUndefined()
    now += MINUTE
    expect(dog.stale()).toMatch(/^The Racers watch/)
  })
})

describe("SqliteRestartStore", () => {
  it("waits longer after each exit, up to half an hour, and forgets once working", async () => {
    let now = 0
    const store = await SqliteRestartStore.open(":memory:", () => now)
    const waits = [store.waitMs()]
    for (let i = 0; i < 7; i++) {
      store.gaveUp()
      waits.push(store.waitMs())
    }
    expect(waits.map((w) => w / MINUTE)).toEqual([0, 1, 2, 4, 8, 16, 30, 30])

    store.working(0)
    now = 29 * MINUTE
    store.working(0)
    expect(store.waitMs()).toBe(30 * MINUTE)
    now = 30 * MINUTE
    store.working(0)
    expect(store.waitMs()).toBe(0)
  })
})
