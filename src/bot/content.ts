/**
 * `/championship content`: an admin asks for Server Manager's installed cars
 * and tracks to be read again now, as champctl web's button does.
 */

import type { ContentCache } from "../acsm/content-cache.js"
import { refreshContent } from "../acsm/installed-content.js"
import type { CommandReply, SlashCommand } from "./transport.js"

export async function contentCommand(
  command: SlashCommand,
  o: { cache: ContentCache; adminRoleId: string },
): Promise<CommandReply> {
  if (!command.roleIds.includes(o.adminRoleId)) {
    return { content: "Only admins can read what's installed again." }
  }
  return { content: await refreshContent(o.cache).catch((e: unknown) => (e as Error).message) }
}
