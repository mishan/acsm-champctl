/**
 * What `/incident` needs to know about the recordings, quickly: which sessions
 * there are, who drove in each, and the collisions in it.
 *
 * Discord gives autocomplete three seconds, and a race's journal is tens of
 * MB, so each is read once and kept until it changes on disk. The session being
 * recorded right now changes every few seconds and is read again each time.
 */

import { readdir, stat } from "node:fs/promises"
import { basename, join } from "node:path"

import { type CollisionSummary, listCollisions } from "../spectator/incident.js"
import { readJournal } from "../spectator/journal.js"

export interface JournalCar {
  carId: number
  driver: string
  guid?: string
}

export interface JournalIndex {
  file: string
  session: { name: string; track: string; type: number }
  /** Recorder clock, ms, at the session's start. */
  start: number
  cars: JournalCar[]
  collisions: CollisionSummary[]
}

const cache = new Map<string, { mtimeMs: number; index: JournalIndex }>()

/** A journal by its file name, and only one in the folder: the name comes from Discord. */
export async function journalPath(recordings: string, file: string): Promise<string | undefined> {
  if (basename(file) !== file || !file.endsWith(".ndjson.gz")) return undefined
  const files = await readdir(recordings).catch(() => [] as string[])
  return files.includes(file) ? join(recordings, file) : undefined
}

/** The journals in the folder, newest first, by the time the recorder put at the front of the name. */
export async function journalFiles(recordings: string): Promise<string[]> {
  const files = await readdir(recordings).catch(() => [] as string[])
  return files
    .filter((f) => f.endsWith(".ndjson.gz"))
    .sort()
    .reverse()
}

export async function indexJournal(path: string): Promise<JournalIndex> {
  const { mtimeMs } = await stat(path)
  const known = cache.get(path)
  if (known?.mtimeMs === mtimeMs) return known.index
  let session: JournalIndex["session"] | undefined
  let start = 0
  const cars = new Map<number, JournalCar>()
  for await (const r of readJournal(path)) {
    if (r.t === "session" && !session) {
      session = { name: r.name, track: r.track, type: r.type }
      start = r.at
    } else if (r.t === "car" && r.driver) {
      const prev = cars.get(r.carId)
      cars.set(r.carId, {
        carId: r.carId,
        driver: r.driver,
        ...((r.guid ?? (prev?.driver === r.driver ? prev.guid : undefined))
          ? { guid: r.guid ?? prev!.guid! }
          : {}),
      })
    }
  }
  if (!session) throw new Error(`${basename(path)} has no session record`)
  const index = {
    file: basename(path),
    session,
    start,
    cars: [...cars.values()],
    collisions: await listCollisions(path),
  }
  cache.set(path, { mtimeMs, index })
  return index
}
