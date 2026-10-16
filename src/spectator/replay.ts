/**
 * A recorder journal's replay: the journal as the events `acreplay` takes,
 * without the recorder's own car, and its errors naming the journal.
 */

import {
  type ReplayEvent,
  ReplayError,
  type ReplayOptions,
  type ReplaySummary,
  writeReplay,
} from "./acreplay.js"
import { readJournal } from "./journal.js"

export async function* replayEvents(journal: string): AsyncGenerator<ReplayEvent> {
  let recorder: number | undefined
  for await (const r of readJournal(journal)) {
    switch (r.t) {
      case "session":
        recorder ??= r.recorderCarId
        yield r
        break
      case "pos":
        // The recorder's car sits parked out of sight; nobody wants it in the replay.
        if (r.car.carId !== recorder) yield r
        break
      case "car":
      case "connection":
      case "lap":
        yield r
        break
      default:
        break
    }
  }
}

export async function writeJournalReplay(
  journal: string,
  out: string,
  options: ReplayOptions = {},
): Promise<ReplaySummary> {
  try {
    return await writeReplay(replayEvents(journal), out, options)
  } catch (e) {
    if (!(e instanceof ReplayError)) throw e
    throw new Error(
      e.code === "no-session"
        ? `${journal} has no session record`
        : options.window
          ? `${journal} has no car recorded in that stretch: check --from and --to against the session's length`
          : `${journal} recorded no cars moving`,
    )
  }
}
