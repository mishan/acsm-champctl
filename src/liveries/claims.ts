/**
 * Which entrant a Discord user is (docs/discord-livery-upload.md §2).
 *
 * ACSM has nowhere to put this. `Account` has no Discord field, `Entrant` has
 * none, and ACSM's own Discord integration maps a user to a *role* and forgets
 * them. The custom sign-up questions can hold a handle — and do land in the
 * export — but the export nils `SignUpForm.Responses` for anything below
 * `GroupAdmin`, so the bot cannot read them, and the sign-up POST upserts by an
 * unverified GUID that is itself public, so anyone who knows a driver's Steam id
 * can overwrite their answers while sign-ups are open. A field an attacker can
 * write is not an identity.
 *
 * So champctl keeps the mapping, and three things follow.
 *
 * **Keyed on the Discord user id, never the username.** Snowflakes are
 * permanent; usernames are mutable and were globally reissued in 2023. Matching
 * on a handle typed into a form in March produces a driver whose uploads stop
 * working in September for a reason neither they nor the operator can see.
 *
 * **First claim wins, and every claim is announced.** Nothing here verifies
 * that a driver is who they say. The check is social: an impersonation attempt
 * is named in the admin channel rather than being silent, and the cost of the
 * attack is being seen doing it for the reward of putting a livery on somebody
 * else's car. That is not worth a verification flow.
 *
 * **The sign-up answer is corroboration, never authentication.** The drainer
 * has admin credentials and can read it; when it lines up with the handle
 * claiming, the announcement says so, and an operator gets to skim the ones
 * that agree and look at the ones that don't.
 */

import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { Championship } from "../acsm/types.js"
import { migrate, type Migration, restrictToOwner } from "../sqlite.js"
import { usableAsFolder } from "./pack.js"
import { nearbyNames, rosterOf } from "./plan.js"

/** One Discord account, and the entrant it says it is. */
export interface DriverClaim {
  /** `LEGACY_CLAIM` for a row written before claims were per championship. */
  championshipId: string
  discordUserId: string
  /** As it appears in the entry list. Compared exactly, NFC-normalised. */
  entrantName: string
  /** The claimer's Discord handle at claim time. Display only. */
  discordHandle?: string
  claimedAt: string
}

/** What the drainer read off the sign-up form for an entrant, if anything. */
export interface HandleHint {
  entrantName: string
  handle: string
  seenAt: string
}

export type ClaimOutcome = { ok: true; claim: DriverClaim } | { ok: false; reason: string }

function normalise(value: string): string {
  return value.normalize("NFC")
}

/**
 * Why this claim cannot stand, or undefined if it can.
 *
 * A pure function taking the championship and the claims already held, so every
 * refusal is a string a test can read and a driver can act on. The order is
 * deliberate: the checks a driver can fix come before the ones only an operator
 * can.
 */
