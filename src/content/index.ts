/**
 * Installed-content index (plan §6.4).
 *
 * "Is this track installed?" can only be answered by something that can see the
 * server. Off-host that means ACSM's `/cars` and `/tracks` listings; on-host it means the
 * filesystem. Both sit behind this interface so moving the service onto the
 * ACSM box later is a config change, not a rewrite (plan §9).
 *
 * The index is optional everywhere. When it is absent the content checks skip
 * rather than guess — a false "track not installed" the night before a race
 * would be worse than silence.
 */

import type { InstalledContent } from "../acsm/types.js"

export interface ContentIndex {
  hasTrack(track: string, layout?: string): boolean
  hasCar(model: string): boolean
  /** Skins available for a model, or undefined when the model is unknown. */
  skinsFor(model: string): ReadonlySet<string> | undefined
}

/**
 * The index ACSM's `/cars` and `/tracks` listings give.
 *
 * `undefined` when either listing came back empty, because `readInstalledContent`
 * returns an empty list for one it failed to read, and an empty list here would
 * report every car or track in the championship as missing.
 *
 * Layouts aren't in the listings, so `hasTrack` answers for the track alone and
 * the layout checks work off `TrackLayouts` instead. Skins aren't either, so
 * `skinsFor` never knows and the skin check stays quiet.
 */
export function installedContentIndex(content: InstalledContent): ContentIndex | undefined {
  if (content.cars.length === 0 || content.tracks.length === 0) return undefined
  const cars = new Set(content.cars.map((c) => c.id))
  const tracks = new Set(content.tracks.map((t) => t.id))
  return {
    hasTrack: (track) => tracks.has(track.trim()),
    hasCar: (model) => cars.has(model.trim()),
    skinsFor: () => undefined,
  }
}
