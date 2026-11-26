import { describe, expect, it } from "vitest"

import { RecorderAlertPoster } from "../src/bot/recorder-alerts.js"
import { SqliteRecorderAlerts } from "../src/spectator/alerts.js"

const T0 = Date.parse("2026-11-26T20:00:00Z")
const at = (minutes: number) => new Date(T0 + minutes * 60_000)

async function setup(post?: (content: string) => Promise<void>) {
  const alerts = await SqliteRecorderAlerts.open(":memory:")
  const poster = new RecorderAlertPoster({
    alerts,
    ...(post ? { post } : {}),
    log: () => {},
  })
  return { alerts, poster }
}

describe("RecorderAlertPoster", () => {
  it("posts an alert once, again a day later while it's open, and once when it resolves", async () => {
    const posted: string[] = []
    const { alerts, poster } = await setup(async (c) => {
      posted.push(c)
    })
    alerts.raise("join", "can't join", at(0))
    await poster.tick(at(0))
    await poster.tick(at(1))
    expect(posted).toEqual(["can't join"])
    await poster.tick(at(24 * 60))
    expect(posted).toEqual(["can't join", "can't join"])
    alerts.resolve("join", at(24 * 60 + 1))
    await poster.tick(at(24 * 60 + 1))
    await poster.tick(at(24 * 60 + 2))
    expect(posted).toEqual([
      "can't join",
      "can't join",
      "The recorder has joined the game server again and is recording.",
    ])
  })

  it("keeps alerts for a channel set later, and owes no word of one nobody saw", async () => {
    const { alerts, poster } = await setup()
    alerts.raise("open", "still can't join", at(0))
    alerts.raise("over", "couldn't join", at(0))
    await poster.tick(at(0))
    alerts.resolve("over", at(1))
    const posted: string[] = []
    const withChannel = new RecorderAlertPoster({
      alerts,
      post: async (c) => {
        posted.push(c)
      },
      log: () => {},
    })
    await withChannel.tick(at(2))
    expect(posted).toEqual(["still can't join"])
  })

  it("tries a post Discord refused again on the next tick, and the tick still counts", async () => {
    let refuse = true
    const posted: string[] = []
    const { alerts, poster } = await setup(async (c) => {
      if (refuse) throw new Error("Missing Access")
      posted.push(c)
    })
    alerts.raise("join", "can't join", at(0))
    await poster.tick(at(0))
    expect(alerts.due(at(0)), "still owed").toHaveLength(1)
    refuse = false
    await poster.tick(at(1))
    expect(posted).toEqual(["can't join"])
  })
})