export function claimProblem(
  championship: Championship,
  entrantName: string,
  discordUserId: string,
  heldBy: DriverClaim | undefined,
  alreadyHolds?: DriverClaim | undefined,
): string | undefined {
  const wanted = normalise(entrantName.trim())
  if (!wanted) {
    return `Which driver are you? Run /livery claim with the name exactly as it appears on the entry list.`
  }

  const roster = rosterOf(championship)
  const match = roster.find((r) => r.name === wanted)
  if (!match) {
    // The same "differs only in case or spacing" help the livery plan gives,
    // because it is the same mistake and the entry list is the same list.
    return (
      `"${wanted}" isn't on the entry list for ${championship.Name ?? "this championship"}. ` +
      `It has to match exactly — ${nearbyNames(roster, wanted)}`
    )
  }

  // Found at claim time rather than at upload time. A name ACSM stores happily
  // and champctl cannot turn into a folder means this driver can never upload,
  // and the person who has to fix it is an admin editing the entry list — so
  // the worst moment to discover it is while they are holding a zip.
  if (!usableAsFolder(wanted)) {
    return (
      `"${wanted}" is on the entry list, but champctl turns a driver's name into a folder on ` +
      `the game server and that name can't be one. An admin has to rename this entrant in ACSM ` +
      `before they can submit a livery — nothing you can do from here.`
    )
  }

  // Re-claiming is an operator's job (docs/discord-livery-upload.md §2). It ran
  // as a delete-and-insert, so a driver could take a second unclaimed name and
  // release their own on the way — leaving the name they had raced under free
  // for anybody to claim, which is exactly the impersonation the announcement
  // exists to make visible.
  if (alreadyHolds && alreadyHolds.entrantName !== wanted) {
    return (
      `You're already claimed as "${alreadyHolds.entrantName}". If your entry list name has ` +
      `changed, an admin has to release the old one first — that way a claim is never quietly ` +
      `handed back for somebody else to take.`
    )
  }

  if (heldBy && heldBy.discordUserId !== discordUserId) {
    // Deliberately does not name the holder. Whoever this is either already
    // knows, in which case the sentence is enough, or is trying it on, in which
    // case handing them the account that owns the name is not champctl's job.
    return (
      `"${wanted}" has already been claimed by another Discord account. If that's wrong, ask an ` +
      `admin — they can release it.`
    )
  }

  return undefined
}

/**
 * The line the admin channel gets.
 *
 * This is the whole verification story, so it has to be readable at a glance in
 * a channel nobody is watching closely. Says who, says as whom, and says
 * whether the sign-up form agrees.
 */
export function claimAnnouncement(claim: DriverClaim, options: { hint?: HandleHint } = {}): string {
  const who = claim.discordHandle
    ? `${claim.discordHandle} (${claim.discordUserId})`
    : claim.discordUserId
  const lines = [`**${who}** claimed the entry list name **${claim.entrantName}**.`]

  const hint = options.hint
  if (!hint) {
    lines.push(`No Discord handle on their sign-up to compare against.`)
  } else if (
    claim.discordHandle &&
    hint.handle.toLowerCase() === claim.discordHandle.toLowerCase()
  ) {
    lines.push(`Matches the Discord handle on their sign-up.`)
  } else {
    // The one that wants a human. Not phrased as an accusation: people change
    // handles, and the sign-up answer is overwritable by anyone who knows a
    // public Steam id, so a mismatch is evidence rather than proof.
    lines.push(
      `Their sign-up says "${hint.handle}", which is not the account that claimed. Worth a look.`,
    )
  }

  return lines.join("\n")
}

/** Who champctl will upload for, and onto which car. */
export interface Uploader {
  driverName: string
  /** From `Entrant.Model`, never from anything the submitter chose. */
  carModel: string
}

export type UploaderResolution = { ok: true; uploader: Uploader } | { ok: false; reason: string }

/**
 * The two things `readSingleLivery` needs, from the entry list rather than from
 * a filename.
 *
 * This is where the identity work pays for itself. The CLI path reads a driver
 * name off an inner zip's filename and a car model off a folder, and
 * `planLiveries` then has to refuse a pack whose folder disagrees with the
 * entrant's car. Here the model is read *from* the entrant, so that refusal is
 * unreachable and there is nothing the submitter could have named wrong.
 */
