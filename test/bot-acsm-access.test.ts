import { describe, expect, it } from "vitest"

import { AcsmAccessAlarm } from "../src/bot/acsm-access.js"

const MINUTE = 60_000

function harness() {
  let now = 0
  const told: string[] = []
  const alarm = new AcsmAccessAlarm({
    now: () => now,
    log: () => {},
    notify: async (content) => {
      told.push(content)
    },
  })
  const fetch = alarm.fetch(async () => new Response("", { status }))
  let status = 200
  const answer = async (minute: number, s: number) => {
    now = minute * MINUTE
    status = s
    await fetch("https://acsm.example/api")
  }
  return { answer, told }
}

describe("AcsmAccessAlarm", () => {
  it("tells the admins once after ten minutes of refusals, and again when they stop", async () => {
    const { answer, told } = harness()
    for (let m = 0; m < 10; m++) await answer(m, 403)
    expect(told).toEqual([])
    await answer(10, 403)
    await answer(11, 403)
    expect(told).toHaveLength(1)
    expect(told[0]).toContain("for 10 minutes (403 Forbidden, usually a CrowdSec ban")

    await answer(12, 200)
    expect(told[1]).toBe("Server Manager is answering the bot again.")
  })

  it("stays quiet about refusals that come and go", async () => {
    const { answer, told } = harness()
    for (let m = 0; m < 30; m++) await answer(m, m % 5 === 4 ? 200 : 429)
    expect(told).toEqual([])
  })
})
