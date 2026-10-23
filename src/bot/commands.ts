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
  /** Discord's numeric option types. 3 is STRING, 4 is INTEGER, 5 is BOOLEAN, 11 is ATTACHMENT. */
  type: 3 | 4 | 5 | 11
  required: boolean
  /** Suggestions as it's typed, from the router's `autocomplete`. Strings only. */
  autocomplete?: boolean
  /** Strings only. Discord refuses longer before the bot sees it. */
  max_length?: number
  /** Integers only: Discord refuses outside these before the bot sees it. */
  min_value?: number
  max_value?: number
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
      name: "carset",
      // The other half of the feature. Every driver needs everyone else's
      // liveries or they see default skins on the grid, and the pack is by
      // construction larger than any single upload — so it cannot be posted in
      // a channel and has to be a link.
      description: "Get the link to everyone's liveries, for Content Manager",
      type: 1,
      options: [],
    },
    {
      name: "upload-url",
      description: "Get a one-time link, for a zip too big for Discord",
      type: 1,
      options: [],
    },
  ],
}

/** `/racer claim`: who a Discord account is on the entry list, for liveries, incidents and the Racers role. */
export const RACER_COMMAND: CommandDefinition = {
  name: "racer",
  description: "Tell GridMom which driver on the entry list you are",
  dmPermission: false,
  options: [
    {
      name: "claim",
      description: "Tell GridMom which driver on the entry list you are",
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
  ],
}

export const LIVERY_COMMANDS: CommandDefinition[] = [LIVERY_COMMAND, RACER_COMMAND]

/**
 * `/incident` (docs/discord-bot-setup.md, step 13). Report and decide are subcommands of one
 * command, so a steward finds both where drivers report.
 */
export const INCIDENT_COMMAND: CommandDefinition = {
  name: "incident",
  description: "Report an incident from a race, or decide one",
  dmPermission: false,
  options: [
    {
      name: "report",
      description: "Report something that happened between you and another driver",
      type: 1,
      options: [
        {
          name: "race",
          description: "The session it happened in",
          type: 3,
          required: true,
          autocomplete: true,
        },
        {
          name: "what",
          description: "A contact the recording caught, or something else",
          type: 3,
          required: true,
          autocomplete: true,
        },
        {
          name: "description",
          description: "What happened, in your own words",
          type: 3,
          required: true,
          // Room for it in one message, under the report's own line.
          max_length: 1500,
        },
        {
          name: "other_driver",
          description: "For something else: the other driver",
          type: 3,
          required: false,
          autocomplete: true,
        },
        {
          name: "when",
          description:
            "For something else: the time into the session, as the replay shows it (12:59)",
          type: 3,
          required: false,
        },
      ],
    },
    {
      name: "decide",
      description: "Stewards: record the decision on this incident",
      type: 1,
      options: [
        {
          name: "outcome",
          description: "What was decided, and any penalty",
          type: 3,
          required: true,
          max_length: 1500,
        },
      ],
    },
  ],
}

const count = (
  name: string,
  description: string,
  max: number,
  min = 1,
): CommandOptionDefinition => ({
  name,
  description,
  type: 4,
  required: true,
  min_value: min,
  max_value: max,
})

/** `/season` (docs/discord-bot-setup.md, step 14): the Racers choose next season's cars, then its tracks. */
export const SEASON_COMMAND: CommandDefinition = {
  name: "season",
  description: "Nominate and vote on next season's cars and tracks",
  dmPermission: false,
  options: [
    {
      name: "nominate",
      description: "Nominate a car or track for next season, whichever is open",
      type: 1,
      options: [
        {
          name: "item",
          description: "One installed on the server, or the name of a new one",
          type: 3,
          required: true,
          autocomplete: true,
          max_length: 80,
        },
        {
          name: "link",
          description: "For one not on the server: a link to the mod",
          type: 3,
          required: false,
          max_length: 500,
        },
      ],
    },
    {
      name: "withdraw",
      description: "Take back one of your nominations",
      type: 1,
      options: [
        {
          name: "item",
          description: "Your nomination",
          type: 3,
          required: true,
          autocomplete: true,
        },
      ],
    },
    {
      name: "status",
      description: "Where the season vote is, and what's nominated",
      type: 1,
      options: [],
    },
    {
      name: "start",
      description: "Admins: start choosing next season, cars then tracks",
      type: 1,
      options: [
        count("cars", "How many cars go through; 0 to choose only tracks", 10, 0),
        count("tracks", "How many tracks go through; 0 to choose only cars", 10, 0),
        count("nominate_days", "Days each nomination window stays open", 30),
        count("vote_days", "Days each vote stays open", 30),
        {
          name: "one_vote",
          description: "One vote each, instead of voting for as many as you like",
          type: 5,
          required: false,
        },
      ],
    },
    {
      name: "close",
      description: "Admins: end the current nomination window or vote now",
      type: 1,
      options: [],
    },
  ],
}
