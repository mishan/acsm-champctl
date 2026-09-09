/**
 * Accepting one driver's livery, however it arrived
 * (docs/discord-livery-upload.md §3–§5).
 *
 * Two routes reach here: a Discord attachment on `/livery upload`, and a
 * one-time link for the drivers whose zip is over Discord's own ceiling. They
 * differ entirely in how they establish who is asking — a slash command's
 * member and roles, versus a token minted earlier — and not at all in what
 * happens once that is settled.
 *
 * So this is the one place the settling happens. Two code paths that both
 * unpack a stranger's zip and both write to the queue would agree on the day
 * they were written and drift by the second season, and the interesting half of
 * a livery upload is the refusals: which files are allowed, what a missing
 * preview means, whether it replaced something. A driver should get the same
 * sentence whichever way they sent the file.
 */

import { DEFAULT_LIMITS, LiveryPackError, type PackLimits, readSingleLivery } from "./pack.js"
import type { SubmitResult } from "./queue.js"

/**
 * What acceptance is allowed to take, whichever route it arrived by.
 *
 * These live here rather than in `src/bot/` because the HTTP upload link is not
 * the bot: it is a separate process with no Discord token, and when the cooldown
 * and the queue budget lived in `handleUpload` it was the one submission route
 * with neither. Anyone holding a link could POST until the disk filled.
 */
export interface AcceptLimits {
  /** How long after an accepted upload before the same driver may send another. */
  cooldownMs: number
  /** Ceiling on everything waiting to be applied, across championships. */
  maxQueuedBytes: number
  pack: PackLimits
}

export const DEFAULT_ACCEPT_LIMITS: AcceptLimits = {
  // Long enough that nobody can fill a disk by holding down a key, short enough
  // that fixing a livery ten minutes before a race is still possible.
  cooldownMs: 5 * 60_000,
  maxQueuedBytes: 2 * 1024 * 1024 * 1024,
  pack: DEFAULT_LIMITS,
}

/** The bits of the queue acceptance needs, so tests need no database. */
export interface AcceptQueue {
  /**
   * When this driver last had one accepted. Refused uploads do not count — a
   * driver iterating on a zip that keeps being rejected is doing what the
   * refusals are for.
   */
  lastAcceptedAt(discordUserId: string): Promise<Date | undefined>
  /** Everything queued and not yet applied, across championships. */
  queuedBytes(): Promise<number>
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
}

export interface AcceptInput {
  /** Resolved from the entry list. Never from anything the submitter chose. */
  driverName: string
  carModel: string
  championshipId: string
  discordUserId: string
  discordHandle?: string
  body: Uint8Array
  queue: AcceptQueue
  now: Date
  limits: AcceptLimits
  /** Whether the drain runs on a timer, which changes what the reply promises. */
  autoApply?: boolean
  /**
   * Rounds whose own entry list will override the class-level skin.
   *
   * Known only where a championship export is in hand, which is the bot. The
   * upload link's process holds no ACSM credentials and no export, so a
   * submission arriving that way carries none — the bot said it at mint time,
   * where the same check runs.
   */
  unreachableRounds?: number[]
}

export type AcceptOutcome =
  | { ok: true; reply: string; submission: SubmitResult }
  | { ok: false; reply: string; reason: "pack" | "cooldown" | "queue-full" }

/**
 * Unpacks, checks and queues.
 *
 * The attachment's filename — the one piece of submitter-controlled text in
 * either route — is not a parameter here, because it is used for nothing: not
 * the skin folder, not the queue key, not a path.
 */
export async function acceptLivery(input: AcceptInput): Promise<AcceptOutcome> {
  // Serialised per driver. The cooldown and the budget are both read-then-write
  // across an await, so two interactions fired at once — trivial from two
  // clients, or from the raw API — both read the old figures and both pass.
  // This closes that inside one process, which is where it matters: the bot is
  // one process and so is the upload server. Two *different* processes
  // accepting for the same driver in the same instant still race, and the
  // supersede transaction is what bounds the damage there.
  return await inTurn(input.discordUserId, () => acceptOne(input))
}

const inFlight = new Map<string, Promise<unknown>>()

function inTurn<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = inFlight.get(key) ?? Promise.resolve()
  const next = previous.then(work, work)
  // Cleared only if nothing else queued behind it, so the map does not grow one
  // entry per driver for the life of the process.
  const settled = next.then(
    () => undefined,
    () => undefined,
  )
  inFlight.set(key, settled)
  void settled.then(() => {
    if (inFlight.get(key) === settled) inFlight.delete(key)
  })
  return next
}

