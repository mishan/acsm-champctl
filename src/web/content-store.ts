/**
 * The installed-content index, kept across restarts in the response cache's
 * database.
 *
 * The same file the responses live in, in a table that does not expire — see
 * `kept` in `acsm/cache.ts`. Sharing the database means sharing what it already
 * gets right: a directory created `0700`, the file `0600`, WAL so a read isn't
 * blocked by a write, and one handle opened and closed on champctl's existing
 * startup and shutdown paths. A JSON file beside it would have been a second
 * thing to create, chmod, write atomically and clean up.
 *
 * Keyed by base URL, so pointing champctl at a different manager does not hand
 * it the last one's car list — the folder names belong to the manager, not to
 * champctl.
 *
 * Every failure here is swallowed by `ContentCache`. Losing this costs a slow
 * start; failing a request over it would cost a screen.
 */

import type { InstalledContent, InstalledItem } from "../acsm/types.js"
import type { ContentStore } from "./content-cache.js"

/** Anything that can hold a string past the response TTL. `SqliteCache` does. */
export interface KeptStore {
  kept(key: string): Promise<{ writtenAt: number; body: string } | undefined>
  keep(key: string, body: string): Promise<void>
}

/** Every entry an `{ id, name }` pair, with both actually present. */
function isItemList(value: unknown): value is InstalledItem[] {
  return (
    Array.isArray(value) &&
    value.every(
      (i) =>
        i !== null &&
        typeof i === "object" &&
        typeof (i as InstalledItem).id === "string" &&
        typeof (i as InstalledItem).name === "string",
    )
  )
}

export function contentStore(store: KeptStore, baseUrl: string): ContentStore {
  const key = `content:${baseUrl}`

  return {
    async read() {
      const row = await store.kept(key)
      if (!row) return undefined

      const parsed: unknown = JSON.parse(row.body)
      // Shape-checked rather than trusted, down to the items. This row is
      // written by a previous version of champctl as much as by this one, and
      // an older one stored bare folder names — so `["spa"]` is a plausible
      // thing to find here, and it type-checks as an array. It would reach the
      // screen as a list of items with no `id` and no `name`, which is a
      // picker rendering blanks and committing `undefined`.
      //
      // Checking the whole list rather than the first item: a row that is
      // half-right is exactly the shape an interrupted migration leaves, and
      // "the first one looked fine" is not a reason to trust the rest.
      if (!parsed || typeof parsed !== "object") return undefined
      const { cars, tracks } = parsed as Partial<InstalledContent>
      if (!isItemList(cars) || !isItemList(tracks)) return undefined

      return { at: row.writtenAt, value: { cars, tracks } }
    },

    async write(entry) {
      // The timestamp is the row's, not the entry's: `kept` stamps on write,
      // and two clocks for one fact is one clock too many.
      await store.keep(key, JSON.stringify(entry.value))
    },
  }
}
