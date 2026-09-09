/**
 * One-time upload links, for the drivers Discord's own ceiling shuts out
 * (docs/discord-livery-upload.md §3).
 *
 * A free Discord account can attach around 20 MB and champctl will take 48 MB a
 * file, so the tighter limit is Discord's and the driver who hits it has no way
 * to tell champctl anything at all — the rejection happens on their client,
 * before the bot exists. The link is the way round: champctl hosts the upload
 * itself and the driver sends the file over HTTP.
 *
 * The token *is* the authentication, which is what most of this file is about.
 *
 * **Unguessable, not merely unique.** 256 bits from `randomBytes`. A counter, a
 * UUIDv4 or a timestamp would each be fine for telling uploads apart and none
 * of them is a credential.
 *
 * **Stored as a digest.** The queue database already holds driver names and
 * Discord ids; it should not also be a drawer of live credentials that anyone
 * with a copy of the file can walk off with. Lookup is *by* the digest, so an
 * attacker would have to know the token to compute the key — which is the
 * property that makes a plain index lookup safe here, rather than a
 * constant-time comparison against a stored secret.
 *
 * **Scoped at mint time.** The driver, the car and the championship are
 * resolved when the link is made and stored beside the digest. The URL carries
 * no "who" for the uploader to change, so a leaked link uploads a livery for
 * the driver it was minted for and nobody else.
 *
 * **Consumed on POST, never on GET.** Discord unfurls links, so the URL is
 * fetched by Discord's own crawler within a second of being sent. A token that
 * burned on GET would be dead before the driver clicked it, every single time,
 * and would read as a bot that is broken rather than a design that is.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { migrate, type Migration, restrictToOwner } from "../sqlite.js"

/** Thirty minutes is generous for "go and find the file". */
export const DEFAULT_TOKEN_TTL_MS = 30 * 60_000

/** What a token authorises. Fixed when it is minted. */
export interface UploadGrant {
  discordUserId: string
  discordHandle?: string
  championshipId: string
  driverName: string
  carModel: string
}

export interface MintedToken {
  /** The secret. Held only here and in the link; never stored. */
  token: string
  grant: UploadGrant
  expiresAt: Date
}

export type TokenLookup =
  | { ok: true; grant: UploadGrant; expiresAt: Date }
  | { ok: false; reason: "unknown" | "expired" | "used" }

export function digestToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex")
}

/**
 * A URL for a token, refusing to build one that would put it in the clear.
 *
 * The token travels in the path, so plain HTTP puts it in every proxy log
 * between the driver and the server. Refusing to mint is better than a
 * quiet downgrade: a league that has misconfigured this should find out from a
 * failed command rather than from a link that worked.
 */
