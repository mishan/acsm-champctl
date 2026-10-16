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

import { stat } from "node:fs/promises"
import { basename, join } from "node:path"

import { type CollisionSummary, summarize } from "../spectator/incident.js"
import { readJournal } from "../spectator/journal.js"
import { listRecordings } from "../spectator/rounds.js"

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
  /** Where each slot's car was, about once a second: enough to say who was near whom. */
  positions: Map<number, { at: number[]; x: number[]; z: number[] }>
}

/** Seconds between the positions kept: a car covers 90 m in one, and a race runs to thousands. */
const POSITION_EVERY_MS = 1000

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

/** The journals in the folder and its round folders, newest first. */
export async function journalNames(recordings: string): Promise<JournalName[]> {
  const out: JournalName[] = []
  for (const file of await listRecordings(recordings, ".ndjson.gz")) {
    const m = /^((\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z)-(.*)\.ndjson\.gz$/.exec(
      basename(file),
    )
    if (!m) continue
    const started = Date.parse(`${m[2]}T${m[3]}:${m[4]}:${m[5]}.${m[6]}Z`)
    out.push({ file, key: m[1] as string, started, rest: m[7] as string })
  }
  return out.sort((a, b) => b.started - a.started)
}

const types = new Map<string, Promise<number | undefined>>()

/**
 * The session's type, 2 qualifying and 3 a race, from the journal's first
 * record: read once, as it never changes, so a list of every recent session
 * stays quick.
 */
export function sessionType(recordings: string, file: string): Promise<number | undefined> {
  const path = join(recordings, file)
  let type = types.get(path)
  if (!type) {
    type = (async () => {
      for await (const r of readJournal(path)) return r.t === "session" ? r.type : undefined
      return undefined
    })().catch(() => undefined)
    types.set(path, type)
  }
  return type
}

/** `file` is relative to `recordings`, as `journalNames` gives it. */
export async function indexJournal(
  recordings: string,
  file: string,
  now = Date.now(),
): Promise<JournalIndex> {
  const path = join(recordings, file)
  const known = cache.get(path)
  if (known && now - known.readAt < RECHECK_LIVE_MS) return known.index
  const { mtimeMs } = await stat(path)
  // Again: another call may have started the read while this one waited on stat.
  const latest = cache.get(path)
  if (latest?.mtimeMs === mtimeMs) return latest.index
  // The promise, so a second keystroke waits on the first read rather than starting its own.
  const index = read(path, file)
  cache.set(path, { mtimeMs, readAt: now, index })
  index.catch(() => cache.delete(path))
  return index
}

async function read(path: string, file: string): Promise<JournalIndex> {
  let session: JournalIndex["session"] | undefined
  let start = 0
  let end = 0
  const cars: JournalCar[] = []
  const current = new Map<number, JournalCar>()
  const names = new Map<number, string>()
  const collisions: CollisionSummary[] = []
  const positions: JournalIndex["positions"] = new Map()
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
    } else if (r.t === "pos") {
      const p = positions.get(r.car.carId) ?? { at: [], x: [], z: [] }
      positions.set(r.car.carId, p)
      if (r.at - (p.at.at(-1) ?? Number.NEGATIVE_INFINITY) < POSITION_EVERY_MS) continue
      p.at.push(r.at)
      p.x.push(r.car.pos[0])
      p.z.push(r.car.pos[2])
    }
  }
  if (!session) throw new Error(`${basename(path)} has no session record`)
  return { file, session, start, end, cars, collisions, positions }
}

/** Who was in a slot at a moment, by the recorder's clock. */
export function carAt(index: JournalIndex, carId: number, at: number): JournalCar | undefined {
  let found: JournalCar | undefined
  for (const c of index.cars) if (c.carId === carId && c.from <= at) found = c
  return found
}

/** Where a slot's car was at a moment, from the nearest position kept, if one is within two seconds. */
export function whereAt(
  index: JournalIndex,
  carId: number,
  at: number,
): [number, number] | undefined {
  const p = index.positions.get(carId)
  if (!p || p.at.length === 0) return undefined
  let lo = 0
  let hi = p.at.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (p.at[mid]! < at) lo = mid + 1
    else hi = mid
  }
  const i = lo > 0 && at - p.at[lo - 1]! < p.at[lo]! - at ? lo - 1 : lo
  return Math.abs(p.at[i]! - at) <= 2000 ? [p.x[i]!, p.z[i]!] : undefined
}