export function resolveUploader(
  championship: Championship,
  claim: DriverClaim | undefined,
): UploaderResolution {
  if (!claim) {
    // Fails closed, and the fix is one command the driver can run themselves —
    // rather than making the handle mandatory on the sign-up form, which cannot
    // be applied to anyone who has already signed up.
    return {
      ok: false,
      reason:
        `I don't know which driver you are. Run /livery claim with your entry list name — it ` +
        `has to match exactly, so if you're "Misha" there, "misha" won't do.`,
    }
  }

  const match = rosterOf(championship).find((r) => r.name === claim.entrantName)
  if (!match) {
    // Claims outlive a championship; entrant names do not. Says which
    // championship, because a driver in two series needs to know it is this one
    // they are missing from.
    return {
      ok: false,
      reason:
        `You're claimed as "${claim.entrantName}", which isn't on the entry list for ` +
        `${championship.Name ?? "this championship"}. If your name changed, claim the new one; ` +
        `if you haven't signed up yet, that comes first.`,
    }
  }

  if (!match.model) {
    // Reachable: a sign-up slot before ACSM has replaced the `any_car_model`
    // sentinel has no real model, and uploading against it would put the skin
    // somewhere no car will look.
    return {
      ok: false,
      reason:
        `"${claim.entrantName}" is on the entry list but has no car assigned yet, so there's ` +
        `nowhere to put a livery. That usually means the sign-up hasn't been accepted onto a ` +
        `car — an admin can sort it.`,
    }
  }

  return { ok: true, uploader: { driverName: match.name, carModel: match.model } }
}

/**
 * Claims were global before this, one entrant name per Discord account across
 * the whole install. Entrant names are per championship, so a league running a
 * second series had a driver's claim on series B silently replace their claim
 * on series A — and their next upload there refused with a message about not
 * being on the entry list, which points at the wrong problem entirely.
 *
 * Rows written before the column existed are carried over under `LEGACY_CLAIM`
 * rather than dropped, and resolve for any championship that has no claim of
 * its own. They decay on their own: every write stamps a real id.
 */
export const LEGACY_CLAIM = "*"

