import { describe, expect, it } from "vitest"

import type { InstalledContent } from "../src/acsm/content.js"
import { ContentCache } from "../src/acsm/content-cache.js"
import { contentCommand } from "../src/bot/content.js"
import { splitMessage } from "../src/bot/message.js"
import type { SlashCommand } from "../src/bot/transport.js"

const ADMIN = "1".repeat(18)
const command = (roleIds: string[]): SlashCommand => ({
  name: "championship",
  subcommand: "content",
  options: {},
  userId: "u",
  username: "u",
  guildId: "g",
  channelId: "c",
  roleIds,
})

describe("/championship content", () => {
  it("reads what's installed again for an admin, and says what changed", async () => {
    let reads = 0
    const cache = new ContentCache<InstalledContent>({
      load: async () => ({ cars: [], tracks: [{ id: `t${reads++}`, name: `Track ${reads}` }] }),
    })
    await cache.get()
    expect((await contentCommand(command([]), { cache, adminRoleId: ADMIN })).content).toBe(
      "Only admins can read what's installed again.",
    )
    expect(reads).toBe(1)
    expect((await contentCommand(command([ADMIN]), { cache, adminRoleId: ADMIN })).content).toBe(
      "Server Manager's tracks changed: added Track 2; removed Track 1.",
    )
  })
})

describe("a change too long for one message", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => `Mod Car Number ${i}`)

  it("splits at the names, every part under Discord's limit, losing nothing", () => {
    const text = `Server Manager's cars changed: added ${many(200).join(", ")}.`
    const parts = splitMessage(text)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every((p) => p.length <= 2000)).toBe(true)
    expect(parts.join("")).toBe(text)
    expect(parts[1]).toMatch(/^Mod Car Number/)
  })

  it("answers an admin with the start, and where the rest is", async () => {
    const cache = new ContentCache<InstalledContent>({
      load: async () => ({
        cars: [...(reads++ ? many(200) : many(1))].map((name, i) => ({ id: `c${i}`, name })),
        tracks: [],
      }),
    })
    let reads = 0
    await cache.get()
    const reply = await contentCommand(command([ADMIN]), { cache, adminRoleId: ADMIN })
    expect(reply.content.length).toBeLessThanOrEqual(2000)
    expect(reply.content).toMatch(/…and more: the whole change is posted to the bot log\.$/)
  })
})
