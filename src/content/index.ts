/**
 * Installed-content index (plan §6.4).
 *
 * "Is this track installed?" can only be answered by something that can see the
 * server. Off-host that means the event form's track XHR; on-host it means the
 * filesystem. Both sit behind this interface so moving the service onto the
 * ACSM box later is a config change, not a rewrite (plan §9).
 *
 * The index is optional everywhere. When it is absent the content checks skip
 * rather than guess — a false "track not installed" the night before a race
 * would be worse than silence.
 */

export interface ContentIndex {
  hasTrack(track: string, layout?: string): boolean
  hasCar(model: string): boolean
  /** Skins available for a model, or undefined when the model is unknown. */
  skinsFor(model: string): ReadonlySet<string> | undefined
}

export interface ContentSnapshot {
  /** track -> layouts. A track with no layouts maps to `[""]`. */
  tracks: Record<string, string[]>
  /** model -> skin folder names. */
  cars: Record<string, string[]>
}

export class SnapshotContentIndex implements ContentIndex {
  readonly #tracks: Map<string, Set<string>>
  readonly #cars: Map<string, Set<string>>

  constructor(snapshot: ContentSnapshot) {
    this.#tracks = new Map(
      Object.entries(snapshot.tracks ?? {}).map(([t, ls]) => [t, new Set(ls ?? [])]),
    )
    this.#cars = new Map(
      Object.entries(snapshot.cars ?? {}).map(([c, ss]) => [c, new Set(ss ?? [])]),
    )
  }

  hasTrack(track: string, layout?: string): boolean {
    const layouts = this.#tracks.get(track.trim())
    if (!layouts) return false
    const l = (layout ?? "").trim()
    if (!l) return true
    return layouts.has(l) || layouts.has("")
  }

  hasCar(model: string): boolean {
    return this.#cars.has(model.trim())
  }

  skinsFor(model: string): ReadonlySet<string> | undefined {
    return this.#cars.get(model.trim())
  }
}
