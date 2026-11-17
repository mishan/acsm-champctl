/**
 * `/championship content`: an admin asks for Server Manager's installed cars
 * and tracks to be read again now, as champctl web's button does.
 */

import type { ContentCache } from "../acsm/content-cache.js"
import { refreshContent } from "../acsm/installed-content.js"
import { splitMessage } from "./message.js"
import { type CommandReply, MESSAGE_LIMIT, type SlashCommand } from "./transport.js"

export async function contentCommand(
  command: SlashCommand,
  o: { cache: ContentCache; adminRoleId: string },
): Promise<CommandReply> {
  if (!command.roleIds.includes(o.adminRoleId)) {
    return { content: "Only admins can read what's installed again." }
  }
  const said = await refreshContent(o.cache).catch((e: unknown) => (e as Error).message)
  // A reply is one message; the whole of a long change goes to the bot log.
  const parts = splitMessage(said, MESSAGE_LIMIT - MORE.length)
  return { content: parts.length > 1 ? `${parts[0]}${MORE}` : said }
}

const MORE = "…and more: the whole change is posted to the bot log."
