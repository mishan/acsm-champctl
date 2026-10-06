/**
 * Posting a finished championship's podium to the trophy room.
 *
 * Two ways in. `trophies` runs nightly: it finds championships whose last round
 * finished within the past week, and posts each one's podium once. `trophy
 * <id>` posts one on demand, for an older season or a post that needs redoing.
 *
 * The week is what keeps the first night from posting every season the league
 * has ever run. The record in `SqliteTrophyStore` is what keeps the week from
 * posting the same one seven times.
 */

import type { AcsmReader } from "../acsm/client.js"
import type { Championship } from "../acsm/types.js"
import { eventHasResults, events, eventSession, isZeroTime } from "../acsm/view.js"
import { headingText } from "./message.js"
import { type PodiumClass, parsePodium } from "./podium.js"
import type { DiscordFile } from "./transport.js"
import { ordinal, renderPodium } from "./trophy-image.js"

/** A post with an image, as the caller's transport will send it. */
export interface TrophyPost {
  content: string
  files: DiscordFile[]
}

export interface TrophyDeps {
  reader: AcsmReader
  /** Fetches a path on the manager — the skin previews — or undefined if it can't. */
  fetchAsset: (path: string) => Promise<Uint8Array | undefined>
  post: (message: TrophyPost) => Promise<void>
  /** The league's timezone, for the month a championship is named by. */
  timezone: string
  posted: (championshipId: string) => Set<string>
  record: (championshipId: string, className: string) => void
}

/** How recently a championship has to have finished for the nightly job to post it. */
export const RECENT_DAYS = 7

/**
 * When the last round finished, or undefined if the championship isn't finished
 * or doesn't say.
 *
 * Finished is every round having results, as the nightly report counts it.
 * The time is the latest `CompletedTime` on a round or its sessions; a
 * championship finished without any is left to `trophy <id>` rather than
 * guessed at.
 */
export function finishedAt(c: Championship): Date | undefined {
  const rounds = events(c)
  if (rounds.length === 0 || !rounds.every((ev) => eventHasResults(ev))) return undefined
  let latest: number | undefined
  const see = (t: string | undefined | null) => {
    if (isZeroTime(t)) return
    const ms = Date.parse(t!)
    if (Number.isFinite(ms) && (latest === undefined || ms > latest)) latest = ms
  }
  for (const ev of rounds) {
    see(ev.CompletedTime)
    for (const key of ["Practice", "Qualifying", "Race"] as const) {
      see(eventSession(ev, key)?.CompletedTime)
    }
  }
  return latest === undefined ? undefined : new Date(latest)
}

export type TrophyOutcome =
  | { kind: "posted"; championshipId: string; name: string; classes: string[] }
  | { kind: "already"; championshipId: string; name: string }
  | { kind: "no-podium"; championshipId: string; name: string }
  | { kind: "failed"; championshipId: string; name: string; error: string }

/**
 * One championship's podium, posted class by class.
 *
 * Classes already in `posted` are skipped, so a run that failed part way
 * through finishes the rest without repeating any. `force` posts them again,
 * for `trophy <id>`.
 */
export async function postPodium(
  deps: TrophyDeps,
  championshipId: string,
  name: string,
  force = false,
  finished?: Date,
): Promise<TrophyOutcome> {
  const parsed = parsePodium(await deps.reader.championshipPage(championshipId))
  if (parsed === "absent") return { kind: "no-podium", championshipId, name }
  if (parsed === "unrecognised") {
    return {
      kind: "failed",
      championshipId,
      name,
      error:
        "the podium on its ACSM page isn't laid out the way champctl expects, so nothing was posted",
    }
  }

  const done = force ? new Set<string>() : deps.posted(championshipId)
  const todo = parsed.filter((cls) => !done.has(cls.name))
  if (todo.length === 0) return { kind: "already", championshipId, name }

  const posted: string[] = []
  for (const cls of todo) {
    await deps.post(await podiumPost(deps, name, cls, finished))
    deps.record(championshipId, cls.name)
    posted.push(cls.name)
  }
  return { kind: "posted", championshipId, name, classes: posted }
}

/**
 * The month a championship ran, as the league names it: "September 2026".
 *
 * Taken from when the last round finished, in the league's timezone — BATL's
 * September championship ended on the evening of the 30th in Los Angeles,
 * which is already October in UTC.
 */
export function seasonMonth(finished: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: timezone,
  }).format(finished)
}

async function podiumPost(
  deps: TrophyDeps,
  name: string,
  cls: PodiumClass,
  finished: Date | undefined,
): Promise<TrophyPost> {
  const previews = await Promise.all(cls.places.map((p) => deps.fetchAsset(p.preview)))
  const png = await renderPodium(cls, previews)
  // As the league has been posting them by hand: "August 2026 - <name>".
  const title = [
    ...(finished ? [seasonMonth(finished, deps.timezone)] : []),
    headingText(name),
    ...(cls.name ? [headingText(cls.name)] : []),
  ].join(" - ")
  const slug = `${name} ${cls.name}`
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
  const heading = cls.name ? `${name}, ${cls.name}` : name
  const results = cls.places.map((p) => `${ordinal(p.place)} place ${p.driver}`).join(", ")
  return {
    content: title,
    files: [
      {
        name: `${slug || "podium"}-podium.png`,
        data: png,
        description: `${heading}: ${results}`,
      },
    ],
  }
}

/**
 * The nightly sweep: every championship that finished in the last week and
 * hasn't been posted.
 *
 * Reads each championship's export to see whether it finished, through the
 * caller's cached reader; the page is only fetched for the ones that did.
 */
export async function postRecentPodiums(
  deps: TrophyDeps,
  now: Date,
  days = RECENT_DAYS,
): Promise<TrophyOutcome[]> {
  const since = now.getTime() - days * 24 * 3600_000
  const out: TrophyOutcome[] = []
  for (const summary of await deps.reader.listChampionships()) {
    const id = summary.ID
    if (!id) continue
    let name = summary.Name?.trim() || id
    try {
      const c = await deps.reader.exportChampionship(id)
      name = c.Name?.trim() || name
      const at = finishedAt(c)
      if (!at || at.getTime() < since || at.getTime() > now.getTime()) continue
      out.push(await postPodium(deps, id, name, false, at))
    } catch (e) {
      out.push({
        kind: "failed",
        championshipId: id,
        name,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }
  return out
}
