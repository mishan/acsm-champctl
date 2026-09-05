/**
 * `/livery upload` (docs/discord-livery-upload.md §3–§5).
 *
 * A driver sends their own zip and it reaches the entry list without an
 * operator handling a file. The rule that shapes every line here is plan §7:
 * **this side holds no ACSM credentials.** It validates, it queues, and a
 * separate process with the credentials drains the queue. `test/bot.test.ts`
 * enforces that structurally, and the enforcement is the point — the bot is the
 * component most likely to grow a "just this once" convenience, and this is
 * precisely the convenience.
 *
 * No `discord.js` in this module either, the same way `nightly.ts` has none.
 * Everything below deals in ids, bytes and sentences, so the clamp, the
 * identity resolution, the refusals and the replies are all testable without a
 * gateway or a token.
 *
 * ## Validation happens here, not at drain time
 *
 * `readSingleLivery` and the pack rules are pure and write nothing, so running
 * them in the bot breaks no promise — and it is the difference between a driver
 * reading "your zip has a leftover .psd in it" while they are still looking at
 * Discord, and reading it forty minutes later in a channel nobody is watching.
 * A queue that accepts everything and refuses it later is a worse product than
 * the operator it replaced.
 */

import type { Championship } from "../acsm/types.js"
import {
  type DriverClaim,
  claimAnnouncement,
  resolveUploader,
  type HandleHint,
} from "../liveries/claims.js"
import {
  DEFAULT_LIMITS,
  LiveryPackError,
  type PackLimits,
  readSingleLivery,
} from "../liveries/pack.js"
import type { SubmitResult } from "../liveries/queue.js"

/** What Discord tells us about who is asking, and from where. */
export interface UploadContext {
  discordUserId: string
  discordHandle?: string
  /** Absent in a DM, which is why the role clamp implies a guild clamp. */
  guildId?: string
  channelId: string
  /** From `interaction.member.roles`; no privileged intent needed. */
  roleIds?: readonly string[]
}

/** Where uploads are accepted from, and by whom. Both optional. */
export interface LiveryClamp {
  /** Channels `/livery upload` is accepted in. Empty means anywhere. */
  channelIds?: readonly string[]
  /** Roles that may run it. Empty means anyone who can see the command. */
  roleIds?: readonly string[]
}

export type UploadOutcome =
  | { ok: true; reply: string; submission: SubmitResult; announcement?: string }
  | { ok: false; reply: string; reason: string }

/**
 * Whether this person, in this place, may upload at all.
 *
 * Channel and role are ANDed, and an empty list means unrestricted — which is
 * worth saying out loud because a league that sets `roleIds` and leaves
 * `channelIds` empty has accepted uploads in every channel the bot can see, and
 * would rather have known.
 */
export function clampProblem(clamp: LiveryClamp, context: UploadContext): string | undefined {
  const roles = clamp.roleIds ?? []
  const channels = clamp.channelIds ?? []

  if (roles.length > 0 && !context.guildId) {
    // Said explicitly rather than letting it fall through to "you don't have
    // the role", which is baffling to somebody who does — they just aren't
    // anywhere the server can see it.
    return (
      `Livery uploads are limited to a role, and a DM has no roles in it. Run this in the ` +
      `server instead.`
    )
  }

  if (channels.length > 0 && !channels.includes(context.channelId)) {
    return `Not here — livery uploads have their own channel. Try there.`
  }

  if (roles.length > 0 && !roles.some((r) => (context.roleIds ?? []).includes(r))) {
    return `Livery uploads are limited to a role you don't have. An admin can add it.`
  }

  return undefined
}

export interface UploadLimits {
  /** How long after an accepted upload before the same driver may send another. */
  cooldownMs: number
  /** Ceiling on everything waiting to be applied, across championships. */
  maxQueuedBytes: number
  pack: PackLimits
}

export const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  // Long enough that nobody can fill a disk by holding down a key, short enough
  // that fixing a livery ten minutes before a race is still possible.
  cooldownMs: 5 * 60_000,
  maxQueuedBytes: 2 * 1024 * 1024 * 1024,
  pack: DEFAULT_LIMITS,
}

/** The bits of the queue this module needs, so tests need no database. */
export interface UploadQueue {
  submit(input: {
    discordUserId: string
    discordHandle?: string
    championshipId: string
    driverName: string
    carModel: string
    skinFolder: string
    body: Uint8Array
    at: Date
  }): Promise<SubmitResult>
  lastAcceptedAt(discordUserId: string): Promise<Date | undefined>
  queuedBytes(): Promise<number>
}

export interface HandleUploadOptions {
  context: UploadContext
  clamp: LiveryClamp
  championship: Championship
  championshipId: string
  claim: DriverClaim | undefined
  /** The attachment, already downloaded. Never its filename. */
  body: Uint8Array
  queue: UploadQueue
  now: Date
  limits?: UploadLimits
  /** Whether the drain runs on a timer, which changes what the reply promises. */
  autoApply?: boolean
}

/**
 * The whole flow, minus the network.
 *
 * Order matters and is the cheapest-and-most-certain first: the clamp needs
 * nothing, identity needs the entry list, the cooldown and the disk budget need
 * one query each, and unpacking the zip is the expensive one. A driver who is
 * in the wrong channel should not have their zip unpacked to find out.
 */
