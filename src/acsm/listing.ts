/**
 * Reading ACSM's HTML listing pages.
 *
 * Its own module rather than part of `write.ts` because both the authenticated
 * session and the credential-free reader need it, and `client.ts` importing
 * `write.ts` would close a cycle: `client -> write -> session -> client`.
 */

import * as cheerio from "cheerio"

import { CHAMPIONSHIPS_PATH } from "./paths.js"

const MAX_PAGES = 20

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Championship IDs from the championships page.
 *
 * The listing HTML is the only way to enumerate them on a build without
 * `/api/championships/list.json` — which is 2.4.5 and 2.4.15, measured, as well
 * as the public build (docs/acsm-write-path.md §6).
 *
 * Walks the parsed DOM for anchors and reads ids out of their `href`, rather
 * than running a pattern over the markup. A regular expression over HTML gets
 * the easy cases and then quietly gets a hard one wrong: a UUID inside a
 * comment, a script string, or an attribute that isn't a link all match, and
 * none of them is a championship listed on this page. cheerio is already a
 * dependency, for exactly this.
 *
 * Matching a UUID inside a parsed `href` is a different thing from matching one
 * inside markup — by that point the parser has established the structure, and
 * what's left is a URL, parsed as a URL.
 */
export function championshipIdsFrom(html: string): string[] {
  return [...collect(html).ids]
}

/**
 * Further pages of the championship listing, as paths to fetch.
 *
 * The archive's job is to not lose history, so a listing it reads only the
 * first page of is the worst failure it has: it would look like it worked and
 * quietly stop recording everything past page one.
 *
 * Measured on 2.4.5 with 24 championships, and on ac.batlracing.com itself,
 * whose listing reaches back to 2023: one page, no pagination links, even
 * though the template ships pagination markup. So this returns nothing today,
 * and the archive's existing history is complete rather than truncated. That
 * mattered enough to check, since a silently short listing would have been
 * invisible in everything the archive had already collected.
 *
 * Returning nothing is also why it is written to find links rather than to
 * construct them. Guessing at `?page=` and looping until a page came back
 * empty would be a guess about a shape nobody has seen, and it would look like
 * it worked too. Any anchor back to the listing with a different query is a
 * further page, whatever the parameter turns out to be called.
 */
export function championshipPageLinks(html: string, currentPath = CHAMPIONSHIPS_PATH): string[] {
  const here = new URL(currentPath, BASE)
  const out = new Set<string>()
  for (const href of collect(html).hrefs) {
    const url = parse(href)
    if (!url) continue
    if (url.pathname.replace(/\/$/, "") !== CHAMPIONSHIPS_PATH) continue
    if (url.search === here.search) continue
    out.add(`${url.pathname}${url.search}`)
  }
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

function collect(html: string): { ids: Set<string>; hrefs: string[] } {
  const $ = cheerio.load(html)
  const ids = new Set<string>()
  const hrefs: string[] = []

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href")
    if (!href) return
    hrefs.push(href)

    // An arbitrary base so a relative href resolves; only the path is read.
    const url = parse(href)
    if (!url) return
    const segments = url.pathname.split("/").filter(Boolean)

    // `/championship/{id}` and `/championship/{id}/anything`, but not
    // `/championships` and not a link that merely mentions a UUID elsewhere.
    const at = segments.indexOf("championship")
    if (at === -1) return
    const id = segments[at + 1]
    if (id && UUID.test(id)) ids.add(id.toLowerCase())
  })

  return { ids, hrefs }
}

/**
 * Every championship id across the listing and any further pages.
 *
 * Takes a fetcher so the authenticated session and the credential-free reader
 * share one implementation — the archive and the recon scripts must not
 * disagree about what is on the server.
 *
 * Bounded, because a listing that links back to itself under a query we treat
 * as "different" would otherwise loop forever. Twenty pages is far more than
 * any league will have and still terminates — and reaching it *throws* rather
 * than returning what it has, because a short list here is indistinguishable
 * from a complete one everywhere downstream.
 */
export async function walkChampionshipIds(
  fetchPath: (path: string) => Promise<string>,
): Promise<string[]> {
  const ids = new Set<string>()
  const seen = new Set<string>()
  const queue = [CHAMPIONSHIPS_PATH]

  for (let page = 0; queue.length > 0 && page < MAX_PAGES; page++) {
    const path = queue.shift()!
    if (seen.has(path)) continue
    seen.add(path)

    const html = await fetchPath(path)
    for (const id of championshipIdsFrom(html)) ids.add(id)
    for (const next of championshipPageLinks(html, path)) {
      if (!seen.has(next)) queue.push(next)
    }
  }

  // Hitting the bound with pages still to visit means this list is short, and
  // returning it would be the exact failure the walk exists to prevent: the
  // archive treats a listing error as fatal (archive/ingest.ts) but a *partial*
  // listing looks like a complete one, so it would quietly stop recording
  // everything past the bound and exit 0.
  const unvisited = queue.filter((p) => !seen.has(p))
  if (unvisited.length > 0) {
    throw new Error(
      `Gave up walking the championships listing after ${MAX_PAGES} pages with ` +
        `${unvisited.length} still to visit, so this list is incomplete and must not be used. ` +
        `Either this server has more championships than champctl expects, or the listing links ` +
        `back on itself in a shape walkChampionshipIds treats as new pages. First unvisited: ` +
        `${unvisited[0]}`,
    )
  }

  return [...ids]
}
