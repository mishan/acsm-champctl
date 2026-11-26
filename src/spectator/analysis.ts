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
import { racingLine } from "./content.js"
import { readJournal } from "./journal.js"
import { type Suggestion, suggest } from "./rules.js"
import { parseFastLane, Track } from "ac-ai-line"

export interface Analysis {
  packet: IncidentPacket
  suggestion: Suggestion
  track: Track
}

export interface LineRoots {
  /** The hand-copied AC root. */
  acRoot: string
  /** What the recorder fetched from Server Manager: the server's own copy, so it wins. */
  acContent?: string | undefined
}

/** The racing line for the session a journal recorded, from an AC install. */
export async function trackForJournal(journal: string, roots: LineRoots): Promise<Track> {
  for await (const r of readJournal(journal)) {
    if (r.t !== "session") continue
    const line = racingLine(r.track, r.trackConfig)
    const dirs = [roots.acContent, roots.acRoot].filter((d) => d !== undefined)
    for (const dir of dirs) {
      const buf = await readFile(join(dir, line)).catch(() => undefined)
      if (!buf) continue
      // A fetched line is never fetched again, so one that won't parse
      // mustn't hide the hand copy for good.
      try {
        return new Track(parseFastLane(buf))
      } catch {}
    }
    const place = r.trackConfig ? `${r.track} (${r.trackConfig})` : r.track
    throw new Error(`no racing line for ${place} in ${dirs.join(" or ")}`)
  }
  throw new Error(`${journal} has no session record`)
}

export async function analyzeIncident(
  journal: string,
  index: number,
  roots: LineRoots,
  thresholds: Partial<IncidentThresholds> = {},
): Promise<Analysis> {
  const th = { ...DEFAULT_THRESHOLDS, ...thresholds }
  const track = await trackForJournal(journal, roots)
  const packet = await buildIncident(journal, index, track, th)
  return { packet, suggestion: suggest(packet, th), track }
}
