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
 * status message's connected drivers and each new connection, so this keeps
 * that map.
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
        // Not CarIDToGUID: it keeps every slot a GUID has held this event,
        // and on BATL a driver who'd rejoined was in slot 8 but listed under
        // 0, 8 and 25.
        // Drivers already on the server when the feed opened are only ever
        // here, never in a connection message, so each is announced once.
        const updates: RaceControlUpdate[] = []
        const connected = ((m["ConnectedDrivers"] ?? {}) as Record<string, unknown>)["Drivers"]
        for (const [guid, d] of Object.entries((connected ?? {}) as Record<string, unknown>)) {
          const info = ((d ?? {}) as { CarInfo?: Record<string, unknown> }).CarInfo ?? {}
          const carId = Number(info["CarID"])
          if (!guid || !Number.isInteger(carId)) continue
          if (this.#carByGuid.get(guid) !== carId) {
            updates.push({
              kind: "connection",
              connected: true,
              carId,
              guid,
              name: String(info["DriverName"] ?? ""),
              model: String(info["CarModel"] ?? ""),
              skin: String(info["CarSkin"] ?? ""),
            })
          }
          this.#carByGuid.set(guid, carId)
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
        if (key === this.#session) return updates
        this.#session = key
        return [session, ...updates]
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
    // Either one schedules the retry. Node 22's WebSocket fires only `error`
    // when a connection is refused, never `close`, and the feed waiting for a
    // close stayed down for good: on BATL, a race night with no collisions.
    ws.onerror = () => {
      this.#opts.onError?.(new Error(`race control feed at ${this.#url} failed`))
      this.#reconnect(ws)
    }
    ws.onclose = () => this.#reconnect(ws)
  }

  /** Once per socket, however many of its events say it's gone. */
  #reconnect(ws: WebSocket): void {
    if (this.#closed || ws !== this.#ws) return
    this.#ws = undefined
    ws.close()
    const { max } = this.#opts.retryMs ?? RETRY
    this.#retry = setTimeout(() => this.#open(), this.#retryMs)
    this.#retryMs = Math.min(this.#retryMs * 2, max)
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
