/**
 * Routing `/livery` to the handlers (docs/discord-livery-upload.md §3, §7).
 *
 * Between `discord.ts`, which knows about gateways and attachments, and
 * `livery.ts`, which knows about clamps and zips. Nothing here imports
 * `discord.js`, so every dispatch, every refusal and every reply is testable by
 * calling a function with a plain object.
 *
 * It reads a championship through Public Access, which needs no login, and
 * writes only to the local queue. The credential split is unchanged: this side
 * still cannot send anything to the game server.
 */

import type { AcsmReader } from "../acsm/client.js"
import type { Championship } from "../acsm/types.js"
import { autoApplyPromised } from "../liveries/accept.js"
import type { SqliteClaimStore } from "../liveries/claims.js"
import type { SqliteSubmissionQueue } from "../liveries/queue.js"
import type { SqliteTokenStore } from "../liveries/upload-token.js"
import { maxSubmissionBytes } from "../liveries/pack.js"
import type { SqliteLiveryStore } from "../liveries/store.js"
import type { LiveryUploadSettings } from "../profile/types.js"
import {
  DEFAULT_UPLOAD_LIMITS,
  handleCarsetLink,
  handleClaim,
  handleUpload,
  handleUploadUrl,
} from "./livery.js"
import type { LiveryClamp, UploadContext, UploadLimits } from "./livery.js"
import { isFinished } from "./nightly.js"
import { racedCars } from "../liveries/coverage.js"
import { rosterOf } from "../liveries/plan.js"
import type { CommandReply, CommandRouter, SlashCommand } from "./transport.js"

export interface LiveryRouterOptions {
  reader: AcsmReader
  claims: SqliteClaimStore
  queue: SqliteSubmissionQueue
  tokens: SqliteTokenStore
  /** Applied liveries, for the carset link. Absent means /livery carset says so. */
  store?: SqliteLiveryStore
  clamp: LiveryClamp
  /** From the profile. Only ever a promise about the drain; see `autoApplyPromised`. */
  autoApply?: boolean
  uploadBaseUrl?: string
  /** Pins the championship, for a league running two series at once. */
  championshipId?: string
  limits?: UploadLimits
  now?: () => Date
}

/** Everything the router takes from the profile, and nothing it takes from the process. */
export type LiveryRouterSettings = Pick<
  LiveryRouterOptions,
  "clamp" | "autoApply" | "uploadBaseUrl" | "championshipId"
>

/**
 * Turns the profile's `discord.livery` block into router options.
 *
 * Pulled out of `serve()` so it can be tested. It was four spread expressions
 * inline there, and one of them — `championshipId` — was simply missing, which
 * no test could see because the router's own tests construct it directly. The
 * cost of that was a league running two series being told by the bot to set a
 * key that did nothing.
 */
export function liveryRouterSettings(livery: LiveryUploadSettings): LiveryRouterSettings {
  return {
    clamp: {
      ...(livery.channelIds ? { channelIds: livery.channelIds } : {}),
      ...(livery.roleIds ? { roleIds: livery.roleIds } : {}),
    },
    ...(livery.autoApply !== undefined ? { autoApply: livery.autoApply } : {}),
    ...(livery.uploadBaseUrl ? { uploadBaseUrl: livery.uploadBaseUrl } : {}),
    ...(livery.championshipId ? { championshipId: livery.championshipId } : {}),
  }
}

export class LiveryRouter implements CommandRouter {
  readonly #options: LiveryRouterOptions

  constructor(options: LiveryRouterOptions) {
    this.#options = options
  }