async function acceptOne(input: AcceptInput): Promise<AcceptOutcome> {
  const lastAccepted = await input.queue.lastAcceptedAt(input.discordUserId)
  if (lastAccepted) {
    const waited = input.now.getTime() - lastAccepted.getTime()
    if (waited < input.limits.cooldownMs) {
      const minutes = Math.ceil((input.limits.cooldownMs - waited) / 60_000)
      return {
        ok: false,
        reason: "cooldown",
        reply: `You uploaded one a moment ago — try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      }
    }
  }

  if ((await input.queue.queuedBytes()) + input.body.length > input.limits.maxQueuedBytes) {
    // A sentence rather than an exception. The pack limits cap one submission;
    // nothing caps a hundred, and the driver who happens to be the hundredth
    // did nothing wrong.
    return {
      ok: false,
      reason: "queue-full",
      reply:
        `There's more waiting to be applied than champctl will hold onto at once, so I can't ` +
        `take this one yet. An admin needs to run the drain — try again after that.`,
    }
  }

  let livery: ReturnType<typeof readSingleLivery>
  try {
    livery = readSingleLivery(
      input.body,
      { carModel: input.carModel, driverName: input.driverName },
      input.limits.pack,
    )
  } catch (e) {
    // `LiveryPackError` messages were written for a driver to read. Anything
    // else is champctl being broken and should not be dressed up as the
    // driver's fault.
    if (e instanceof LiveryPackError) return { ok: false, reply: e.message, reason: "pack" }
    throw e
  }

  const submission = await input.queue.submit({
    discordUserId: input.discordUserId,
    ...(input.discordHandle ? { discordHandle: input.discordHandle } : {}),
    championshipId: input.championshipId,
    driverName: input.driverName,
    carModel: input.carModel,
    skinFolder: livery.skinFolder,
    body: input.body,
    at: input.now,
  })

  return {
    ok: true,
    submission,
    reply: uploadReply({
      driverName: input.driverName,
      carModel: input.carModel,
      fileCount: livery.files.length,
      hasPreview: livery.files.some((f) => f.name.toLowerCase() === "preview.jpg"),
      replaced: submission.superseded !== undefined,
      autoApply: input.autoApply ?? false,
      unreachableRounds: input.unreachableRounds ?? [],
    }),
  }
}

/**
 * How long a drain heartbeat stays worth believing.
 *
 * Generous against the interval an operator is likely to pick, because a
 * watcher that is merely slow should not make the bot start telling drivers
 * something different — the flap between two wordings would be more confusing
 * than either.
 */
export const DRAIN_STALE_AFTER_MS = 30 * 60_000

/**
 * Whether the bot may promise a driver their livery goes on by itself.
 *
 * `autoApply` in the profile is a claim about a *different* process. The timer
 * lives in `champctl-liveries --drain --watch`, which holds the ACSM
 * credentials the bot must never have — so an operator can set the flag and
 * never start the watcher, and every driver would be told "shortly" for ever
 * while nothing applied anything.
 *
 * Checking the heartbeat makes the promise falsifiable. When the watcher is not
 * running, the reply degrades to the true one — that an admin has to apply it —
 * which is exactly what a driver needs to know in order to go and ask.
 */
export function autoApplyPromised(
  configured: boolean,
  lastDrainAt: Date | undefined,
  now: Date,
  staleAfterMs = DRAIN_STALE_AFTER_MS,
): boolean {
  if (!configured) return false
  if (!lastDrainAt) return false
  return now.getTime() - lastDrainAt.getTime() <= staleAfterMs
}

export interface ReplyFacts {
  driverName: string
  carModel: string
  fileCount: number
  hasPreview: boolean
  replaced: boolean
  autoApply: boolean
  /** Rounds the class-level skin will not reach. Usually empty. */
  unreachableRounds?: number[]
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
 * **Practice already running keeps the old entry list.** Neither route restarts
 * practice — a driver at 8pm must not be able to disconnect everyone else over
 * a cosmetic change — so the livery appears at the *next* practice start, and
 * that is a surprise unless it is said.
 */
export function uploadReply(facts: ReplyFacts): string {
  const files = `${facts.fileCount} file${facts.fileCount === 1 ? "" : "s"}`
  const lines: string[] = [
    facts.replaced
      ? `Got it — that replaces the one you sent earlier. ${files} for ${facts.driverName}'s ${facts.carModel}.`
      : `Got it — ${files} for ${facts.driverName}'s ${facts.carModel}.`,
    facts.autoApply
      ? `It'll go on the server shortly, and show up the next time practice starts — practice ` +
        `that's running now keeps the old entry list.`
      : `It's queued for an admin to apply. Once they do, it shows up the next time practice ` +
        `starts — practice that's running now keeps the old entry list.`,
  ]

  const unreachable = facts.unreachableRounds ?? []
  if (unreachable.length > 0) {
    // The assignment lands in the database and never reaches the track: that
    // round's own entry list carries an entrant whose stored skin wins over the
    // class-level one. The driver cannot fix it, and would otherwise see the
    // old car in that race and upload again.
    const many = unreachable.length !== 1
    lines.push(
      `Heads up: round${many ? "s" : ""} ${unreachable.join(", ")} ${many ? "have" : "has"} ` +
        `its own entry list, which overrides this — your livery won't show there. An admin ` +
        `has to fix that round in ACSM.`,
    )
  }

  if (!facts.hasPreview) {
    // Races fine, looks broken. Worth one line now rather than a question on
    // race night.
    lines.push(`No preview.jpg in there, so it'll show as a blank tile in Content Manager.`)
  }

  return lines.join("\n")
}
