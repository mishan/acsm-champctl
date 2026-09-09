/**
 * Shared handling for the SQLite files champctl creates.
 *
 * Both databases hold league data — the response cache stores whole response
 * bodies, so entry lists with driver names and Steam GUIDs, and the archive
 * stores every export verbatim. They had identical copies of the permission
 * fix, with the reasoning split across the two: one copy explained the
 * containment, the other explained the sidecars. Neither was complete on its
 * own, which is the usual way a duplicate goes wrong.
 */

import { chmod } from "node:fs/promises"
import { resolve } from "node:path"
import type { DatabaseSync } from "node:sqlite"

/**
 * Owner-only on a SQLite database and its sidecars.
 *
 * The sidecars matter as much as the database. `-wal` holds pages not yet
 * checkpointed, so it is content rather than bookkeeping, and SQLite creates
 * both at the umask default rather than inheriting the database's mode —
 * measured at 0644 against a 0600 database. They are removed on a clean close
 * and left behind by a crash, which is exactly when nobody is looking.
 *
 * Best effort. A filesystem without POSIX modes, or a file the operator
 * deliberately owns differently, should not stop a run — the directory mode the
 * callers set is the containment that matters.
 */
export async function restrictToOwner(path: string): Promise<void> {
  for (const f of [path, `${path}-wal`, `${path}-shm`]) {
    await chmod(f, 0o600).catch(() => undefined)
  }
}

/**
 * One step in a component's schema history.
 *
 * The first is always the schema as it was when the component was introduced,
 * written with `IF NOT EXISTS` so that a database created before there was any
 * versioning arrives at step 1 without being touched.
 */
export interface Migration {
  /** Named in the error if it fails, since a half-migrated file needs a human. */
  readonly name: string
  readonly up: (db: DatabaseSync) => void
}

/**
 * Where each component's schema version is recorded.
 *
 * A table rather than `PRAGMA user_version`, which would be the obvious choice
 * for one schema per file. champctl puts four in one file — the queue, the
 * livery store, the claims and the upload tokens — because the whole credential
 * split turns on the bot and the drain sharing exactly one thing. `user_version`
 * is per *file*, so four independent migration lists would have overwritten each
 * other's count and left the file describing itself wrongly.
 */
const VERSIONS = `
CREATE TABLE IF NOT EXISTS champctl_schema (
  component  TEXT PRIMARY KEY,
  version    INTEGER NOT NULL
) STRICT;
`

/**
 * Brings one component's tables up to date, and records how far it got.
 *
 * The alternative was what these files did before — `CREATE TABLE IF NOT
 * EXISTS` and nothing else. That is fine until the first column is added, at
 * which point the statement silently does nothing against an existing file and
 * the failure surfaces as a column-count error on the next insert, at runtime,
 * in whichever process happened to write first.
 *
 * Each step runs in its own transaction with the version bump inside it, so an
 * interrupted migration leaves the file at a version that describes it.
 */
export function migrate(
  db: DatabaseSync,
  component: string,
  migrations: readonly Migration[],
): void {
  db.exec(VERSIONS)
  const row = db
    .prepare("SELECT version FROM champctl_schema WHERE component = ?")
    .get(component) as { version: number } | undefined
  const at = Number(row?.version ?? 0)

  if (at > migrations.length) {
    throw new Error(
      `The ${component} tables in this database are at schema version ${at} and this champctl ` +
        `only knows ${migrations.length}. It was written by a newer version — upgrade champctl ` +
        `rather than letting this one write to it.`,
    )
  }

  for (let i = at; i < migrations.length; i += 1) {
    const step = migrations[i] as Migration
    db.exec("BEGIN IMMEDIATE")
    try {
      step.up(db)
      db.prepare(
        `INSERT INTO champctl_schema (component, version) VALUES (?, ?)
         ON CONFLICT(component) DO UPDATE SET version = excluded.version`,
      ).run(component, i + 1)
      db.exec("COMMIT")
    } catch (e) {
      db.exec("ROLLBACK")
      throw new Error(
        `Migrating the ${component} tables failed at "${step.name}": ` +
          `${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }
}

/**
 * Where the shared queue database lives, unless told otherwise.
 *
 * The whole credential split turns on three processes — the bot, the upload
 * server and the drain — opening the *same* file. This resolved against the
 * working directory in all three with nothing else to fall back on, so a
 * systemd unit whose WorkingDirectory differed from the operator's shell
 * produced two databases, a queue nothing drained, and drivers told "queued for
 * an admin" for ever, with no error anywhere.
 *
 * `CHAMPCTL_STORE` is the fix that survives a unit file. `--store` still wins,
 * because an operator naming a path on the command line means it.
 */
export function defaultStorePath(): string {
  const configured = process.env["CHAMPCTL_STORE"]?.trim()
  return configured ? resolve(configured) : resolve(process.cwd(), "data/liveries/liveries.db")
}
