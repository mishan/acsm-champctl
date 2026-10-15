/**
 * Recordings by round: one folder per track, from the first session on it to
 * the end of the championship event raced there, clips and incidents beside
 * the sessions they're cut from.
 *
 * No clock or schedule decides it. The server's session list does: a practice
 * server runs one session, over and over; a championship event runs its
 * practice, qualifying and races as one list, and its last session ends the
 * round. A new track starts one too.
 */

import { mkdir, readdir, rename, stat } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

import { readJournal } from "./journal.js"

export interface Round {
  folder: string
  /** Track and layout, as the folder names them. */
  place: string
  /** The event's last session has begun: whatever comes next is the next round. */
  over: boolean
}

export interface SessionPlace {
  place: string
  /** The session's index in the server's list, and how many the list has. */
  index: number
  count: number
}

/**
 * Which round a session starting now belongs to. `date` names a new round's
 * folder; `taken` says whether a folder name is already used.
 */
export function roundFor(
  last: Round | undefined,
  s: SessionPlace,
  date: string,
  taken: (folder: string) => boolean,
): Round {
  const over = s.count > 1 && s.index === s.count - 1
  // Rejoining in the event's last session is still that round.
  if (last && last.place === s.place && (!last.over || over)) return { ...last, over }
  let folder = `${date}-${s.place}`
  for (let n = 2; taken(folder); n++) folder = `${date}-${s.place}-${n}`
  return { folder, place: s.place, over }
}

export function placeOf(track: string, trackConfig: string): string {
  return `${slug(track)}${trackConfig ? `-${slug(trackConfig)}` : ""}`
}

export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "x"
  )
}

/** A day as the league counts it: "2026-10-13". */
export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(at)
}

const ROUND = /^\d{4}-\d{2}-\d{2}-/

/** Files with this ending, in the folder and in its round folders, as paths relative to it. */
export async function listRecordings(dir: string, ending: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.isFile() && e.name.endsWith(ending)) out.push(e.name)
    else if (e.isDirectory() && ROUND.test(e.name)) {
      for (const f of await readdir(join(dir, e.name)).catch(() => [] as string[])) {
        if (f.endsWith(ending)) out.push(`${e.name}/${f}`)
      }
    }
  }
  return out
}

/** The newest round on disk, for a recorder starting again: it may still be going. */
export async function lastRound(dir: string): Promise<Round | undefined> {
  const journals = (await listRecordings(dir, ".ndjson.gz"))
    .filter((f) => f.includes("/"))
    // The recorder's timestamp leads each name, so newest first whichever round it's in.
    .sort((a, b) => basename(b).localeCompare(basename(a)))
  // Past any with no session record: a recorder killed just after a session
  // changed leaves one empty.
  for (const file of journals) {
    for await (const r of readJournal(join(dir, file))) {
      if (r.t !== "session") break
      return {
        folder: dirname(file),
        place: placeOf(r.track, r.trackConfig),
        over: (r.sessionCount ?? 1) > 1 && r.sessionIndex === (r.sessionCount ?? 1) - 1,
      }
    }
  }
  return undefined
}

/** A journal written to this recently may still be recording: it's left where it is. */
const LIVE_MS = 10 * 60_000

/**
 * Files recordings from before round folders into them, oldest first, with
 * their replays and the clips cut from them. Those journals don't say which
 * sessions were the event's, so a run of sessions on one track is one round.
 * Moves nothing with `dryRun`; either way, says what goes where.
 */
export async function organize(
  dir: string,
  timeZone: string,
  o: { dryRun?: boolean; now?: number } = {},
): Promise<{ from: string; to: string }[]> {
  const now = o.now ?? Date.now()
  const top = (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => e.name)
  const folders = new Set(
    (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name),
  )
  const moves: { from: string; to: string }[] = []
  // Not the newest folder's round: everything still loose is older than it.
  let round: Round | undefined
  for (const journal of top.filter((f) => f.endsWith(".ndjson.gz")).sort()) {
    if (now - (await stat(join(dir, journal))).mtimeMs < LIVE_MS) continue
    let session:
      | { track: string; trackConfig: string; sessionIndex?: number; sessionCount?: number }
      | undefined
    for await (const r of readJournal(join(dir, journal))) {
      if (r.t === "session") session = r
      break
    }
    if (!session) continue
    const started = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(journal)
    if (!started) continue
    const at = new Date(`${started[1]}T${started[2]}:${started[3]}:${started[4]}.${started[5]}Z`)
    round = roundFor(
      round,
      {
        place: placeOf(session.track, session.trackConfig),
        index: session.sessionIndex ?? 0,
        count: session.sessionCount ?? 1,
      },
      localDate(at, timeZone),
      (f) => folders.has(f),
    )
    folders.add(round.folder)
    const stem = journal.slice(0, -".ndjson.gz".length)
    for (const f of top) {
      if (f === journal || (f.startsWith(stem) && f.endsWith(".acreplay"))) {
        moves.push({ from: f, to: `${round.folder}/${f}` })
      }
    }
  }
  if (!o.dryRun) {
    for (const m of moves) {
      await mkdir(join(dir, m.to, ".."), { recursive: true })
      await rename(join(dir, m.from), join(dir, m.to))
    }
  }
  return moves
}
