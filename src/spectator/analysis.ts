/**
 * One incident, analyzed: the shared path for the CLI and the MCP server, so
 * a steward asking in either place gets the same packet and the same call.
 */

import { readFile } from "node:fs/promises"
import { join } from "node:path"

import {
  buildIncident,
  DEFAULT_THRESHOLDS,
  type IncidentPacket,
  type IncidentThresholds,
} from "./incident.js"
import { readJournal } from "./journal.js"
import { type Suggestion, suggest } from "./rules.js"
import { parseFastLane, Track } from "./track.js"

export interface Analysis {
  packet: IncidentPacket
  suggestion: Suggestion
  track: Track
}

/** The racing line for the session a journal recorded, from an AC install. */
export async function trackForJournal(journal: string, acRoot: string): Promise<Track> {
  for await (const r of readJournal(journal)) {
    if (r.t !== "session") continue
    const path = join(acRoot, "content/tracks", r.track, r.trackConfig, "ai/fast_lane.ai")
    const buf = await readFile(path).catch(() => {
      throw new Error(`no racing line for ${r.track} at ${path}`)
    })
    return new Track(parseFastLane(buf))
  }
  throw new Error(`${journal} has no session record`)
}

export async function analyzeIncident(
  journal: string,
  index: number,
  acRoot: string,
  thresholds: Partial<IncidentThresholds> = {},
): Promise<Analysis> {
  const th = { ...DEFAULT_THRESHOLDS, ...thresholds }
  const track = await trackForJournal(journal, acRoot)
  const packet = await buildIncident(journal, index, track, th)
  return { packet, suggestion: suggest(packet, th), track }
}
