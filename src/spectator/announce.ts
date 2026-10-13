/**
 * Tells a Discord channel a session's replay is ready, through a webhook, so
 * nobody has to go looking. The webhook is the only secret the recorder holds.
 */

import type { ReplaySummary } from "./acreplay.js"

/** Shorter than this is a recorder restart or an empty server, not a session. */
export const MIN_ANNOUNCED_S = 120

export function replayMessage(s: ReplaySummary, url: string): string | undefined {
  const seconds = Math.round(s.durationMs / 1000)
  if (seconds < MIN_ANNOUNCED_S || s.cars.length === 0) return undefined
  const minutes = Math.round(seconds / 60)
  const length =
    minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`
  const track = s.trackConfig ? `${s.track} (${s.trackConfig})` : s.track
  const cars = `${s.cars.length} ${s.cars.length === 1 ? "car" : "cars"}`
  return `Replay of ${s.session || "the session"} at ${track}, ${length} with ${cars}: ${url}`
}

export async function postToWebhook(webhook: string, content: string): Promise<void> {
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // Nobody gets pinged by a replay, whatever a session or track is called.
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Discord answered ${res.status}`)
}
