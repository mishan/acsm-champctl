/**
 * Reading what content is installed off ACSM's own pages.
 *
 * There is no API for this — `/api/cars` and friends are 404 on 2.4.15,
 * measured — but `/cars` and `/tracks` are server-rendered lists that Public
 * Access serves without credentials, and each entry pairs a folder name with
 * the name a person recognises:
 *
 *   <h3 class="mb-0">Brands Hatch</h3> … <a href="/track/ks_brands_hatch">
 *
 * Both halves are needed and for different reasons. The folder name is what
 * goes into a championship — `RaceSetup.Track`, the class `AvailableCars` —
 * and the display name is the only part anybody actually knows. Nobody setting
 * up a race night knows that Brands Hatch is `ks_brands_hatch`, which is the
 * whole reason the new-championship screen asks for one and gets the other.
 *
 * Its own module rather than part of `listing.ts` because the two answer
 * different questions about different pages, and share only cheerio.
 */

import * as cheerio from "cheerio"

import { CARS_PATH, TRACKS_PATH } from "./paths.js"
import type { InstalledContent, InstalledItem } from "./types.js"

export type { InstalledContent, InstalledItem }

/**
 * More pages than any server will have, and still terminating.
 *
 * `/cars` pages at fifty; a stock install is 178 cars, and a league with mod
 * content runs to several hundred. Forty pages is two thousand cars.
 */
const MAX_PAGES = 40

/**
 * Cars and tracks from one rendered listing page.
 *
 * **Two builds, two shapes, and neither is an `<a>` with the name in it.**
 * 2.4.15 renders an empty overlay link beside the card —
 * `<a href="/car/abarth500" class="car-link"></a>` — with the name in an `<h3>`
 * inside it. 1.7.9 has no anchor at all: the card itself carries
 * `data-href="/track/spa"` and JavaScript makes it clickable, and it labels
 * that card `card-car` whether it holds a car or a track.
 *
 * So the link is looked for in either attribute, and the name is looked for by
 * walking out to whatever encloses both. Reading the link's own text — which
 * is what the championships listing does, where the name *is* the link text —
 * gives every entry an empty name on 2.4.15 and finds no entries at all on
 * 1.7.9. Both were a screen full of folder ids, which is the thing this exists
 * to prevent.
 *
 * An entry with no heading yields the folder name instead of being dropped. An
 * unnamed car is still an installed car, and a list missing entries is worse
 * than a list with an ugly one — the screen only offers what is in here.
 */
export function itemsFrom(html: string, kind: "car" | "track"): InstalledItem[] {
  const $ = cheerio.load(html)
  const out = new Map<string, InstalledItem>()

  $(`a[href^="/${kind}/"], [data-href^="/${kind}/"]`).each((_, el) => {
    const node = $(el)
    const link = node.attr("href") ?? node.attr("data-href") ?? ""
    // `/car/{id}` only. `/car/{id}/delete` sits beside it and names the same
    // car, and deeper paths are actions rather than listings.
    const segments = link.split("?")[0]!.split("/").filter(Boolean)
    if (segments.length !== 2 || segments[0] !== kind) return
    const id = decodeSafely(segments[1]!)
    if (!id || out.has(id)) return

    out.set(id, { id, name: headingFor(node) || id })
  })

  return [...out.values()]
}

/**
 * The name shown next to a link, wherever the build happens to put it.
 *
 * Inside the element on 1.7.9, where the card carries the link. Up in the
 * enclosing wrapper on 2.4.15, where the link is an empty overlay next to the
 * card. Tried in that order and then given up on, rather than reaching further
 * and further out — a heading found three levels up is as likely to be the
 * page's title as this entry's name.
 */
function headingFor(node: ReturnType<ReturnType<typeof cheerio.load>>): string {
  const own = node.find("h3").first().text().trim()
  if (own) return own
  return node.parent().find("h3").first().text().trim()
}

/**
 * Further pages of a listing, as paths to fetch.
 *
 * `/cars` links `?page=0`, `?page=1` and also `?page=-1`, which is its
 * "previous" control sitting at the first page. Anything that parses as a page
 * number below zero is that control rather than a page, and following it costs
 * a request to be handed page one again.
 */
export function pageLinksFrom(html: string, path: string): string[] {
  const $ = cheerio.load(html)
  const here = new URL(path, BASE)
  const out = new Set<string>()

  $("a[href]").each((_, el) => {
    const url = parse($(el).attr("href") ?? "")
    if (!url) return
    if (url.pathname.replace(/\/$/, "") !== here.pathname.replace(/\/$/, "")) return
    if (url.search === here.search) return
    const page = Number(url.searchParams.get("page"))
    if (Number.isFinite(page) && page < 0) return
    out.add(`${url.pathname}${url.search}`)
  })

  return [...out]
}

const BASE = "http://acsm.invalid/"

function parse(href: string): URL | undefined {
  try {
    return new URL(href, BASE)
  } catch {
    return undefined
  }
}

function decodeSafely(segment: string): string {
  try {
    return decodeURIComponent(segment).trim()
  } catch {
    return segment.trim()
  }
}

/**
 * Everything installed, across every page of both listings.
 *
 * Takes a fetcher for the same reason `walkChampionshipIds` does: the
 * authenticated session and the credential-free reader share one
 * implementation, so they cannot disagree about what is on the server.
 *
 * Reaching the page bound stops rather than throws, which is the opposite of
 * the championships walk and deliberately so. There, a short list is a silently
 * incomplete archive. Here it is a few cars missing from a dropdown, and
 * failing the screen outright — no cars at all — would be the worse answer to
 * having slightly too many.
 */
export async function readInstalledContent(
  fetchPath: (path: string) => Promise<string>,
): Promise<InstalledContent> {
  // One listing failing costs that list, not both. They are separate pages and
  // separate fields, and a manager that serves `/tracks` but not `/cars` should
  // leave the track picker working — the screen already says which of its
  // fields it has nothing to offer for, so an empty list is not a silent
  // failure, it is the message.
  const [cars, tracks] = await Promise.all([
    walkOrNothing(fetchPath, CARS_PATH, "car"),
    walkOrNothing(fetchPath, TRACKS_PATH, "track"),
  ])
  return { cars, tracks }
}

async function walkOrNothing(
  fetchPath: (path: string) => Promise<string>,
  start: string,
  kind: "car" | "track",
): Promise<InstalledItem[]> {
  try {
    return await walk(fetchPath, start, kind)
  } catch {
    return []
  }
}

async function walk(
  fetchPath: (path: string) => Promise<string>,
  start: string,
  kind: "car" | "track",
): Promise<InstalledItem[]> {
  const found = new Map<string, InstalledItem>()
  const seen = new Set<string>()
  const queue = [start]

  for (let page = 0; queue.length > 0 && page < MAX_PAGES; page++) {
    const path = queue.shift()!
    if (seen.has(path)) continue
    seen.add(path)

    const html = await fetchPath(path)
    for (const item of itemsFrom(html, kind)) if (!found.has(item.id)) found.set(item.id, item)
    for (const next of pageLinksFrom(html, path)) if (!seen.has(next)) queue.push(next)
  }

  // Sorted by the name people read, not by folder name, because this is only
  // ever used to fill a list somebody scrolls. `localeCompare` so "Ätna" lands
  // where a person expects rather than after "Zandvoort".
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}
