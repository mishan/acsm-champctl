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
  acceptLivery,
  type AcceptLimits,
  type AcceptQueue,
  DEFAULT_ACCEPT_LIMITS,
} from "../liveries/accept.js"
import type { Livery } from "../liveries/pack.js"
import { LiveryPlanError, planLiveries, unreachableRounds } from "../liveries/plan.js"
import type { SubmitResult } from "../liveries/queue.js"
import {
  DEFAULT_TOKEN_TTL_MS,
  type MintedToken,
  type UploadGrant,
  uploadUrl,
} from "../liveries/upload-token.js"

export { uploadReply, type ReplyFacts } from "../liveries/accept.js"

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

/**
 * The same limits acceptance enforces, under the name this module has always
 * used for them. They live in `liveries/accept.ts` now because the HTTP upload
 * link goes through acceptance and never through here.
 */
export type UploadLimits = AcceptLimits
export const DEFAULT_UPLOAD_LIMITS: UploadLimits = DEFAULT_ACCEPT_LIMITS

/** The bits of the queue this module needs, so tests need no database. */
export type UploadQueue = AcceptQueue

export interface HandleUploadOptions {
  context: UploadContext
  clamp: LiveryClamp
  championship: Championship
  championshipId: string
  claim: DriverClaim | undefined
  /**
   * Fetches the attachment. A thunk rather than the bytes, so that the clamp
   * runs first: an options object is evaluated in source order, so passing
   * `body: await attachment.download()` pulled the file down before
   * `clampProblem` could refuse it — up to whatever a boosted guild allows,
   * from somebody with no role, in the wrong channel.
   *
   * Never its filename. That is the one piece of submitter-controlled text in
   * the flow and it is used for nothing.
   */
  download: () => Promise<Uint8Array>
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
 * nothing, identity needs the entry list, and everything after that costs
 * either bandwidth or memory. A driver who is in the wrong channel should not
 * have their zip fetched to find out.
 *
 * The cooldown and the queue budget are not here any more — they moved into
 * `acceptLivery`, which is the only thing both submission routes share.
 */
export async function handleUpload(options: HandleUploadOptions): Promise<UploadOutcome> {
  const limits = options.limits ?? DEFAULT_UPLOAD_LIMITS
  const { context } = options

  const clamped = clampProblem(options.clamp, context)
  if (clamped) return { ok: false, reply: clamped, reason: "clamp" }

  const resolved = resolveUploader(options.championship, options.claim)
  if (!resolved.ok) return { ok: false, reply: resolved.reason, reason: "identity" }
  const { driverName, carModel } = resolved.uploader

  const planned = planFor(options.championship, options.championshipId, driverName, carModel)
  if (!planned.ok) return { ok: false, reply: planned.reason, reason: "plan" }

  const accepted = await acceptLivery({
    driverName,
    carModel,
    championshipId: options.championshipId,
    discordUserId: context.discordUserId,
    ...(context.discordHandle ? { discordHandle: context.discordHandle } : {}),
    body: await options.download(),
    queue: options.queue,
    now: options.now,
    limits,
    autoApply: options.autoApply ?? false,
    unreachableRounds: planned.unreachableRounds,
  })

  return accepted.ok
    ? { ok: true, reply: accepted.reply, submission: accepted.submission }
    : { ok: false, reply: accepted.reply, reason: accepted.reason }
}

export interface ClaimRequest {
  context: UploadContext
  clamp: LiveryClamp
  championship: Championship
  championshipId: string
  entrantName: string
}

export type ClaimStore = {
  claim(
    championshipId: string,
    championship: Championship,
    entrantName: string,
    discordUserId: string,
    options: { discordHandle?: string; at?: Date },
  ): Promise<{ ok: true; claim: DriverClaim } | { ok: false; reason: string }>
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
    request.championshipId,
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
    }),
  }
}

export interface UploadUrlRequest {
  context: UploadContext
  clamp: LiveryClamp
  championship: Championship
  championshipId: string
  claim: DriverClaim | undefined
  /** From `discord.livery.uploadBaseUrl`. Absent means the league has no link. */
  uploadBaseUrl?: string
}

export interface TokenMinter {
  mint(grant: UploadGrant, now: Date, ttlMs?: number): Promise<MintedToken>
}

/**
 * Runs `planLiveries` against the identity, before any bytes exist.
 *
 * `planLiveries` reads names and models, never files, so a probe with no files
 * answers everything it can answer — and answers it while the driver is still
 * looking at Discord. Without this, two refusals reached them only at drain
 * time, in a channel nobody is reading, forty minutes later: a championship
 * with a second class, and an entry list holding their name twice, which
 * `resolveUploader` silently takes the first match of.
 *
 * The duplicate-name one matters beyond the driver. `planLiveries` refuses a
 * whole pack, so one driver whose name is doubled in ACSM used to block every
 * other driver's queued livery on the next drain.
 *
 * It also yields `overriddenInRounds`, which is the only way a driver learns
 * that a round's own entry list will override the class-level skin and their
 * livery will never reach that race.
 */
function planFor(
  championship: Championship,
  championshipId: string,
  driverName: string,
  carModel: string,
): { ok: true; unreachableRounds: number[] } | { ok: false; reason: string } {
  const probe: Livery = { carModel, driverName, skinFolder: driverName, files: [], totalBytes: 0 }
  try {
    const plan = planLiveries(championship, championshipId, {
      liveries: [probe],
      totalBytes: 0,
    })
    return { ok: true, unreachableRounds: unreachableRounds(plan) }
  } catch (e) {
    if (!(e instanceof LiveryPlanError)) throw e
    return { ok: false, reason: e.message }
  }
}

