/**
 * What `/incident` needs to know about the recordings, quickly: which sessions
 * there are, who drove in each, and the collisions in it.
 *
 * Discord gives autocomplete three seconds, and a race's journal is tens of
 * MB, so the session list comes from file names alone and a journal is only
 * read once someone picks it, then kept until it changes. The session being
 * recorded right now changes every few seconds, so it's read again at most
 * every ten.
 */

import { readdir, stat } from "node:fs/promises"
import { basename } from "node:path"

import { type CollisionSummary, summarize } from "../spectator/incident.js"
import { readJournal } from "../spectator/journal.js"

/** One driver's time in one slot: a slot changes hands when someone leaves and another joins. */
export interface JournalCar {
  carId: number
  driver: string
  guid?: string
  /** Recorder clock, ms, when they took the slot. */
  from: number
}

export interface JournalIndex {
  file: string
  session: { name: string; track: string; type: number }
  /** Recorder clock, ms, at the session's start and at the last record. */
  start: number
  end: number
  cars: JournalCar[]
  collisions: CollisionSummary[]
}

export interface JournalName {
  file: string
  /** The recorder's timestamp at the front of the name: short enough for a Discord choice. */
  key: string
  started: number
  /** What follows it: track, layout and session type, as the recorder wrote them. */
  rest: string
}

const RECHECK_LIVE_MS = 10_000
const cache = new Map<string, { mtimeMs: number; readAt: number; index: Promise<JournalIndex> }>()

/** The journals in the folder, newest first. */
export async function journalNames(recordings: string): Promise<JournalName[]> {
  const files = await readdir(recordings).catch(() => [] as string[])
  const out: JournalName[] = []
  for (const file of files) {
    const m = /^((\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z)-(.*)\.ndjson\.gz$/.exec(file)
    if (!m) continue
    const started = Date.parse(`${m[2]}T${m[3]}:${m[4]}:${m[5]}.${m[6]}Z`)
    out.push({ file, key: m[1] as string, started, rest: m[7] as string })
  }
  return out.sort((a, b) => b.started - a.started)
}

export async function indexJournal(path: string, now = Date.now()): Promise<JournalIndex> {
  const known = cache.get(path)
  if (known && now - known.readAt < RECHECK_LIVE_MS) return known.index
  const { mtimeMs } = await stat(path)
  // Again: another call may have started the read while this one waited on stat.
  const latest = cache.get(path)
  if (latest?.mtimeMs === mtimeMs) return latest.index
  // The promise, so a second keystroke waits on the first read rather than starting its own.
  const index = read(path)
  cache.set(path, { mtimeMs, readAt: now, index })
  index.catch(() => cache.delete(path))
  return index
}

async function read(path: string): Promise<JournalIndex> {
  let session: JournalIndex["session"] | undefined
  let start = 0
  let end = 0
  const cars: JournalCar[] = []
  const current = new Map<number, JournalCar>()
  const names = new Map<number, string>()
  const collisions: CollisionSummary[] = []
  for await (const r of readJournal(path)) {
    end = r.at
    if (r.t === "session" && !session) {
      session = { name: r.name, track: r.track, type: r.type }
      start = r.at
    } else if (r.t === "car" && r.driver) {
      names.set(r.carId, r.driver)
      const prev = current.get(r.carId)
      if (prev?.driver === r.driver && (!r.guid || prev.guid === r.guid)) continue
      if (prev?.driver === r.driver && !prev.guid && r.guid) {
        prev.guid = r.guid
        continue
      }
      const car: JournalCar = {
        carId: r.carId,
        driver: r.driver,
        from: r.at,
        ...(r.guid ? { guid: r.guid } : {}),
      }
      cars.push(car)
      current.set(r.carId, car)
    } else if (r.t === "collision") {
      collisions.push(summarize(r, collisions.length, names))
    }
  }
  if (!session) throw new Error(`${basename(path)} has no session record`)
  return { file: basename(path), session, start, end, cars, collisions }
}

/** Who was in a slot at a moment, by the recorder's clock. */
export function carAt(index: JournalIndex, carId: number, at: number): JournalCar | undefined {
  let found: JournalCar | undefined
  for (const c of index.cars) if (c.carId === carId && c.from <= at) found = c
  return found
}
