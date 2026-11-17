/**
 * The installed cars and tracks, as every part of champctl reads them: one
 * held list, kept in the response cache's database that champctl web and the
 * bot share, so one of them reading it a week is enough for both.
 */

import { DateTime } from "luxon"

import { HttpAcsmReader } from "./client.js"
import type { InstalledContent } from "./content.js"
import type { KeptStore } from "./content-store.js"
import { ContentCache } from "./content-cache.js"
import { contentStore } from "./content-store.js"

export interface InstalledContentOptions {
  baseUrl: string
  /** The response cache. Without one, every start reads the list again. */
  cache?: KeptStore
  /** No pause between pages at all: `--unthrottled-reads`. */
  unthrottled?: boolean
  userAgent?: string
  log?: (line: string) => void
  /** What changed in what's installed, said in a sentence or two, whenever it does. */
  onChange?: (said: string) => void
}

/** A league installs a car every few months; a week-old list is as good as a new one. */
const HELD_MS = 7 * 24 * 60 * 60 * 1000

export function installedContent(o: InstalledContentOptions): ContentCache {
  /**
   * A reader of its own, at its own pace.
   *
   * Both halves matter, and the second one is a number somebody has to sit
   * through. Sharing the interactive limiter meant a walk took every slot in
   * the window and the `/api/championships` request from the same screen
   * queued behind it — the championship list hung while champctl was being
   * polite about a dropdown. But keeping the interactive *rate* was just as
   * bad: five requests per twenty seconds is a quarter of a request a second,
   * and BATL's 504 cars are eleven pages of fifty, so reading them took over a
   * minute of somebody watching a field say "Reading what's installed".
   *
   * That rate is not protecting anything here. ACSM limits `/login` and
   * nothing else — measured on 2.4.15, eight rapid `GET /championships` and
   * eight `GET /healthcheck.json` all answered 200 while the sixth login in a
   * second got a 429. champctl's read limiter is self-imposed politeness for a
   * person clicking around a manager all evening, and this is one bulk read of
   * static pages that happens at boot and at most weekly after.
   *
   * Four a second, so eleven pages is under three seconds and a burst that
   * size is nothing a web server notices.
   */
  const reader = new HttpAcsmReader({
    baseUrl: o.baseUrl,
    ...(o.userAgent ? { userAgent: o.userAgent } : {}),
    ...(o.unthrottled
      ? { rateLimit: false as const }
      : { rateLimit: { limit: 4, windowMs: 1000 } }),
  })

  return new ContentCache({
    ttlMs: HELD_MS,
    load: async () => {
      // Timed and logged, because how long this takes is a property of the
      // league's manager — how many cars they have installed, how far away it
      // is — and the only way anyone found out it was slow was by watching a
      // field say "Reading what's installed" for a minute.
      const startedAt = Date.now()
      const value = await reader.listContent()
      o.log?.(
        `Read ${value.cars.length} cars and ${value.tracks.length} tracks from Server Manager ` +
          `in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
      )
      return value
    },
    // Kept across restarts, in the response cache's own database. Re-walking
    // `/cars` on every boot is minutes against a league's manager, and the
    // person who just restarted champctl is usually the person about to open
    // the screen. `--no-cache` opts out of this too, which is what that flag
    // means.
    ...(o.cache ? { store: contentStore(o.cache, o.baseUrl) } : {}),
    onChange: (before, after) => {
      const said = changes(before, after)
      if (said) o.onChange?.(said)
    },
    believe: (next, held) => {
      const why = unbelievable(next, held)
      if (why) o.log?.(`Kept the list of what's installed: ${why}.`)
      return why
    },
  })
}

/**
 * Why a new read of what's installed looks like a failed one, if it does. A
 * listing Server Manager fails to serve reads as an empty one, and taken, it
 * would leave every picker empty for a week; nobody uninstalls half a league's
 * cars between two reads.
 */
export function unbelievable(
  next: InstalledContent,
  held: InstalledContent | undefined,
): string | undefined {
  for (const kind of ["cars", "tracks"] as const) {
    const was = held?.[kind].length ?? 0
    if (was && next[kind].length < was / 2) {
      return `it has ${next[kind].length} ${kind}, where there were ${was}`
    }
  }
  return undefined
}

/**
 * An operator's "read it again now": the same reconcile as the daily one, with
 * what's held served until it's in, so a refresh nobody needed costs a few
 * seconds of reading and nothing else. Says what changed, for them.
 */
export async function refreshContent(cache: ContentCache): Promise<string> {
  let read: Awaited<ReturnType<ContentCache["reconcile"]>>
  try {
    read = await cache.reconcile()
  } catch (e) {
    throw new Error(
      `I couldn't read Server Manager (${(e as Error).message}). The list of what's installed is unchanged.`,
    )
  }
  const { before, after } = read
  return (
    (before && changes(before, after)) ??
    `Nothing changed: Server Manager has the ${after.cars.length} cars and ${after.tracks.length} tracks champctl had.`
  )
}

/** What changed between two reads of what's installed, by id; undefined if nothing. */
export function changes(before: InstalledContent, after: InstalledContent): string | undefined {
  const said: string[] = []
  for (const kind of ["cars", "tracks"] as const) {
    const was = new Map(before[kind].map((i) => [i.id, i.name]))
    const now = new Map(after[kind].map((i) => [i.id, i.name]))
    const parts = [
      list(
        "added",
        [...now].filter(([id]) => !was.has(id)).map(([, n]) => n),
      ),
      list(
        "removed",
        [...was].filter(([id]) => !now.has(id)).map(([, n]) => n),
      ),
      list(
        "renamed",
        [...now].flatMap(([id, n]) => {
          const old = was.get(id)
          return old !== undefined && old !== n ? [`${old} to ${n}`] : []
        }),
      ),
    ].filter((p) => p !== undefined)
    if (parts.length) said.push(`Server Manager's ${kind} changed: ${parts.join("; ")}.`)
  }
  return said.length ? said.join("\n") : undefined
}

const list = (what: string, names: string[]): string | undefined =>
  names.length ? `${what} ${names.join(", ")}` : undefined

/** The hour of the day the list is read again, in the league's time zone: after the 04:41 backup. */
const RECONCILE_HOUR = 5

/**
 * Reads what's installed again once a day, behind what's held. Checked every
 * five minutes, so a restart or a clock change can't skip a day; tried once a
 * day whether or not the read is taken, so a manager that's down, or a read
 * `unbelievable` refuses, isn't asked again all day.
 */
export function reconcileDaily(
  cache: ContentCache,
  timeZone: string,
  warn: (line: string) => void,
): () => void {
  let tried: number | undefined
  const timer = setInterval(() => {
    const now = new Date()
    if (!reconcileDue(Math.max(cache.readAt() ?? 0, tried ?? 0), now, timeZone)) return
    tried = now.getTime()
    void cache.reconcile().catch((e: unknown) => {
      warn(`The daily read of what's installed failed: ${(e as Error).message}`)
    })
  }, 5 * 60_000)
  // Not what keeps the process up: a failed start still exits.
  timer.unref()
  return () => clearInterval(timer)
}

/** Whether the daily read is due: it's past today's hour and the list was read before it. */
export function reconcileDue(readAt: number | undefined, now: Date, timeZone: string): boolean {
  const today = DateTime.fromJSDate(now, { zone: timeZone })
    .set({ hour: RECONCILE_HOUR, minute: 0, second: 0, millisecond: 0 })
    .toMillis()
  return now.getTime() >= today && (readAt === undefined || readAt < today)
}