export type UploadUrlOutcome = { ok: true; reply: string } | { ok: false; reply: string }

/**
 * `/livery upload-url` — a link for a driver whose zip Discord won't carry
 * (docs/discord-livery-upload.md §3).
 *
 * The reply must be **ephemeral**. It contains a bearer credential, and an
 * ephemeral reply is visible only to the person who ran the command, arrives on
 * the interaction already in hand, and leaves nothing in their message history
 * — where a DM would sit indefinitely and fail outright for anyone with DMs
 * from server members turned off.
 *
 * The identity resolution is the same as an upload's, and that matters: the URL
 * carries no "who", so the driver and car are fixed here and a leaked link
 * uploads for the person it was minted for and nobody else.
 */
export async function handleUploadUrl(
  request: UploadUrlRequest,
  tokens: TokenMinter,
  now: Date,
  ttlMs: number = DEFAULT_TOKEN_TTL_MS,
): Promise<UploadUrlOutcome> {
  const clamped = clampProblem(request.clamp, request.context)
  if (clamped) return { ok: false, reply: clamped }

  if (!request.uploadBaseUrl) {
    return {
      ok: false,
      reply:
        `This league hasn't set up upload links, so Discord attachments are the only way in. ` +
        `If your file is too big for Discord, an admin can either set one up or take it by hand.`,
    }
  }

  const resolved = resolveUploader(request.championship, request.claim)
  if (!resolved.ok) return { ok: false, reply: resolved.reason }

  // Checked here as well, so a driver is not handed a link for an upload the
  // drain is going to refuse. The upload server holds no ACSM credentials and
  // no export, so this is the last point on that route where it can be asked.
  const planned = planFor(
    request.championship,
    request.championshipId,
    resolved.uploader.driverName,
    resolved.uploader.carModel,
  )
  if (!planned.ok) return { ok: false, reply: planned.reason }

  const minted = await tokens.mint(
    {
      discordUserId: request.context.discordUserId,
      ...(request.context.discordHandle ? { discordHandle: request.context.discordHandle } : {}),
      championshipId: request.championshipId,
      driverName: resolved.uploader.driverName,
      carModel: resolved.uploader.carModel,
    },
    now,
    ttlMs,
  )

  // `uploadUrl` throws rather than downgrading when the base URL is not https,
  // and that error belongs to the operator: it is a misconfiguration, not
  // anything the driver did, and it must not reach them as a working link.
  const url = uploadUrl(request.uploadBaseUrl, minted.token)
  const minutes = Math.round(ttlMs / 60_000)

  return {
    ok: true,
    reply:
      `Here's your upload link — it works once, for the next ${minutes} minutes, and only for ` +
      `${resolved.uploader.driverName}'s ${resolved.uploader.carModel}:\n<${url}>\n` +
      `Don't share it: anyone with it can upload your livery.`,
  }
}

export interface CarsetLinkRequest {
  context: UploadContext
  clamp: LiveryClamp
  championshipId: string
  championshipName?: string
  /** From `discord.livery.uploadBaseUrl`; the carset is served by the same process. */
  uploadBaseUrl?: string
}

export interface CarsetLinkStore {
  carsetLink(championshipId: string, at?: Date): Promise<string>
  list(championshipId: string): Promise<readonly { driverName: string }[]>
}

/**
 * `/livery carset` — where to get everyone else's liveries.
 *
 * This is the half of the feature that is easy to forget, because the driver
 * who uploads is not the one who suffers when nobody has it: a livery on the
 * server does nothing for the twenty-nine people who cannot see it. And it has
 * to be a link rather than an attachment for the same reason `/livery
 * upload-url` exists, only more so — the carset is every livery at once, so if
 * one of them was too big for Discord the pack certainly is.
 *
 * The link is deliberately the same for everyone and does not expire. It gets
 * pinned; a per-driver token would rot the moment somebody pasted theirs.
 */
export async function handleCarsetLink(
  request: CarsetLinkRequest,
  store: CarsetLinkStore,
  now: Date,
): Promise<{ ok: boolean; reply: string }> {
  const clamped = clampProblem(request.clamp, request.context)
  if (clamped) return { ok: false, reply: clamped }

  if (!request.uploadBaseUrl) {
    return {
      ok: false,
      reply:
        `This league doesn't have anywhere for me to serve the carset from, so an admin is ` +
        `handing it out some other way — ask them.`,
    }
  }

  const applied = await store.list(request.championshipId)
  if (applied.length === 0) {
    return {
      ok: false,
      reply: `Nobody's liveries have been applied yet, so there's nothing in the carset to send.`,
    }
  }

  const slug = await store.carsetLink(request.championshipId, now)
  const base = new URL(request.uploadBaseUrl)
  const path = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`
  const url = new URL(`${path}c/${slug}`, base).toString()

  return {
    ok: true,
    reply:
      `${applied.length} ${applied.length === 1 ? "livery" : "liveries"} for ` +
      `${request.championshipName ?? "this championship"}: ${url}\n` +
      `Drop the zip on Content Manager, or extract it over your Assetto Corsa folder. The link ` +
      `stays the same as people add liveries, so it's worth pinning.`,
  }
}