  async handle(command: SlashCommand): Promise<CommandReply> {
    const claiming = command.name === "racer" && command.subcommand === "claim"
    if (command.name !== "livery" && !claiming) {
      return { content: `I don't know the command /${command.name}.` }
    }

    const now = (this.#options.now ?? (() => new Date()))()
    const context: UploadContext = {
      discordUserId: command.userId,
      discordHandle: command.username,
      ...(command.guildId ? { guildId: command.guildId } : {}),
      channelId: command.channelId,
      roleIds: command.roleIds,
    }

    if (claiming) {
      const name = command.options["name"] ?? ""
      const targets = await this.#claimTargets(name)
      if ("problem" in targets) return { content: targets.problem }
      const results = []
      for (const { championship, championshipId } of targets) {
        // Not clamped to the livery role: someone new claims to be given the
        // Racers role, so they won't have it yet.
        results.push(
          await handleClaim(
            { context, clamp: {}, championship, championshipId, entrantName: name },
            this.#options.claims,
            now,
          ),
        )
      }
      // The announcement rides back rather than being posted here, so this
      // module keeps having no way to talk to Discord. It goes out even when
      // another championship refused, since the claims that stood are made.
      const made = results.find((r) => r.ok)
      const refused = results.find((r) => !r.ok)
      return {
        content: (refused ?? made ?? { reply: "" }).reply,
        ...(made?.ok ? { announcement: made.announcement } : {}),
      }
    }

    const resolved = await this.#championship()
    if ("problem" in resolved) return { content: resolved.problem }
    const { championship, championshipId } = resolved

    switch (command.subcommand) {
      case "upload": {
        const attachment = command.attachment
        if (!attachment) {
          return { content: `That needs a zip attached — use the \`file\` option.` }
        }
        const limits = this.#options.limits ?? DEFAULT_UPLOAD_LIMITS

        // Checked against the size Discord reported, before fetching anything.
        // Downloading first and then refusing would spend the bandwidth to
        // learn what the payload already said.
        // One skin's worth, not the whole-pack zip-bomb ceiling. maxTotalBytes
        // is a gigabyte, which is above anything Discord will carry, so this
        // gate never fired and the bot buffered whatever arrived.
        const ceiling = maxSubmissionBytes(limits.pack)
        if (attachment.size > ceiling) {
          return {
            content:
              `That's ${mb(attachment.size)}, and champctl won't take more than ` +
              `${mb(ceiling)} in one go. If it's genuinely that big, ` +
              `\`/livery upload-url\` gives you a link instead.`,
          }
        }

        const result = await handleUpload({
          context,
          clamp: this.#options.clamp,
          championship,
          championshipId,
          claim: await this.#options.claims.forDiscordUser(championshipId, command.userId),
          download: () => attachment.download(),
          queue: this.#options.queue,
          now,
          limits,
          autoApply: autoApplyPromised(
            this.#options.autoApply ?? false,
            await this.#options.queue.lastDrainRun(championshipId),
            now,
          ),
        })
        return { content: result.reply }
      }

      case "carset": {
        if (!this.#options.store) {
          return { content: `I can't reach the record of what's been applied — tell an admin.` }
        }
        const result = await handleCarsetLink(
          {
            context,
            clamp: this.#options.clamp,
            championshipId,
            ...(championship.Name ? { championshipName: championship.Name } : {}),
            cars: racedCars(championship),
            ...(this.#options.uploadBaseUrl ? { uploadBaseUrl: this.#options.uploadBaseUrl } : {}),
          },
          this.#options.store,
          now,
        )
        return { content: result.reply }
      }

      case "upload-url": {
        const result = await handleUploadUrl(
          {
            context,
            clamp: this.#options.clamp,
            championship,
            championshipId,
            claim: await this.#options.claims.forDiscordUser(championshipId, command.userId),
            ...(this.#options.uploadBaseUrl ? { uploadBaseUrl: this.#options.uploadBaseUrl } : {}),
          },
          this.#options.tokens,
          now,
        )
        return { content: result.reply }
      }

      default:
        return { content: `I don't know \`/livery ${command.subcommand ?? ""}\`.` }
    }
  }

  /**
   * Which championship this upload is for (docs/discord-livery-upload.md §7).
   *
   * Refuses ambiguity rather than picking. Two unfinished championships is a
   * real state for a league running a second series, and quietly choosing one
   * puts a livery on the wrong car — a failure nobody would look for, because
   * the upload succeeded.
   */
  async #championship(): Promise<Live | { problem: string }> {
    const pinned = this.#options.championshipId
    if (pinned) {
      try {
        return {
          championship: await this.#options.reader.exportChampionship(pinned),
          championshipId: pinned,
        }
      } catch (e) {
        return {
          problem:
            `I can't read the championship this server is set up for (${pinned}). ` +
            `That's a champctl problem rather than anything you did — tell an admin. ` +
            `(${e instanceof Error ? e.message : String(e)})`,
        }
      }
    }

    const live = await this.#live()
    if ("problem" in live) return live
    if (live.length === 1) return live[0] as Live
    if (live.length === 0) {
      return {
        problem:
          `There's no championship with racing still to come, so there's nowhere to put a ` +
          `livery. If a new one is being set up, this'll work once it exists.`,
      }
    }
    return {
      problem:
        `There are ${live.length} championships running, so I can't tell which one you mean: ` +
        `${live.map((l) => l.championship.Name ?? l.championshipId).join(", ")}. An admin needs ` +
        `to pin one with discord.livery.championshipId.`,
    }
  }

  /**
   * Every running championship with this name on its entry list, pinned or
   * not: a racer on this season's and next season's is claimed on both, and
   * one signed up for next season can claim while this one races. With none,
   * the one an upload would use, so the refusal says what's wrong with it.
   */
  async #claimTargets(name: string): Promise<Live[] | { problem: string }> {
    const live = await this.#live()
    const wanted = name.trim().normalize("NFC")
    const named =
      "problem" in live
        ? []
        : live.filter((l) => rosterOf(l.championship).some((r) => r.name === wanted))
    if (named.length > 0) return named
    const fallback = await this.#championship()
    return "problem" in fallback ? fallback : [fallback]
  }

  /** The championships that aren't finished. */
  async #live(): Promise<Live[] | { problem: string }> {
    let summaries: Awaited<ReturnType<AcsmReader["listChampionships"]>>
    try {
      summaries = await this.#options.reader.listChampionships()
    } catch (e) {
      return {
        problem:
          `I can't reach Server Manager to work out which championship this is for. ` +
          `Try again in a minute; if it keeps happening, tell an admin. ` +
          `(${e instanceof Error ? e.message : String(e)})`,
      }
    }

    const live: Live[] = []
    for (const summary of summaries) {
      const id = summary.ID
      if (!id) continue
      try {
        const championship = await this.#options.reader.exportChampionship(id)
        // A finished championship cannot be acted on — the same test the
        // nightly report uses to decide there is nothing left to say about one.
        if (!isFinished(championship)) live.push({ championship, championshipId: id })
      } catch {
        // One unreadable championship should not stop an upload for a different
        // one. If it was the only one, the count below says so anyway.
      }
    }

    return live
  }
}

interface Live {
  championship: Championship
  championshipId: string
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
