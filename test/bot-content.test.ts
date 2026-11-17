import { describe, expect, it } from "vitest"

import type { InstalledContent } from "../src/acsm/content.js"
import { ContentCache } from "../src/acsm/content-cache.js"
import { contentCommand } from "../src/bot/content.js"
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
