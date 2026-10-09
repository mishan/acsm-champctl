/**
 * Keeps a spectator car on the server and a journal per session.
 *
 * ACSM starts a new server process for each event and the game protocol has
 * no notion of "between events", so a dropped connection is the normal way a
 * session ends here, not an error: the recorder closes that journal and keeps
 * trying to join until there is a server to join again.
 */

import { join } from "node:path"
import { SpectatorClient, type SpectatorOptions } from "./client.js"
import { JournalWriter, type JournalRecord } from "./journal.js"
import { PluginListener, type PluginListenerOptions } from "./plugin.js"
import type { HandshakeOk, ServerPacket } from "./protocol.js"

export interface RecorderOptions {
  client: Omit<SpectatorOptions, "onPacket" | "onClose" | "now">
  /** Omit to record without collisions or spline positions. */
  plugin?: Omit<PluginListenerOptions, "onEvent" | "onError" | "now">
  outDir: string
  /** Called with each journal once its session is over. */
  onJournal?: (path: string) => void
  log?: (message: string) => void
  retryMs?: { min: number; max: number }
}

const RETRY = { min: 2_000, max: 30_000 }

export class Recorder {
  readonly #opts: RecorderOptions
  readonly #log: (message: string) => void
  readonly #start = performance.now()
  #client: SpectatorClient | undefined
  #plugin: PluginListener | undefined
  #journal: JournalWriter | undefined
  #stopped = false
  #retryTimer: NodeJS.Timeout | undefined
  #retryMs: number
  /** The latest session change, which the next journal begins with. */
  #nextSession: { name: string; type: number } | undefined

  constructor(opts: RecorderOptions) {
    this.#opts = opts
    this.#log = opts.log ?? (() => {})
    this.#retryMs = (opts.retryMs ?? RETRY).min
  }

