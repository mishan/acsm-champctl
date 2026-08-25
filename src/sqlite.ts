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