export function uploadUrl(baseUrl: string, token: string): string {
  const url = new URL(baseUrl)
  if (url.protocol !== "https:" && !isLoopback(url.hostname)) {
    throw new UploadTokenError(
      `discord.livery.uploadBaseUrl is ${url.protocol}//… — the token travels in the URL, so it ` +
        `has to be https. (http is allowed on localhost for development.)`,
    )
  }
  const path = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`
  return new URL(`${path}u/${token}`, url).toString()
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
}

export class UploadTokenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UploadTokenError"
  }
}

/**
 * Pulls a token out of `/u/<token>`, or undefined if that isn't the shape.
 *
 * Anchored to the end rather than the start, because `uploadUrl` keeps any path
 * in `uploadBaseUrl` and this used to insist on `/u/` at the root: a league
 * mounted at `https://host/champctl/` minted links its own server 404'd. Being
 * relaxed about what comes before costs nothing — the token is the credential
 * and is still looked up before anything is served.
 */
export function tokenFromPath(pathname: string): string | undefined {
  const match = /(?:^|\/)u\/([A-Za-z0-9_-]{16,128})\/?$/.exec(pathname)
  return match?.[1]
}

const MIGRATIONS: Migration[] = [
  {
    name: "upload-tokens: initial schema",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS upload_token (
          digest           TEXT PRIMARY KEY,
          discord_user_id  TEXT NOT NULL,
          discord_handle   TEXT,
          championship_id  TEXT NOT NULL,
          driver_name      TEXT NOT NULL,
          car_model        TEXT NOT NULL,
          minted_at        TEXT NOT NULL,
          expires_at       TEXT NOT NULL,
          used_at          TEXT
        ) STRICT;

        CREATE INDEX IF NOT EXISTS upload_token_by_user ON upload_token (discord_user_id);
      `)
    },
  },
]

interface Row {
  digest: string
  discord_user_id: string
  discord_handle: string | null
  championship_id: string
  driver_name: string
  car_model: string
  minted_at: string
  expires_at: string
  used_at: string | null
}

function toGrant(row: Row): UploadGrant {
  return {
    discordUserId: row.discord_user_id,
    ...(row.discord_handle ? { discordHandle: row.discord_handle } : {}),
    championshipId: row.championship_id,
    driverName: row.driver_name,
    carModel: row.car_model,
  }
}

export interface OpenOptions {
  busyTimeoutMs?: number
}

export class SqliteTokenStore {
  readonly #db: DatabaseSync

  private constructor(db: DatabaseSync) {
    this.#db = db
  }

  static async open(path: string, options: OpenOptions = {}): Promise<SqliteTokenStore> {
    if (path !== ":memory:") await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(path)
    db.exec("PRAGMA journal_mode = WAL")
    db.exec(`PRAGMA busy_timeout = ${Number(options.busyTimeoutMs ?? 5000)}`)
    migrate(db, "upload-tokens", MIGRATIONS)
    if (path !== ":memory:") await restrictToOwner(path)
    return new SqliteTokenStore(db)
  }

  /**
   * Mints a token, invalidating whatever that driver had.
   *
   * One live token each. A driver who asks twice should not leave a spare in
   * their message history, and there is no legitimate use for the older link
   * once the newer one exists.
   */
  async mint(grant: UploadGrant, now: Date, ttlMs = DEFAULT_TOKEN_TTL_MS): Promise<MintedToken> {
    const token = randomBytes(32).toString("base64url")
    const expiresAt = new Date(now.getTime() + ttlMs)

    this.#db.exec("BEGIN IMMEDIATE")
    try {
      this.#db
        .prepare("DELETE FROM upload_token WHERE discord_user_id = ? AND used_at IS NULL")
        .run(grant.discordUserId)
      this.#db
        .prepare(
          `INSERT INTO upload_token (
             digest, discord_user_id, discord_handle, championship_id, driver_name,
             car_model, minted_at, expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          digestToken(token),
          grant.discordUserId,
          grant.discordHandle ?? null,
          grant.championshipId,
          grant.driverName,
          grant.carModel,
          now.toISOString(),
          expiresAt.toISOString(),
        )
      this.#db.exec("COMMIT")
    } catch (e) {
      this.#db.exec("ROLLBACK")
      throw e
    }

    return { token, grant, expiresAt }
  }

  /**
   * Looks a token up without spending it.
   *
   * What a GET does. Discord's unfurler will call this within a second of the
   * link being sent, and so will the driver's browser when the page loads, and
   * neither is the driver actually uploading anything.
   */
  async peek(token: string, now: Date): Promise<TokenLookup> {
    return this.#look(token, now)
  }

  /**
   * The lookup, without the `async`.
   *
   * `consume` calls this from inside a transaction, and awaiting anything
   * between `BEGIN IMMEDIATE` and `COMMIT` is a deadlock waiting to happen:
   * the await yields with the write lock held, and the next request handler to
   * reach `BEGIN IMMEDIATE` on the same connection gets "cannot start a
   * transaction within a transaction" — or, on a second connection to the same
   * file, blocks the one thread for the whole busy timeout while the holder
   * waits for a turn that will never come. node:sqlite is synchronous, so the
   * await bought nothing and cost that.
   */
  #look(token: string, now: Date): TokenLookup {
    const row = this.#db
      .prepare("SELECT * FROM upload_token WHERE digest = ?")
      .get(digestToken(token)) as unknown as Row | undefined
    if (!row) return { ok: false, reason: "unknown" }
    if (row.used_at) return { ok: false, reason: "used" }

    const expiresAt = new Date(row.expires_at)
    if (expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" }
    return { ok: true, grant: toGrant(row), expiresAt }
  }

  /**
   * Spends a token, once.
   *
   * `WHERE used_at IS NULL` inside the update is what makes it single-use: two
   * requests arriving together both read an unused row, and only one of them
   * changes it. A check followed by a write would let both through, and the
   * whole point of the token is that it works exactly once.
   */
  async consume(token: string, now: Date): Promise<TokenLookup> {
    const digest = digestToken(token)
    this.#db.exec("BEGIN IMMEDIATE")
    try {
      const looked = this.#look(token, now)
      if (!looked.ok) {
        this.#db.exec("ROLLBACK")
        return looked
      }
      const changed = this.#db
        .prepare("UPDATE upload_token SET used_at = ? WHERE digest = ? AND used_at IS NULL")
        .run(now.toISOString(), digest).changes
      this.#db.exec("COMMIT")
      return Number(changed) === 1 ? looked : { ok: false, reason: "used" }
    } catch (e) {
      this.#db.exec("ROLLBACK")
      throw e
    }
  }

  /**
   * Drops tokens that expired a while ago.
   *
   * Not for correctness — `peek` already refuses them — but a table that only
   * grows is a table somebody eventually has to explain. Spent and expired rows
   * are kept for a grace period so "my link says it's been used" has an answer.
   */
  async forgetExpiredBefore(cutoff: Date): Promise<number> {
    return Number(
      this.#db.prepare("DELETE FROM upload_token WHERE expires_at < ?").run(cutoff.toISOString())
        .changes,
    )
  }

  close(): void {
    this.#db.close()
  }
}

/**
 * Constant-time string comparison, for callers comparing a secret directly.
 *
 * Not used by the lookup above, which goes by digest. Exported because the
 * temptation to write `a === b` against a token is exactly the sort of thing
 * that should have a ready alternative sitting next to it.
 */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8")
  const right = Buffer.from(b, "utf8")
  // Length is not secret and `timingSafeEqual` throws on a mismatch, so it has
  // to be checked first — which is fine: an attacker learning the length of a
  // 43-character base64url string has learned nothing.
  return left.length === right.length && timingSafeEqual(left, right)
}
