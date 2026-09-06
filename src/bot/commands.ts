/**
 * What `/livery` looks like in Discord (docs/discord-livery-upload.md §3).
 *
 * Plain data, not `discord.js` builders, so the shape can be asserted without a
 * gateway — and so the one place that knows about `discord.js` stays
 * `discord.ts`. The library's builders produce this same JSON.
 *
 * **A slash command with an attachment option, not a message with a file.**
 * Reading attachments off messages needs the `MessageContent` intent, which is
 * privileged and would let the token read every message in every channel it can
 * see. `discord.ts` asks for no intents at all and this keeps it that way. It
 * also hands over three things for free: `member.roles` for the clamp,
 * `channelId` for the clamp, and ephemeral replies — so a refusal that says
 * "your zip has a leftover .psd in it" goes to the driver and not the league.
 */

export interface CommandOptionDefinition {
  name: string
  description: string
  /** Discord's numeric option types. 3 is STRING, 11 is ATTACHMENT. */
  type: 3 | 11
  required: boolean
}

export interface SubcommandDefinition {
  name: string
  description: string
  /** 1 is SUB_COMMAND. */
  type: 1
  options: CommandOptionDefinition[]
}

export interface CommandDefinition {
  name: string
  description: string
  options: SubcommandDefinition[]
  /**
   * Whether Discord should offer the command in DMs.
   *
   * Always false here. A DM has no member and no roles, so a role clamp cannot
   * be satisfied in one — and a command that appears and then refuses is worse
   * than one that never appears. `handleUpload` still refuses a DM if one gets
   * through, because this is Discord's UI hint and not an enforcement point.
   */
  dmPermission: boolean
}

export const LIVERY_COMMAND: CommandDefinition = {
  name: "livery",
  description: "Send in your car's livery",
  dmPermission: false,
  options: [
    {
      name: "claim",
      description: "Tell champctl which driver on the entry list you are",
      type: 1,
      options: [
        {
          name: "name",
          // Says "exactly" here as well as in the refusal, because the place to
          // prevent the mistake is where they are typing it.
          description: "Your name exactly as it appears on the entry list",
          type: 3,
          required: true,
        },
      ],
    },
    {
      name: "upload",
      description: "Send a zip of your skin folder",
      type: 1,
      options: [
        {
          name: "file",
          description: "A zip of the skin's files — .dds, preview.jpg, ui_skin.json",
          type: 11,
          required: true,
        },
      ],
    },
    {
      name: "upload-url",
      description: "Get a one-time link, for a zip too big for Discord",
      type: 1,
      options: [],
    },
  ],
}

export const LIVERY_COMMANDS: CommandDefinition[] = [LIVERY_COMMAND]