  /** Recorder clock: client packets and plugin events share it. */
  readonly now = (): number => Math.floor(performance.now() - this.#start)

  async start(): Promise<void> {
    if (this.#opts.plugin) {
      this.#plugin = new PluginListener({
        ...this.#opts.plugin,
        now: this.now,
        onEvent: (e, at) => this.#onPlugin(e, at),
        onError: (e) => this.#log(`plugin feed: ${e.message}`),
      })
      await this.#plugin.start()
    }
    void this.#join()
  }

  async stop(): Promise<void> {
    this.#stopped = true
    clearTimeout(this.#retryTimer)
    // Ended first: closing the client ends it too, with the client's reason.
    const ended = this.#endJournal("recorder stopped")
    this.#client?.close()
    this.#plugin?.close()
    await ended
    await Promise.all(this.#closing)
  }

  async #join(): Promise<void> {
    if (this.#stopped) return
    const client = new SpectatorClient({
      ...this.#opts.client,
      now: this.now,
      onPacket: (p, at) => this.#onPacket(p, at),
      onClose: (reason) => {
        this.#log(`left the server: ${reason}`)
        void this.#endJournal(reason).then(() => this.#retry())
      },
    })
    this.#client = client
    try {
      const session = await client.connect()
      if (this.#stopped) {
        client.close()
        return
      }
      this.#retryMs = (this.#opts.retryMs ?? RETRY).min
      this.#log(`joined ${session.track} as car ${session.carId}, ${session.currentSession.name}`)
      this.#beginJournal(session, client)
    } catch (e) {
      // onClose has already scheduled the retry.
      this.#log(`could not join: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  #retry(): void {
    if (this.#stopped || this.#retryTimer) return
    const { max } = this.#opts.retryMs ?? RETRY
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined
      void this.#join()
    }, this.#retryMs)
    this.#retryMs = Math.min(this.#retryMs * 2, max)
  }

  #beginJournal(
    session: HandshakeOk,
    client: SpectatorClient,
    name = session.currentSession.name,
  ): void {
    // Never two at once: the one being replaced would never be closed.
    if (this.#journal) void this.#endJournal("superseded")
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const file = `${stamp}-${slug(session.track)}${session.trackConfig ? `-${slug(session.trackConfig)}` : ""}-${slug(name)}.ndjson.gz`
    this.#journal = new JournalWriter(join(this.#opts.outDir, file))
    const at = this.now()
    this.#write({
      t: "session",
      at,
      serverName: session.serverName,
      track: session.track,
      trackConfig: session.trackConfig,
      name,
      type: session.currentSession.type,
      recorderCarId: session.carId,
    })
    for (const c of client.cars) {
      this.#write({
        t: "car",
        at,
        carId: c.carId,
        model: c.model,
        skin: c.skin,
        driver: c.driver,
        nation: c.nation,
        team: c.team,
      })
    }
  }

  /** Journals still being flushed; `stop()` waits for them. */
  #closing = new Set<Promise<void>>()

  #endJournal(reason: string): Promise<void> {
    const journal = this.#journal
    if (!journal) return Promise.all(this.#closing).then(() => {})
    this.#journal = undefined
    const done = this.#finish(journal, reason).finally(() => this.#closing.delete(done))
    this.#closing.add(done)
    return done
  }

  async #finish(journal: JournalWriter, reason: string): Promise<void> {
    journal.write({ t: "end", at: this.now(), reason })
    try {
      await journal.close()
      this.#opts.onJournal?.(journal.path)
    } catch (e) {
      this.#log(`journal ${journal.path} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  #write(record: JournalRecord): void {
    const journal = this.#journal
    if (!journal) return
    journal.write(record)
    if (journal.error) {
      // Recording nothing while holding a grid slot is the worst of both.
      this.#log(`cannot write ${journal.path}: ${journal.error.message}`)
      this.#client?.close()
    }
  }

  #onPacket(p: ServerPacket, at: number): void {
    switch (p.kind) {
      case "position":
        for (const car of p.cars) this.#write({ t: "pos", at, car })
        return
      case "lapCompleted":
        // Car 255 is a leaderboard refresh, not a lap.
        if (p.carId !== 255)
          this.#write({ t: "lap", at, carId: p.carId, lapMs: p.lapMs, cuts: p.cuts })
        return
      case "carConnected": {
        // The only place a late joiner's name arrives without the plugin feed.
        const slot = this.#client?.cars.find((c) => c.carId === p.carId)
        this.#write({
          t: "car",
          at,
          carId: p.carId,
          model: slot?.model ?? "",
          skin: slot?.skin ?? "",
          driver: p.name,
          nation: p.nation,
        })
        this.#write({ t: "connection", at, carId: p.carId, connected: true })
        return
      }
      case "carDisconnected":
        this.#write({ t: "connection", at, carId: p.carId, connected: false })
        return
      case "session": {
        const client = this.#client
        const session = client?.session
        if (!client || !session) return
        this.#nextSession = { name: p.name, type: p.type }
        void this.#endJournal(`session changed to ${p.name}`).then(() => {
          // Anything could have happened while the old journal closed: a
          // stop, a dropped connection and a rejoin, or another session,
          // which is the one to begin.
          const next = this.#nextSession
          if (this.#stopped || this.#client !== client || client.closed || this.#journal || !next)
            return
          this.#beginJournal(
            { ...session, currentSession: { ...session.currentSession, type: next.type } },
            client,
            next.name,
          )
        })
        return
      }
      default:
        return
    }
  }

  #onPlugin(e: Parameters<PluginListenerOptions["onEvent"]>[0], at: number): void {
    switch (e.kind) {
      case "carUpdate":
        this.#write({ t: "spline", at, carId: e.carId, spline: e.spline })
        return
      case "collision":
        this.#write({
          t: "collision",
          at,
          carId: e.carId,
          ...(e.otherCarId === undefined ? {} : { otherCarId: e.otherCarId }),
          impactSpeed: e.impactSpeed,
          worldPos: e.worldPos,
          relPos: e.relPos,
        })
        return
      case "connection":
        if (e.connected)
          this.#write({
            t: "car",
            at,
            carId: e.carId,
            model: e.model,
            skin: e.skin,
            driver: e.name,
            guid: e.guid,
          })
        return
      case "lapCompleted":
      case "session":
      case "endSession":
        return
      default:
        if (e.kind === "malformed")
          this.#log(`plugin feed: malformed 0x${e.id.toString(16)}: ${e.error}`)
        return
    }
  }
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "x"
  )
}