export async function handleUpload(options: HandleUploadOptions): Promise<UploadOutcome> {
  const limits = options.limits ?? DEFAULT_UPLOAD_LIMITS
  const { context } = options

  const clamped = clampProblem(options.clamp, context)
  if (clamped) return { ok: false, reply: clamped, reason: "clamp" }

  const resolved = resolveUploader(options.championship, options.claim)
  if (!resolved.ok) return { ok: false, reply: resolved.reason, reason: "identity" }
  const { driverName, carModel } = resolved.uploader

  const lastAccepted = await options.queue.lastAcceptedAt(context.discordUserId)
  if (lastAccepted) {
    const waited = options.now.getTime() - lastAccepted.getTime()
    if (waited < limits.cooldownMs) {
      const minutes = Math.ceil((limits.cooldownMs - waited) / 60_000)
      return {
        ok: false,
        reply: `You uploaded one a moment ago — try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        reason: "cooldown",
      }
    }
  }

  if ((await options.queue.queuedBytes()) + options.body.length > limits.maxQueuedBytes) {
    // A sentence rather than an exception. `maxTotalBytes` caps one submission;
    // nothing caps a hundred, and the driver who happens to be the hundredth
    // did nothing wrong.
    return {
      ok: false,
      reply:
        `There's more waiting to be applied than champctl will hold onto at once, so I can't ` +
        `take this one yet. An admin needs to run the drain — try again after that.`,
      reason: "queue-full",
    }
  }

  let livery: ReturnType<typeof readSingleLivery>
  try {
    // The identity supplies both names. The attachment's filename is the one
    // piece of driver-controlled text in this flow and it is used for nothing —
    // not the skin folder, not the queue key, not a path.
    livery = readSingleLivery(options.body, { carModel, driverName }, limits.pack)
  } catch (e) {
    if (e instanceof LiveryPackError) return { ok: false, reply: e.message, reason: "pack" }
    throw e
  }

  const submission = await options.queue.submit({
    discordUserId: context.discordUserId,
    ...(context.discordHandle ? { discordHandle: context.discordHandle } : {}),
    championshipId: options.championshipId,
    driverName,
    carModel,
    skinFolder: livery.skinFolder,
    body: options.body,
    at: options.now,
  })

  return {
    ok: true,
    submission,
    reply: uploadReply({
      driverName,
      carModel,
      fileCount: livery.files.length,
      hasPreview: livery.files.some((f) => f.name.toLowerCase() === "preview.jpg"),
      replaced: submission.superseded !== undefined,
      autoApply: options.autoApply ?? false,
    }),
  }
}

export interface ReplyFacts {
  driverName: string
  carModel: string
  fileCount: number
  hasPreview: boolean
  replaced: boolean
  autoApply: boolean
}

/**
 * What the driver is told.
 *
 * Two sentences here are load-bearing rather than polite.
 *
 * **It is not on the server yet.** A driver who reads "uploaded" and then joins
 * practice sees the old car and uploads again, and then a third time. Saying
 * where it actually is stops the retry loop.
 *
 * **Practice already running keeps the old entry list.** Bot uploads never
 * restart practice — a driver at 8pm must not be able to disconnect everyone
 * else over a cosmetic change — so the livery appears at the *next* practice
 * start, and that is a surprise unless it is said.
 */
export function uploadReply(facts: ReplyFacts): string {
  const lines: string[] = []

  lines.push(
    facts.replaced
      ? `Got it — that replaces the one you sent earlier. ${facts.fileCount} file${facts.fileCount === 1 ? "" : "s"} for ${facts.driverName}'s ${facts.carModel}.`
      : `Got it — ${facts.fileCount} file${facts.fileCount === 1 ? "" : "s"} for ${facts.driverName}'s ${facts.carModel}.`,
  )

  lines.push(
    facts.autoApply
      ? `It'll go on the server shortly, and show up the next time practice starts — practice ` +
          `that's running now keeps the old entry list.`
      : `It's queued for an admin to apply. Once they do, it shows up the next time practice ` +
          `starts — practice that's running now keeps the old entry list.`,
  )

  if (!facts.hasPreview) {
    // Races fine, looks broken. Worth one line now rather than a question on
    // race night.
    lines.push(`No preview.jpg in there, so it'll show as a blank tile in Content Manager.`)
  }

  return lines.join("\n")
}

export interface ClaimRequest {
  context: UploadContext
  clamp: LiveryClamp
  championship: Championship
  entrantName: string
}

export type ClaimStore = {
  claim(
    championship: Championship,
    entrantName: string,
    discordUserId: string,
    options: { discordHandle?: string; at?: Date },
  ): Promise<
    { ok: true; claim: DriverClaim; replaced?: DriverClaim } | { ok: false; reason: string }
  >
  handleHint(entrantName: string): Promise<HandleHint | undefined>
}

export type ClaimOutcome =
  | { ok: true; reply: string; announcement: string }
  | { ok: false; reply: string }

/**
 * `/livery claim`.
 *
 * The announcement is not decoration: nothing here verifies that a driver is
 * who they say, so being named in the admin channel *is* the check. It goes out
 * on every successful claim, including the ones that look fine.
 */
export async function handleClaim(
  request: ClaimRequest,
  store: ClaimStore,
  now: Date,
): Promise<ClaimOutcome> {
  const clamped = clampProblem(request.clamp, request.context)
  if (clamped) return { ok: false, reply: clamped }

  const result = await store.claim(
    request.championship,
    request.entrantName,
    request.context.discordUserId,
    {
      ...(request.context.discordHandle ? { discordHandle: request.context.discordHandle } : {}),
      at: now,
    },
  )
  if (!result.ok) return { ok: false, reply: result.reason }

  const hint = await store.handleHint(result.claim.entrantName)
  return {
    ok: true,
    reply:
      `You're claimed as "${result.claim.entrantName}". Send a livery with /livery upload ` +
      `whenever you like.`,
    announcement: claimAnnouncement(result.claim, {
      ...(hint ? { hint } : {}),
      ...(result.replaced ? { replaced: result.replaced } : {}),
    }),
  }
}
