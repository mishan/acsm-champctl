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
 * Every track's layouts, off an event edit form.
 *
 * The only place ACSM will say. `/tracks` lists tracks and no layouts, the
 * track page renders `track-layout-wrapper` from JavaScript, and
 * `ui/meta_data.json` carries a `layouts` key that was `{}` for a track this
 * very select said had three. `/content/tracks/{id}/ui/` is a browsable
 * directory but holds no layout folders — measured on ac.batlracing.com, where
 * those directories are empty, so a manager's real content is not there to
 * read.
 *
 * The form spells each one `{track}:{layout}` in the option's value, which is
 * why this returns a map rather than a list: the caller has a track and wants
 * that track's layouts.
 *
 * **The option for the layout the event is currently on carries a third
 * segment**, `{track}:{layout}:current`, which is how the page tells its own
 * JavaScript what to select — see `acsm/event-form.ts`. It is a marker, not
 * part of the layout's name, and it is dropped here.
 *
 * A track with no layouts is spelled `{track}:<default>`, and comes back with
 * no entry at all rather than one holding a sentinel. Measured on 2.4.15:
 * `<default>` is never mixed with real layouts — ten tracks had only it, seven
 * had only real ones, none had both — so it means "nothing to choose here" and
 * a caller wants an absent key, not a fake option somebody could pick. What
 * ACSM stores for such a track is `TrackLayout: ""`.
 *
 * **`undefined` when the page carries no such select at all**, which is a
 * different thing from a select offering nothing: the first says champctl is
 * reading a build it does not understand, the second says this server's tracks
 * happen to have one layout each. Collapsing both into `{}` is what let a
 * screen show "one layout" beside every track on a manager where champctl had
 * simply failed to find the list.
 */
/**
 * Track folder name to its layouts. A track with no choice has no entry.
 *
 * Declared here, with the parser that produces it, rather than in the web
 * layer that first needed it: gridmom reads this too, and gridmom is a pure
 * function of an export plus some facts about the server. Reaching into
 * `web/` for a type would make the checker depend on the service.
 */
export type TrackLayouts = Record<string, string[]>

const NO_LAYOUT = "<default>"

export function layoutsFrom(html: string): Record<string, string[]> | undefined {
  const $ = cheerio.load(html)
  const select = $('select[name="TrackLayout"]')
  if (select.length === 0) return undefined

  const out: Record<string, string[]> = {}

  select.find("option").each((_, el) => {
    // The value, not the label: 2.4.15 labels the option with the layout's
    // folder name, but a build that labelled it "Indy Circuit" would still
    // have to submit the folder name, and that is the half champctl stores.
    //
    // Three segments, not two. The option for the layout the event is on
    // carries a marker — `ks_highlands:layout_short:current` — so splitting on
    // the first colon and keeping the rest made the layout `layout_short:current`.
    // That reached the create screen as an option nobody could pick correctly,
    // and would have had gridmom report the layout ACSM is *actually* running
    // as one its track does not have. Exactly one option per page carries it,
    // which is why it went unnoticed.
    const parts = ($(el).attr("value") ?? "").split(":")
    const track = (parts[0] ?? "").trim()
    const layout = (parts[1] ?? "").trim()
    if (!track || !layout || layout === NO_LAYOUT) return

    const list = out[track] ?? []
    if (!list.includes(layout)) list.push(layout)
    out[track] = list
  })

  return out
}

/**
 * Further pages of a listing, as paths to fetch.
 *
 * Keyed by page *number*, not by URL. The paginator links the same page under
 * more than one href — `/cars` and `/cars?page=0` are both the first page, and
 * the "first page" and "previous page" controls point at it again — so
 * treating each distinct query string as a page to visit fetches the first one
 * two or three times over. At five requests per twenty seconds that is a
 * quarter of a minute spent re-reading a page already in hand.
 *
 * `?page=-1` is the "previous" control sitting on the first page, not a page.
 */
export function pageLinksFrom(html: string, path: string): string[] {
  const $ = cheerio.load(html)
  const here = new URL(path, BASE)
  const current = pageNumber(here)
  const out = new Map<number, string>()

  $("a[href]").each((_, el) => {
    const url = parse($(el).attr("href") ?? "")
    if (!url) return
    if (url.pathname.replace(/\/$/, "") !== here.pathname.replace(/\/$/, "")) return
    const page = pageNumber(url)
    if (page < 0 || page === current || out.has(page)) return
    out.set(page, `${url.pathname}${url.search}`)
  })

  return [...out.values()]
}

/** A listing URL's page, with a missing or unreadable `page` meaning the first. */
function pageNumber(url: URL): number {
  const raw = url.searchParams.get("page")
  if (raw === null) return 0
  const n = Number(raw)
  return Number.isInteger(n) ? n : 0
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
  // By page number rather than by path, for the same reason `pageLinksFrom`
  // is: one page has several spellings, and a set of paths lets the first one
  // be fetched again under a different one.
  const seen = new Set<number>()
  const queue = [start]

  for (let fetched = 0; queue.length > 0 && fetched < MAX_PAGES; fetched++) {
    const path = queue.shift()!
    const page = pageNumber(new URL(path, BASE))
    if (seen.has(page)) continue
    seen.add(page)

    const html = await fetchPath(path)
    for (const item of itemsFrom(html, kind)) if (!found.has(item.id)) found.set(item.id, item)
    for (const next of pageLinksFrom(html, path)) {
      if (!seen.has(pageNumber(new URL(next, BASE)))) queue.push(next)
    }
  }

  // Sorted by the name people read, not by folder name, because this is only
  // ever used to fill a list somebody scrolls. `localeCompare` so "Ätna" lands
  // where a person expects rather than after "Zandvoort".
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}
