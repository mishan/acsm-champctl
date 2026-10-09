/**
 * What the recorder writes while a session runs: gzipped JSON lines, one file
 * per session, appended as packets arrive.
 *
 * This is a working file, not a format anyone should read. The product is the
 * `.acreplay` built from it once the session ends; the journal exists because
 * a replay's header needs the frame count up front, and holding two hours of
 * a full grid in memory to learn it would cost a few hundred MB. Gzip that is
 * cut off mid-stream still decodes up to the last flush, so a crash loses
 * seconds, not the race.
 */

import { createReadStream, createWriteStream, type WriteStream } from "node:fs"
import { createInterface } from "node:readline"
import { constants, createGunzip, createGzip, type Gzip } from "node:zlib"
import type { CarState, Vec3 } from "./protocol.js"

/** Every record carries `at`, the recorder's own clock in ms. */
export type JournalRecord =
  | {
      t: "session"
      at: number
      serverName: string
      track: string
      trackConfig: string
      name: string
      type: number
      weather?: string
      recorderCarId: number
    }
  | {
      t: "car"
      at: number
      carId: number
      model: string
      skin: string
      driver: string
      guid?: string
      nation?: string
      team?: string
    }
  | { t: "pos"; at: number; car: CarState }
  | { t: "spline"; at: number; carId: number; spline: number }
  | { t: "lap"; at: number; carId: number; lapMs: number; cuts: number }
  | {
      t: "collision"
      at: number
      carId: number
      otherCarId?: number
      impactSpeed: number
      worldPos: Vec3
      relPos: Vec3
    }
  | { t: "connection"; at: number; carId: number; connected: boolean }
  | { t: "end"; at: number; reason: string }

const FLUSH_EVERY_MS = 5_000

export class JournalWriter {
  readonly path: string
  readonly #gzip: Gzip
  readonly #file: WriteStream
  readonly #flushTimer: NodeJS.Timeout
  #closed = false
  #error: Error | undefined

  constructor(path: string) {
    this.path = path
    this.#gzip = createGzip()
    this.#file = createWriteStream(path, { flags: "wx" })
    this.#gzip.pipe(this.#file)
    this.#file.on("error", (e) => {
      this.#error ??= e
    })
    this.#flushTimer = setInterval(() => this.#gzip.flush(constants.Z_SYNC_FLUSH), FLUSH_EVERY_MS)
  }

  /** The first write error, if any; `close()` rejects with it too. */
  get error(): Error | undefined {
    return this.#error
  }

  write(record: JournalRecord): void {
    if (this.#closed || this.#error) return
    this.#gzip.write(`${JSON.stringify(record)}\n`)
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    clearInterval(this.#flushTimer)
    // A file that failed has already closed itself, and waiting for a close
    // event that was emitted before anyone listened is waiting forever.
    if (!this.#file.closed) {
      await new Promise<void>((resolve) => {
        this.#file.once("close", resolve)
        this.#gzip.end()
      })
    }
    if (this.#error) throw this.#error
  }
}

/**
 * Reads a journal back, tolerating a file the recorder never finished: a
 * truncated gzip stream or a half-written last line ends the read rather than
 * failing it.
 */
export async function* readJournal(path: string): AsyncGenerator<JournalRecord> {
  const gunzip = createGunzip({ finishFlush: constants.Z_SYNC_FLUSH })
  const file = createReadStream(path)
  const input = file.pipe(gunzip)
  // pipe() doesn't carry errors along; without this a missing file is an
  // uncaught error event rather than a rejection.
  let fileError: Error | undefined
  file.on("error", (e) => {
    fileError = e
    input.emit("end")
  })
  // A stream cut off mid-block ends with this; everything before it stands.
  gunzip.on("error", () => input.emit("end"))
  let unparsed: string | undefined
  try {
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
      if (unparsed !== undefined)
        throw new SyntaxError(`unreadable journal line: ${unparsed.slice(0, 80)}`)
      if (!line) continue
      try {
        yield JSON.parse(line) as JournalRecord
      } catch {
        // Only the last line may be unreadable: the one the recorder was
        // writing when it stopped.
        unparsed = line
      }
    }
  } finally {
    // A reader that stops early closes readline, which leaves the file open.
    file.destroy()
  }
  if (fileError) throw fileError
}
