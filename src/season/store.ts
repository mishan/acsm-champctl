/**
 * The next season's vote: what the Racers nominated, each phase's deadline, and
 * the ballots. In the shared database beside the claims and the incidents.
 *
 * One season vote runs at a time, through four phases in order: cars are
 * nominated, then voted on, then tracks the same.
 */

import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { migrate, type Migration, restrictToOwner } from "../sqlite.js"

const MIGRATIONS: Migration[] = [
  {
    name: "season vote: initial schema",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS season_votes (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at         TEXT NOT NULL,
          started_by         TEXT NOT NULL,
          cars               INTEGER NOT NULL,
          tracks             INTEGER NOT NULL,
          nominate_days      INTEGER NOT NULL,
          vote_days          INTEGER NOT NULL,
          phase              TEXT NOT NULL,
          phase_ends_at      TEXT NOT NULL,
          ballot_message_id  TEXT
        ) STRICT;
        CREATE TABLE IF NOT EXISTS season_nominations (
          season_id     INTEGER NOT NULL REFERENCES season_votes(id),
          kind          TEXT NOT NULL,
          item          TEXT NOT NULL,
          label         TEXT NOT NULL,
          link          TEXT,
          nominated_by  TEXT NOT NULL,
          nominated_at  TEXT NOT NULL,
          PRIMARY KEY (season_id, kind, item)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS season_ballots (
          season_id  INTEGER NOT NULL REFERENCES season_votes(id),
          kind       TEXT NOT NULL,
          voter      TEXT NOT NULL,
          picks      TEXT NOT NULL,
          voted_at   TEXT NOT NULL,
          PRIMARY KEY (season_id, kind, voter)
        ) STRICT;
      `)
    },
  },
]

export type Kind = "cars" | "tracks"
export type Phase = "cars-nominate" | "cars-vote" | "tracks-nominate" | "tracks-vote" | "done"

export interface SeasonVote {
  id: number
  startedBy: string
  /** How many of each win. */
  cars: number
  tracks: number
  nominateDays: number
  voteDays: number
  phase: Phase
  phaseEndsAt: Date
  ballotMessageId?: string
}

export interface Nomination {
  /** A server folder name, or `mod:` and the name for something not installed. */
  item: string
  label: string
  link?: string
  /** Discord user id. */
  nominatedBy: string
}

interface VoteRow {
  id: number
  started_by: string
  cars: number
  tracks: number
  nominate_days: number
  vote_days: number
  phase: Phase
  phase_ends_at: string
  ballot_message_id: string | null
}

const fromRow = (r: VoteRow): SeasonVote => ({
  id: r.id,
  startedBy: r.started_by,
  cars: r.cars,
  tracks: r.tracks,
  nominateDays: r.nominate_days,
  voteDays: r.vote_days,
  phase: r.phase,
  phaseEndsAt: new Date(r.phase_ends_at),
  ...(r.ballot_message_id ? { ballotMessageId: r.ballot_message_id } : {}),
})

export class SqliteSeasonStore {
  readonly #db: DatabaseSync

  private constructor(db: DatabaseSync) {
    this.#db = db
  }

  static async open(path: string): Promise<SqliteSeasonStore> {
    if (path !== ":memory:") await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(path)
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA busy_timeout = 5000")
    migrate(db, "season", MIGRATIONS)
    if (path !== ":memory:") await restrictToOwner(path)
    return new SqliteSeasonStore(db)
  }

  close(): void {
    this.#db.close()
  }

  /** The vote that hasn't finished, if one is running. */
  current(): SeasonVote | undefined {
    const r = this.#db
      .prepare("SELECT * FROM season_votes WHERE phase != 'done' ORDER BY id DESC LIMIT 1")
      .get() as VoteRow | undefined
    return r && fromRow(r)
  }

  start(
    v: Pick<SeasonVote, "startedBy" | "cars" | "tracks" | "nominateDays" | "voteDays">,
    at: Date,
  ): SeasonVote {
    const r = this.#db
      .prepare(
        `INSERT INTO season_votes (started_at, started_by, cars, tracks, nominate_days, vote_days,
           phase, phase_ends_at)
         VALUES (?, ?, ?, ?, ?, ?, 'cars-nominate', ?) RETURNING *`,
      )
      .get(
        at.toISOString(),
        v.startedBy,
        v.cars,
        v.tracks,
        v.nominateDays,
        v.voteDays,
        new Date(at.getTime() + v.nominateDays * 86_400_000).toISOString(),
      ) as unknown as VoteRow
    return fromRow(r)
  }

  setPhase(id: number, phase: Phase, endsAt: Date, ballotMessageId?: string): void {
    this.#db
      .prepare(
        "UPDATE season_votes SET phase = ?, phase_ends_at = ?, ballot_message_id = ? WHERE id = ?",
      )
      .run(phase, endsAt.toISOString(), ballotMessageId ?? null, id)
  }

  nominations(id: number, kind: Kind): Nomination[] {
    const rows = this.#db
      .prepare(
        `SELECT item, label, link, nominated_by FROM season_nominations
         WHERE season_id = ? AND kind = ? ORDER BY nominated_at, rowid`,
      )
      .all(id, kind) as { item: string; label: string; link: string | null; nominated_by: string }[]
    return rows.map((r) => ({
      item: r.item,
      label: r.label,
      ...(r.link ? { link: r.link } : {}),
      nominatedBy: r.nominated_by,
    }))
  }

  /** False when the item is already nominated. */
  nominate(id: number, kind: Kind, n: Nomination, at: Date): boolean {
    const r = this.#db
      .prepare(
        `INSERT INTO season_nominations (season_id, kind, item, label, link, nominated_by, nominated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .run(id, kind, n.item, n.label, n.link ?? null, n.nominatedBy, at.toISOString())
    return r.changes === 1
  }

  /** False unless it was this person's nomination. */
  withdraw(id: number, kind: Kind, item: string, by: string): boolean {
    const r = this.#db
      .prepare(
        "DELETE FROM season_nominations WHERE season_id = ? AND kind = ? AND item = ? AND nominated_by = ?",
      )
      .run(id, kind, item, by)
    return r.changes === 1
  }

  /** Replaces the voter's earlier ballot. */
  vote(id: number, kind: Kind, voter: string, picks: readonly string[], at: Date): void {
    this.#db
      .prepare(
        `INSERT INTO season_ballots (season_id, kind, voter, picks, voted_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (season_id, kind, voter) DO UPDATE SET picks = excluded.picks, voted_at = excluded.voted_at`,
      )
      .run(id, kind, voter, JSON.stringify(picks), at.toISOString())
  }

  ballots(id: number, kind: Kind): string[][] {
    const rows = this.#db
      .prepare("SELECT picks FROM season_ballots WHERE season_id = ? AND kind = ?")
      .all(id, kind) as { picks: string }[]
    return rows.map((r) => JSON.parse(r.picks) as string[])
  }
}
