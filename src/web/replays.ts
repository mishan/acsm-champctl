/**
 * The race recorder's replays, for anyone to download: a page listing them
 * and the files themselves. No login, as a league's results are public; the
 * page names tracks and sessions, and the driver names stay in the files.
 */

import { createReadStream } from "node:fs"
import { open, readdir, stat } from "node:fs/promises"
import { join } from "node:path"

import type { FastifyInstance } from "fastify"

import { readJournal } from "../spectator/journal.js"

export interface ReplayListing {
  file: string
  track: string
  session: string
  /** When the recording began, ms since the epoch. */
  started: number
  durationS: number
  cars: number
  bytes: number
}

/** What a replay's own header says: its track, layout, car count and length. */
async function header(path: string): Promise<{ track: string; cars: number; durationS: number }> {
  const f = await open(path, "r")
  try {
    const { buffer, bytesRead } = await f.read(Buffer.alloc(1024), 0, 1024, 0)
    const b = buffer.subarray(0, bytesRead)
    let o = 4
    const interval = b.readDoubleLE(o)
    o += 8
    const str = (): string => {
      const n = b.readUInt32LE(o)
      o += 4 + n
      return b.subarray(o - n, o).toString("utf8")
    }
    str() // weather
    const track = str()
    const layout = str()
    const cars = b.readUInt32LE(o)
    const frames = b.readUInt32LE(o + 4)
    return {
      track: layout ? `${track} (${layout})` : track,
      cars,
      // Frames sit at both ends of the session, so there is one interval fewer.
      durationS: Math.round(((Math.max(1, frames) - 1) * interval) / 1000),
    }
  } finally {
    await f.close()
  }
}

/** The session's name, from the journal the replay was written from, if it's beside it. */
async function sessionName(journal: string): Promise<string> {
  try {
    for await (const r of readJournal(journal)) {
      if (r.t === "session") return r.name
    }
  } catch {
    // A replay copied somewhere without its journal is still worth listing.
  }
  return ""
}

/** The recording's start, from the time the recorder put at the front of the name. */
function startedFrom(file: string): number {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(file)
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : Number.NaN
}

export async function listReplays(dir: string): Promise<ReplayListing[]> {
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) =>
    f.endsWith(".acreplay"),
  )
  const out: ReplayListing[] = []
  for (const file of files) {
    const path = join(dir, file)
    try {
      const [h, s, session] = await Promise.all([
        header(path),
        stat(path),
        sessionName(path.replace(/\.acreplay$/, ".ndjson.gz")),
      ])
      out.push({ file, ...h, session, started: startedFrom(file), bytes: s.size })
    } catch {
      // Still being written, or not a replay: leave it out rather than fail the page.
    }
  }
  return out.sort((a, b) => b.started - a.started || b.file.localeCompare(a.file))
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

function duration(s: number): string {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h} h ${m} min` : m ? `${m} min` : `${s} s`
}

export function replaysPage(list: readonly ReplayListing[], timeZone: string): string {
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  })
  const rows = list
    .map(
      (r) =>
        `<tr><td>${Number.isNaN(r.started) ? "" : esc(when.format(r.started))}</td>` +
        `<td>${esc(r.track)}</td><td>${esc(r.session)}</td><td>${duration(r.durationS)}</td>` +
        `<td>${r.cars}</td><td><a href="/replays/${encodeURIComponent(r.file)}" download>` +
        `${(r.bytes / 1e6).toFixed(1)} MB</a></td></tr>`,
    )
    .join("\n")
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Race replays</title>
<style>
:root { color-scheme: light dark; --fg: #1d1d1f; --bg: #fafaf8; --line: #ddd; --link: #2e6fb5 }
@media (prefers-color-scheme: dark) { :root { --fg: #e8e8e6; --bg: #161616; --line: #333; --link: #7fb2ea } }
body { font: 15px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); margin: 0 auto; max-width: 960px; padding: 16px }
table { border-collapse: collapse; width: 100% } th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line) }
a { color: var(--link) } .wrap { overflow-x: auto }
</style></head><body>
<h1>Race replays</h1>
<p>Every session on the server, recorded. Save a file into <code>Documents/Assetto Corsa/replay</code> and open it from the game's replay menu.</p>
${list.length ? `<div class="wrap"><table><thead><tr><th>Started</th><th>Track</th><th>Session</th><th>Length</th><th>Cars</th><th>Download</th></tr></thead><tbody>\n${rows}\n</tbody></table></div>` : "<p>No replays yet.</p>"}
</body></html>`
}

export function registerReplays(app: FastifyInstance, dir: string, timeZone: string): void {
  app.get("/replays", async (_req, reply) =>
    reply.type("text/html; charset=utf-8").send(replaysPage(await listReplays(dir), timeZone)),
  )
  app.get<{ Params: { file: string } }>("/replays/:file", async (req, reply) => {
    const { file } = req.params
    // Only a name the folder lists, so nothing outside it can be asked for.
    const files = await readdir(dir).catch(() => [] as string[])
    if (!file.endsWith(".acreplay") || !files.includes(file)) {
      return reply.code(404).send({ error: { code: "not-found", message: "No such replay." } })
    }
    return reply
      .type("application/octet-stream")
      .header("Content-Disposition", `attachment; filename="${file}"`)
      .send(createReadStream(join(dir, file)))
  })
}
