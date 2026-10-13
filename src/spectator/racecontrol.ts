/**
 * Collisions from ACSM's live timing, for a server whose UDP plugins only an
 * admin can set up. The live timing page is fed by a websocket anyone who can
 * see the page can open, and ACSM reports every collision on it, timed.
 *
 * What it lacks beside the plugin feed is where on the car the contact was.
 * Measured on ACSM 2.4.15.
 */

import type { Vec3 } from "./protocol.js"

/** ACSM's race-control message types this reads. */
export const RaceControlEvent = {
  NewConnection: 51,
  ConnectionClosed: 52,
  Collision: 108,
  Status: 200,
} as const

export type RaceControlUpdate =
  | {
      kind: "collision"
      carId: number
      /** Absent for a collision with the environment. */
      otherCarId?: number
      impactSpeed: number
      worldPos: Vec3
      /** The server's clock, ms since the epoch. */
      time: number
    }
  | {
      kind: "connection"
      connected: boolean
      carId: number
      guid: string
      name: string
      model: string
      skin: string
    }
  | { kind: "session"; track: string; trackConfig: string; name: string }

interface Wire {
  EventType?: unknown
  Message?: unknown
}

/**
 * Collisions name drivers by GUID; the car each GUID is in comes from the
 * status message and each new connection, so this keeps that map.
 */
export class RaceControlDecoder {
  readonly #carByGuid = new Map<string, number>()
  #session = ""

  decode(raw: string): RaceControlUpdate[] {
    let msg: Wire
    try {
      msg = JSON.parse(raw) as Wire
    } catch {
      return []
    }
    const m = (msg.Message ?? {}) as Record<string, unknown>
    switch (msg.EventType) {
      case RaceControlEvent.Status: {
        const ids = (m["CarIDToGUID"] ?? {}) as Record<string, unknown>
        for (const [carId, guid] of Object.entries(ids)) {
          if (typeof guid === "string" && guid) this.#carByGuid.set(guid, Number(carId))
        }
        const s = (m["SessionInfo"] ?? {}) as Record<string, unknown>
        const session = {
          kind: "session" as const,
          track: String(s["Track"] ?? ""),
          trackConfig: String(s["TrackConfig"] ?? ""),
          name: String(s["Name"] ?? ""),
        }
        // The status repeats every few seconds; only a change is news.
        const key = `${session.track}/${session.trackConfig}/${session.name}`
        if (key === this.#session) return []
        this.#session = key
        return [session]
      }
      case RaceControlEvent.NewConnection:
      case RaceControlEvent.ConnectionClosed: {
        const carId = Number(m["CarID"])
        const guid = String(m["DriverGUID"] ?? "")
        if (!Number.isInteger(carId)) return []
        if (guid) this.#carByGuid.set(guid, carId)
        return [
          {
            kind: "connection",
            connected: msg.EventType === RaceControlEvent.NewConnection,
            carId,
            guid,
            name: String(m["DriverName"] ?? ""),
            model: String(m["CarModel"] ?? ""),
            skin: String(m["CarSkin"] ?? ""),
          },
        ]
      }
      case RaceControlEvent.Collision: {
        const carId = this.#carByGuid.get(String(m["DriverGUID"] ?? ""))
        const other = String(m["OtherDriverGUID"] ?? "")
        const otherCarId = other ? this.#carByGuid.get(other) : undefined
        const p = (m["WorldPos"] ?? {}) as Record<string, unknown>
        const worldPos: Vec3 = [Number(p["X"]), Number(p["Y"]), Number(p["Z"])]
        const time = Date.parse(String(m["Time"] ?? ""))
        const impactSpeed = Number(m["Speed"])
        // A car this hasn't been told about can't be put in the journal, and a
        // collision with someone unknown isn't a collision with the scenery.
        if (carId === undefined || (other && otherCarId === undefined)) return []
        if (!Number.isFinite(time) || !Number.isFinite(impactSpeed)) return []
        if (!worldPos.every(Number.isFinite)) return []
        return [
          {
            kind: "collision",
            carId,
            ...(otherCarId === undefined ? {} : { otherCarId }),
            impactSpeed,
            worldPos,
            time,
          },
        ]
      }
      default:
        return []
    }
  }
}

export interface RaceControlOptions {
  /** The server's ACSM, e.g. https://acsm.example.org; the feed is under it. */
  url: string
  onUpdate: (update: RaceControlUpdate, receivedAt: number) => void
  onError?: (e: Error) => void
  now?: () => number
  /** The wall clock the server's times are compared with. */
  wallClock?: () => number
  retryMs?: { min: number; max: number }
}

const RETRY = { min: 2_000, max: 30_000 }
/** Further than this between the server's clock and ours, its times aren't trusted. */
const MAX_DELAY_MS = 2_000

/** The race-control websocket for an ACSM address. */
export function raceControlUrl(base: string): string {
  const u = new URL(base)
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`${base} isn't an http or https address`)
  }
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:"
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/api/race-control`
  u.search = ""
  u.hash = ""
  return u.toString()
}

/** Keeps the feed open, reconnecting when ACSM restarts or the link drops. */
export class RaceControlFeed {
  readonly #opts: RaceControlOptions
  readonly #now: () => number
  readonly #url: string
  #ws: WebSocket | undefined
  #closed = false
  #retryMs: number
  #retry: NodeJS.Timeout | undefined

  constructor(opts: RaceControlOptions) {
    this.#opts = opts
    this.#now = opts.now ?? (() => Date.now())
    this.#url = raceControlUrl(opts.url)
    this.#retryMs = (opts.retryMs ?? RETRY).min
  }

  start(): void {
    this.#open()
  }

  close(): void {
    this.#closed = true
    clearTimeout(this.#retry)
    this.#ws?.close()
  }

  #open(): void {
    if (this.#closed) return
    const decoder = new RaceControlDecoder()
    const ws = new WebSocket(this.#url)
    this.#ws = ws
    ws.onopen = () => {
      this.#retryMs = (this.#opts.retryMs ?? RETRY).min
    }
    ws.onmessage = (m) => {
      if (typeof m.data !== "string") return
      for (const u of decoder.decode(m.data)) this.#opts.onUpdate(u, this.#receivedAt(u))
    }
    ws.onerror = () => this.#opts.onError?.(new Error(`race control feed at ${this.#url} failed`))
    ws.onclose = () => {
      if (this.#closed) return
      const { max } = this.#opts.retryMs ?? RETRY
      this.#retry = setTimeout(() => this.#open(), this.#retryMs)
      this.#retryMs = Math.min(this.#retryMs * 2, max)
    }
  }

  /**
   * On the recorder's clock. A collision is placed when the server says it
   * happened, so a feed that arrives late doesn't move it, unless the two
   * clocks disagree by more than a delivery could take.
   */
  #receivedAt(u: RaceControlUpdate): number {
    const now = this.#now()
    if (u.kind !== "collision") return now
    const delay = (this.#opts.wallClock ?? Date.now)() - u.time
    return delay >= 0 && delay <= MAX_DELAY_MS ? now - delay : now
  }
}
