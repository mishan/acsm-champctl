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

import { LiveryPackError, type PackLimits, readSingleLivery } from "./pack.js"
import type { SubmitResult } from "./queue.js"

/** The bits of the queue acceptance needs, so tests need no database. */
export interface AcceptQueue {
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
  limits: PackLimits
  /** Whether the drain runs on a timer, which changes what the reply promises. */
  autoApply?: boolean
}

export type AcceptOutcome =
  | { ok: true; reply: string; submission: SubmitResult }
  | { ok: false; reply: string; reason: "pack" }

/**
 * Unpacks, checks and queues.
 *
 * The attachment's filename — the one piece of submitter-controlled text in
 * either route — is not a parameter here, because it is used for nothing: not
 * the skin folder, not the queue key, not a path.
 */
export async function acceptLivery(input: AcceptInput): Promise<AcceptOutcome> {
  let livery: ReturnType<typeof readSingleLivery>
  try {
    livery = readSingleLivery(
      input.body,
      { carModel: input.carModel, driverName: input.driverName },
      input.limits,
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

  if (!facts.hasPreview) {
    // Races fine, looks broken. Worth one line now rather than a question on
    // race night.
    lines.push(`No preview.jpg in there, so it'll show as a blank tile in Content Manager.`)
  }

  return lines.join("\n")
}
