/**
 * The week's practice laps for one round, read off ACSM's results list.
 *
 * Not the championship export: its `Sessions.PRACTICE` is only the race-night
 * practice. Every loop of a round's looping practice server writes a results
 * file of its own, tagged with the championship but not the round, so a round's
 * files are the ones for its championship, track and layout.
 */

import type { ResultsPage, SessionResults } from "../acsm/types.js"

export interface ResultsReader {
  /** Zero-based, newest first. */
  resultsPage(page: number): Promise<ResultsPage>
  resultFile(sessionFile: string): Promise<SessionResults>
}

export interface PracticeQuery {
  championshipId: string
  track: string
  layout: string
  /**
   * Files from this instant on. Absent: back to the newest race session on the
   * server, from any championship, which on a league night is the last race.
   */
  since?: Date
  /** Files before this instant: the round's own race-night practice is not "earlier that week". */
  until: Date
  maxPages?: number
}

export async function practiceSessions(
  reader: ResultsReader,
  q: PracticeQuery,
): Promise<SessionResults[]> {
  const maxPages = q.maxPages ?? 20
  // A Set, because a session finishing mid-walk pushes a row seen on one page onto the next.
  const names = new Set<string>()

  pages: for (let page = 0; ; page++) {
    if (page === maxPages) {
      // A window read short is missing its oldest laps, and the fastest may be
      // among them: a lap count from it is wrong in the direction nobody checks.
      throw new Error(
        `Read ${maxPages} pages of results without reaching the start of the practice window.`,
      )
    }
    const { num_pages, results = [] } = await reader.resultsPage(page)
    for (const row of results) {
      const at = Date.parse(row.date ?? "")
      if (Number.isNaN(at) || at >= q.until.getTime()) continue
      if (q.since ? at < q.since.getTime() : row.session_type === "RACE") break pages
      if (
        row.session_type !== "PRACTICE" ||
        row.track !== q.track ||
        (row.track_layout ?? "") !== q.layout
      ) {
        continue
      }
      const name = /^\/results\/download\/(.+)\.json$/.exec(row.results_json_url ?? "")?.[1]
      if (!name) {
        throw new Error(
          `Can't tell which file the ${row.date} practice is: ${row.results_json_url}`,
        )
      }
      names.add(name)
    }
    if (results.length === 0 || (num_pages !== undefined && page + 1 >= num_pages)) break
  }

  const out: SessionResults[] = []
  for (const name of names) {
    const file = await reader.resultFile(name)
    if (file.ChampionshipID === q.championshipId) out.push(file)
  }
  return out
}
