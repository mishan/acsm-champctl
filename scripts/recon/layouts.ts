#!/usr/bin/env node
/**
 * Where do a track's layouts come from? (plan §3.4, recon item 6.)
 *
 * champctl needs this to offer layouts once a track is picked, and the obvious
 * places do not have it — measured on a 2.4.15 harness:
 *
 * - `/tracks` lists tracks and no layouts.
 * - `/track/{id}` renders `track-layout-wrapper` from JavaScript, with no
 *   layout data anywhere in the HTML.
 * - `/content/tracks/{id}/ui/meta_data.json` has a `layouts` key that was `{}`
 *   for a track ACSM's own form said had three. Not a source of truth.
 * - The championship *event edit form* has a `<select name="TrackLayout">`
 *   carrying every track's layouts as `{track}:{layout}`. Authoritative, but it
 *   needs a login and an existing event to hang off.
 *
 * That leaves one candidate that would fit champctl's credential-free content
 * walk: ACSM serves `/content/` as a static directory tree, and a track with
 * layouts keeps them in subdirectories under `ui/`. The harness could not
 * answer it — a barebones install has no track files at all, so every `ui/`
 * holds nothing but `meta_data.json`. A server with real content can.
 *
 * So this asks one. Read-only, unauthenticated, a handful of requests, paced —
 * safe to point at a league's production manager, which is the whole reason it
 * exists rather than a guess in a commit message.
 *
 *   npm run recon:layouts -- --base-url https://acsm.example
 *   npm run recon:layouts -- --base-url https://acsm.example spa ks_nordschleife
 *
 * Without track names it takes a few off `/tracks`. Names are better: pass ones
 * you know have layouts, since a track that genuinely has none proves nothing.
 */

import { itemsFrom } from "../../src/acsm/content.js"

const USAGE = `recon:layouts — can champctl read a track's layouts?

Usage:
  npm run recon:layouts -- --base-url <url> [track ...]

Options:
  --base-url <url>   the Server Manager to ask. Required.
  --limit <n>        how many tracks to probe when none are named (default 5)
  -h, --help         this

Read-only and unauthenticated. It fetches /tracks and then one directory
listing per track, spaced out.
`

/** Long enough to be a good citizen on a league's manager; short enough to finish. */
const GAP_MS = 400

interface Args {
  baseUrl?: string
  limit: number
  tracks: string[]
  help: boolean
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { limit: 5, tracks: [], help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === "-h" || a === "--help") args.help = true
    else if (a === "--base-url") {
      const v = argv[++i]
      if (v !== undefined) args.baseUrl = v
    } else if (a === "--limit") args.limit = Number(argv[++i])
    else if (a.startsWith("-")) throw new Error(`Unknown option ${a}`)
    else args.tracks.push(a)
  }
  return args
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function get(url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url, { headers: { "User-Agent": "acsm-champctl recon/layouts" } })
  return { status: res.status, body: await res.text() }
}

/**
 * Directory entries from Go's `http.FileServer` listing.
 *
 * It renders one `<a href="name">` per entry, with a trailing slash on
 * directories — which is the whole signal here: a layout is a directory, and
 * `meta_data.json` is not.
 */
export function entries(html: string): { dirs: string[]; files: string[] } {
  const hrefs = [...html.matchAll(/<a href="([^"]+)"/g)].map((m) => decodeURIComponent(m[1] ?? ""))
  return {
    dirs: hrefs.filter((h) => h.endsWith("/")).map((h) => h.replace(/\/$/, "")),
    files: hrefs.filter((h) => !h.endsWith("/")),
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(USAGE)
    return 0
  }
  if (!args.baseUrl) {
    process.stderr.write("Needs --base-url. See --help.\n")
    return 3
  }
  const base = args.baseUrl.replace(/\/+$/, "")

  let tracks = args.tracks
  if (tracks.length === 0) {
    const listing = await get(`${base}/tracks`)
    if (listing.status !== 200) {
      process.stderr.write(`/tracks answered ${listing.status}; is Public Access on?\n`)
      return 3
    }
    tracks = itemsFrom(listing.body, "track")
      .slice(0, Math.max(1, args.limit))
      .map((t) => t.id)
    process.stdout.write(`Taking ${tracks.length} tracks off /tracks: ${tracks.join(", ")}\n\n`)
  }

  let listable = 0
  let withLayouts = 0

  for (const track of tracks) {
    await sleep(GAP_MS)
    const path = `/content/tracks/${encodeURIComponent(track)}/ui/`
    const { status, body } = await get(`${base}${path}`)

    if (status !== 200) {
      process.stdout.write(`${track}: ${path} -> HTTP ${status}\n`)
      continue
    }
    // A page that isn't a directory listing at all — an SPA shell, a login
    // page — has no `<pre>` and usually plenty of markup. Worth telling apart
    // from an empty directory, which is the interesting negative.
    const looksLikeListing = body.includes("<pre>") || body.length < 2000
    const { dirs, files } = entries(body)
    if (!looksLikeListing) {
      process.stdout.write(`${track}: ${path} -> 200 but not a directory listing\n`)
      continue
    }

    listable++
    if (dirs.length > 0) withLayouts++
    process.stdout.write(
      `${track}: ${dirs.length > 0 ? dirs.join(", ") : "(no subdirectories)"}` +
        `${files.length > 0 ? `   [files: ${files.join(", ")}]` : ""}\n`,
    )
  }

  process.stdout.write("\n")
  if (withLayouts > 0) {
    process.stdout.write(
      `Yes. ${withLayouts} of ${tracks.length} tracks list layout directories, so champctl can\n` +
        `read layouts from /content/tracks/{track}/ui/ with no credentials, as part of the\n` +
        `content walk it already does.\n`,
    )
    return 0
  }
  if (listable > 0) {
    process.stdout.write(
      `No. The directory listing works but no track showed a layout subdirectory.\n` +
        `Either these tracks genuinely have none — try naming ones you know do — or this\n` +
        `manager does not keep layouts where champctl would look, and the layout list has\n` +
        `to come from the event form's TrackLayout select instead.\n`,
    )
    return 1
  }
  process.stdout.write(
    `No. This manager does not serve /content/ as a browsable directory, so the layout\n` +
      `list has to come from the event form's TrackLayout select instead.\n`,
  )
  return 1
}

const code = await main(process.argv.slice(2))
process.exitCode = code
