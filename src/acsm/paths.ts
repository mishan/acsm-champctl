/**
 * Every ACSM URL champctl knows, in one place.
 *
 * These used to live in `write.ts`, except for the championships listing in
 * `listing.ts` and a second copy of `exportPath` in `client.ts` — three homes
 * for one vocabulary, with the duplicate arising because `client.ts` cannot
 * import `write.ts`: that closes a cycle through `session.ts`. A module with no
 * imports of its own has no such problem, and there is now one spelling of each
 * path rather than one per file that happens to need it.
 *
 * The paths themselves are recon output, not guesses — see
 * `docs/acsm-write-path.md` and `docs/acsm-2.4.15.md`. Two are worth knowing
 * before you use them:
 *
 * - `eventSchedulePath` is the schedule form's *action*, and that route is
 *   POST-only: a GET of it is a 405 on 2.4.x. The form is rendered on
 *   `championshipPath`.
 * - `entrantStatusPath` is driven by a GET, not a POST, which is what ACSM's
 *   own router does.
 *
 * Ids are percent-encoded because they arrive from an export and a URL is not
 * the place to find out one contained a slash.
 */

/** A championship's full export: config, entry list, results, laps, incidents. */
export function exportPath(championshipId: string): string {
  return `/championship/${encodeURIComponent(championshipId)}/export`
}

/** The championship overview page. Also where the schedule form is rendered. */
export function championshipPath(championshipId: string): string {
  return `/championship/${encodeURIComponent(championshipId)}`
}

/** The championships listing page, which is the only way to enumerate them. */
export const CHAMPIONSHIPS_PATH = "/championships"

/**
 * The installed-content listings, which are the only way to enumerate those
 * either — `/api/cars`, `/api/cars/list.json` and `/api/content/cars` are all
 * 404 on 2.4.15. Both are served without credentials under Public Access.
 *
 * `/cars` pages at fifty; `/tracks` did not paginate at 21 tracks, but is
 * walked the same way rather than assumed to be one page.
 */
export const CARS_PATH = "/cars"
export const TRACKS_PATH = "/tracks"

export function eventEditPath(championshipId: string, eventId: string, server = 0): string {
  return `/championship/${encodeURIComponent(championshipId)}/event/${encodeURIComponent(
    eventId,
  )}/edit?server=${server}`
}

export function eventSubmitPath(championshipId: string): string {
  return `/championship/${encodeURIComponent(championshipId)}/event/submit`
}

/**
 * The schedule form's action. POST-only — a GET is a 405 on 2.4.x, and the
 * form itself is on `championshipPath`.
 */
export function eventSchedulePath(championshipId: string, eventId: string): string {
  return `/championship/${encodeURIComponent(championshipId)}/event/${encodeURIComponent(eventId)}/schedule`
}

export function entrantStatusPath(championshipId: string, entrantGuid: string): string {
  return `/championship/${encodeURIComponent(championshipId)}/entrant/${encodeURIComponent(entrantGuid)}`
}

/** Championship import. Multipart, one file part, on 2.4.x. */
export const IMPORT_PATH = "/championship/import"