const MIGRATIONS: Migration[] = [
  {
    name: "claims: initial schema",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS driver_discord (
          discord_user_id  TEXT PRIMARY KEY,
          entrant_name     TEXT NOT NULL,
          discord_handle   TEXT,
          claimed_at       TEXT NOT NULL
        ) STRICT;

        CREATE UNIQUE INDEX IF NOT EXISTS driver_discord_name
          ON driver_discord (entrant_name);

        CREATE TABLE IF NOT EXISTS signup_handle (
          entrant_name  TEXT PRIMARY KEY,
          handle        TEXT NOT NULL,
          seen_at       TEXT NOT NULL
        ) STRICT;
      `)
    },
  },
  {
    name: "claims: one claim per championship",
    up: (db) => {
      // A rebuild rather than an ALTER, because the primary key and the unique
      // index both change. The unique index is the impersonation guard — two
      // Discord accounts claiming one driver — and it has to become unique per
      // championship rather than globally, or a driver in two series locks
      // their own name out of the second.
      db.exec(`
        ALTER TABLE driver_discord RENAME TO driver_discord_global;

        -- The index follows the table through a RENAME, keeping its name, so
        -- the new one below would collide with it.
        DROP INDEX IF EXISTS driver_discord_name;

        CREATE TABLE driver_discord (
          championship_id  TEXT NOT NULL,
          discord_user_id  TEXT NOT NULL,
          entrant_name     TEXT NOT NULL,
          discord_handle   TEXT,
          claimed_at       TEXT NOT NULL,
          PRIMARY KEY (championship_id, discord_user_id)
        ) STRICT;

        CREATE UNIQUE INDEX driver_discord_name
          ON driver_discord (championship_id, entrant_name);

        INSERT INTO driver_discord
          (championship_id, discord_user_id, entrant_name, discord_handle, claimed_at)
          SELECT '${LEGACY_CLAIM}', discord_user_id, entrant_name, discord_handle, claimed_at
          FROM driver_discord_global;

        DROP TABLE driver_discord_global;
      `)
    },
  },
]

interface ClaimRow {
  championship_id: string
  discord_user_id: string
  entrant_name: string
  discord_handle: string | null
  claimed_at: string
}

interface HintRow {
  entrant_name: string
  handle: string
  seen_at: string
}

function toClaim(row: ClaimRow): DriverClaim {
  return {
    championshipId: row.championship_id,
    discordUserId: row.discord_user_id,
    entrantName: row.entrant_name,
    ...(row.discord_handle ? { discordHandle: row.discord_handle } : {}),
    claimedAt: row.claimed_at,
  }
}

export interface OpenOptions {
  busyTimeoutMs?: number
}

/**
 * Claims, in the same database as the livery store.
 *
 * A second handle on one file rather than one class doing both, because the two
 * are read by different processes: the bot resolves a claim and holds no ACSM
 * credentials, the drain records liveries and does. WAL and a busy timeout are
 * exactly the settings for that, and one class would have meant the bot
 * importing the module that writes what was applied.
 */
export class SqliteClaimStore {
  readonly #db: DatabaseSync

  private constructor(db: DatabaseSync) {
    this.#db = db
  }

  static async open(path: string, options: OpenOptions = {}): Promise<SqliteClaimStore> {
    if (path !== ":memory:") await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(path)
    db.exec("PRAGMA journal_mode = WAL")
    db.exec(`PRAGMA busy_timeout = ${Number(options.busyTimeoutMs ?? 5000)}`)
    migrate(db, "claims", MIGRATIONS)
    if (path !== ":memory:") await restrictToOwner(path)
    return new SqliteClaimStore(db)
  }

  /**
   * This account's claim on this championship.
   *
   * Falls back to a `LEGACY_CLAIM` row — one written before claims were per
   * championship — so nobody has to re-claim because of the migration. A real
   * claim on this championship always wins, so the fallback disappears the
   * first time they claim again.
   */
  async forDiscordUser(
    championshipId: string,
    discordUserId: string,
  ): Promise<DriverClaim | undefined> {
    return this.#claimOf(championshipId, discordUserId)
  }

  async forEntrant(championshipId: string, entrantName: string): Promise<DriverClaim | undefined> {
    return this.#holderOf(championshipId, entrantName)
  }

  /**
   * Both resolutions are shared with `claim`, which is the whole point of them
   * being here. `claim` used to match `championship_id` exactly, so a legacy
   * row was invisible to the check that refuses a name somebody already holds —
   * and a second account could claim a name that was already spoken for, which
   * is the impersonation the unique index cannot catch across the two ids.
   */
  #claimOf(championshipId: string, discordUserId: string): DriverClaim | undefined {
    const row = this.#db
      .prepare(
        `SELECT * FROM driver_discord
         WHERE discord_user_id = ? AND championship_id IN (?, ?)
         ORDER BY championship_id = ? DESC LIMIT 1`,
      )
      .get(discordUserId, championshipId, LEGACY_CLAIM, championshipId) as unknown as
      | ClaimRow
      | undefined
    return row ? toClaim(row) : undefined
  }

  #holderOf(championshipId: string, entrantName: string): DriverClaim | undefined {
    const row = this.#db
      .prepare(
        `SELECT * FROM driver_discord
         WHERE entrant_name = ? AND championship_id IN (?, ?)
         ORDER BY championship_id = ? DESC LIMIT 1`,
      )
      .get(
        normalise(entrantName.trim()),
        championshipId,
        LEGACY_CLAIM,
        championshipId,
      ) as unknown as ClaimRow | undefined
    return row ? toClaim(row) : undefined
  }

  /**
   * Records a claim, refusing anything `claimProblem` refuses.
   *
   * Checked and written inside one transaction. The check is a read followed by
   * a write, and two people claiming the same name in the same second is
   * precisely the case the check exists for — so it cannot be the case the
   * check misses.
   */
  async claim(
    championshipId: string,
    championship: Championship,
    entrantName: string,
    discordUserId: string,
    options: { discordHandle?: string; at?: Date } = {},
  ): Promise<ClaimOutcome> {
    const wanted = normalise(entrantName.trim())
    const when = (options.at ?? new Date()).toISOString()

    this.#db.exec("BEGIN IMMEDIATE")
    try {
      const held = this.#holderOf(championshipId, wanted)
      const previous = this.#claimOf(championshipId, discordUserId)

      const problem = claimProblem(championship, entrantName, discordUserId, held, previous)
      if (problem) {
        this.#db.exec("ROLLBACK")
        return { ok: false, reason: problem }
      }

      // Only ever the same name at this point — a different one is refused
      // above and needs an admin to release the old claim first. The delete is
      // what makes re-running the same claim idempotent rather than a
      // constraint violation.
      this.#db
        .prepare("DELETE FROM driver_discord WHERE championship_id = ? AND discord_user_id = ?")
        .run(championshipId, discordUserId)
      this.#db
        .prepare(
          `INSERT INTO driver_discord
             (championship_id, discord_user_id, entrant_name, discord_handle, claimed_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(championshipId, discordUserId, wanted, options.discordHandle ?? null, when)
      this.#db.exec("COMMIT")

      const claim: DriverClaim = {
        championshipId,
        discordUserId,
        entrantName: wanted,
        ...(options.discordHandle ? { discordHandle: options.discordHandle } : {}),
        claimedAt: when,
      }
      return { ok: true, claim }
    } catch (e) {
      this.#db.exec("ROLLBACK")
      throw e
    }
  }

  /**
   * Drops a claim. Operator-only, by design.
   *
   * A driver who could release their own claim could release it the moment
   * somebody asked them to, which is most of the way to letting anyone take a
   * name off anyone.
   */
  async release(championshipId: string, discordUserId: string): Promise<DriverClaim | undefined> {
    const existing = await this.forDiscordUser(championshipId, discordUserId)
    if (existing) {
      // Deleted at the championship the row actually belongs to, which for a
      // legacy claim is not the one that was asked for.
      this.#db
        .prepare("DELETE FROM driver_discord WHERE championship_id = ? AND discord_user_id = ?")
        .run(existing.championshipId, discordUserId)
    }
    return existing
  }

  /**
   * Every claim that answers for this championship, one row per account.
   *
   * The same precedence `#claimOf` applies, and for the same reason: a driver
   * who re-claimed after the migration has both a real row and the carried-
   * forward one, and listing both showed them twice and counted them twice in
   * the "N claimed" line an operator reads to check the grid.
   */
  async list(championshipId: string): Promise<DriverClaim[]> {
    const rows = this.#db
      .prepare(
        `SELECT * FROM driver_discord AS d
         WHERE d.championship_id IN (?, ?)
           AND (d.championship_id = ?
                OR NOT EXISTS (SELECT 1 FROM driver_discord AS real_claim
                               WHERE real_claim.championship_id = ?
                                 AND real_claim.discord_user_id = d.discord_user_id))
         ORDER BY d.entrant_name`,
      )
      .all(championshipId, LEGACY_CLAIM, championshipId, championshipId) as unknown as ClaimRow[]
    return rows.map(toClaim)
  }

  /**
   * Records what an entrant's sign-up said their Discord handle was.
   *
   * Written by the drainer, which is the only process that can read it — the
   * export hides sign-up responses from anything below `GroupAdmin`. Kept
   * separate from the claim it corroborates so that nothing can mistake one for
   * the other: this column is overwritable by whoever knows a public Steam id,
   * and it is never consulted to decide anything.
   */
  async rememberHandleHint(entrantName: string, handle: string, at: Date): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO signup_handle (entrant_name, handle, seen_at) VALUES (?, ?, ?)
         ON CONFLICT(entrant_name) DO UPDATE SET handle = excluded.handle, seen_at = excluded.seen_at`,
      )
      .run(normalise(entrantName.trim()), handle, at.toISOString())
  }

  async handleHint(entrantName: string): Promise<HandleHint | undefined> {
    const row = this.#db
      .prepare("SELECT * FROM signup_handle WHERE entrant_name = ?")
      .get(normalise(entrantName.trim())) as unknown as HintRow | undefined
    return row
      ? { entrantName: row.entrant_name, handle: row.handle, seenAt: row.seen_at }
      : undefined
  }

  close(): void {
    this.#db.close()
  }
}
