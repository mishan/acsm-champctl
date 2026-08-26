import { describe, expect, it } from "vitest"

import {
  championshipsFrom,
  championshipIdsFrom,
  walkChampionshipIds,
  walkChampionships,
} from "../src/acsm/listing.js"

const A = "11111111-2222-3333-4444-555555555555"
const B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

describe("reading championship ids off the listing page", () => {
  it("finds one per link, deduplicated", () => {
    const html = `<html><body>
      <a href="/championship/${A}">August</a>
      <a href="/championship/${A}/export">export</a>
      <a href="/championship/${B}">September</a>
    </body></html>`
    expect(championshipIdsFrom(html).sort()).toEqual([A, B].sort())
  })

  it("resolves a relative href", () => {
    expect(championshipIdsFrom(`<a href="championship/${A}">x</a>`)).toEqual([A])
  })

  it("lower-cases, so the same championship isn't counted twice", () => {
    const html = `<a href="/championship/${A.toUpperCase()}">x</a><a href="/championship/${A}">y</a>`
    expect(championshipIdsFrom(html)).toEqual([A])
  })

  /**
   * The reason this walks a parsed DOM instead of running a pattern over the
   * markup. Every case here contains a string a regular expression matching
   * `/championship/<uuid>` would happily accept, and none of them is a
   * championship listed on the page — a commented-out row left by a template
   * change, an id inside a script, and a `data-` attribute that isn't a link.
   *
   * A scrape that over-reports is not a cosmetic problem: the archive fetches
   * and stores an export per id, so a phantom becomes a failed fetch and a
   * nightly job that exits 2 forever.
   */
  it("ignores ids that aren't links", () => {
    const html = `<html><body>
      <!-- <a href="/championship/${A}">removed</a> -->
      <script>var last = "/championship/${A}";</script>
      <div data-href="/championship/${A}">not a link</div>
      <a href="/championship/${B}">the only real one</a>
    </body></html>`
    expect(championshipIdsFrom(html)).toEqual([B])
  })

  it("ignores links that merely mention a uuid", () => {
    const html = `
      <a href="/results/${A}">a result</a>
      <a href="/championships?after=${A}">a filter</a>
      <a href="/championship/not-a-uuid">a slug</a>`
    expect(championshipIdsFrom(html)).toEqual([])
  })

  it("returns nothing for a page with no championships, rather than throwing", () => {
    expect(championshipIdsFrom("<html><body><p>None yet.</p></body></html>")).toEqual([])
    expect(championshipIdsFrom("")).toEqual([])
  })
})

describe("walking the listing pages", () => {
  const page = (ids: string[], links: string[] = []) =>
    `<html><body>
      ${ids.map((i) => `<a href="/championship/${i}">c</a>`).join("")}
      <nav class="pagination">${links.map((l) => `<a href="${l}">n</a>`).join("")}</nav>
    </body></html>`

  it("reads one page when there is only one", async () => {
    const fetched: string[] = []
    const ids = await walkChampionshipIds(async (p) => {
      fetched.push(p)
      return page([A, B])
    })
    expect(fetched).toEqual(["/championships"])
    expect(ids.sort()).toEqual([A, B].sort())
  })

  /**
   * The failure this exists to prevent: an archive that reads page one, looks
   * like it worked, and silently stops recording the rest of a league's
   * history. 2.4.5 does not paginate at 24 championships, so this is the only
   * place the behaviour is exercised — the shape is asserted here rather than
   * left to be discovered on a bigger server.
   */
  it("follows further pages, whatever the query parameter is called", async () => {
    const C = "cccccccc-1111-2222-3333-444444444444"
    const pages: Record<string, string> = {
      "/championships": page([A], ["/championships?p=2"]),
      "/championships?p=2": page([B], ["/championships?p=3", "/championships"]),
      "/championships?p=3": page([C], ["/championships?p=2"]),
    }
    const fetched: string[] = []
    const ids = await walkChampionshipIds(async (p) => {
      fetched.push(p)
      return pages[p] ?? ""
    })
    expect(ids.sort()).toEqual([A, B, C].sort())
    // Each page once, despite the links pointing back at each other.
    expect(fetched).toHaveLength(3)
  })

  /**
   * Bounded, and *loud* about it. Returning the ids gathered so far would hand
   * back a short list that is indistinguishable from a complete one: the
   * archive treats a listing failure as fatal, but a partial listing looks like
   * success, so it would quietly stop recording everything past the bound and
   * still exit 0.
   */
  it("refuses to return a short list when it hits the bound", async () => {
    let n = 0
    await expect(
      walkChampionshipIds(async () => {
        n++
        return page([A], [`/championships?p=${n}`])
      }),
    ).rejects.toThrow(/incomplete/)
    expect(n, "bounded rather than looping").toBeLessThanOrEqual(20)
  })

  it("does not throw when the bound is reached with nothing left to visit", async () => {
    // Exactly at the limit and finished is finished; the guard is about work
    // left undone, not about the count.
    let n = 0
    const ids = await walkChampionshipIds(async () => {
      n++
      return n < 20 ? page([A], [`/championships?p=${n}`]) : page([B])
    })
    expect(ids.sort()).toEqual([A, B].sort())
  })
})

describe("names off the listing", () => {
  it("reads the name from the link the id came from", () => {
    // The whole reason this exists: no ACSM build serves
    // /api/championships/list.json, so every list goes through the scrape, and
    // ids-only meant the UI showed people UUIDs for championships they had
    // named themselves.
    const html = `<ul>
      <li><a href="/championship/11111111-2222-3333-4444-555555555555">September 2026</a></li>
    </ul>`
    expect(championshipsFrom(html)).toEqual([
      { id: "11111111-2222-3333-4444-555555555555", name: "September 2026" },
    ])
  })

  it("takes the title link's text, not the edit and export ones beside it", () => {
    const id = "11111111-2222-3333-4444-555555555555"
    const html = `<tr>
      <td><a href="/championship/${id}">September 2026</a></td>
      <td><a href="/championship/${id}/edit">Edit</a></td>
      <td><a href="/championship/${id}/export">Export</a></td>
    </tr>`
    expect(championshipsFrom(html)).toEqual([{ id, name: "September 2026" }])
  })

  it("names a championship after a button on no template, whatever the order", () => {
    // Document order is not something a template promises, and taking the
    // first link the id appeared in made "Export" a plausible championship
    // name. Only `/championship/{id}` itself carries the title; the deeper
    // links still count towards the ids, because a page that links only to
    // /export is still listing that championship.
    const id = "11111111-2222-3333-4444-555555555555"
    const html = `<tr>
      <td><a href="/championship/${id}/export">Export</a></td>
      <td><a href="/championship/${id}">September 2026</a></td>
    </tr>`
    expect(championshipsFrom(html)).toEqual([{ id, name: "September 2026" }])
    expect(championshipsFrom(`<a href="/championship/${id}/export">Export</a>`)).toEqual([{ id }])
  })

  it("leaves the name off rather than inventing one", () => {
    // A template that links the id itself, and one with an empty anchor. Both
    // come back nameless and the caller falls back to the id, which is exactly
    // what happened before names were read at all.
    const id = "11111111-2222-3333-4444-555555555555"
    expect(championshipsFrom(`<a href="/championship/${id}">${id}</a>`)).toEqual([{ id }])
    expect(championshipsFrom(`<a href="/championship/${id}"><img src="x"></a>`)).toEqual([{ id }])
  })

  it("collapses the whitespace a template leaves in the markup", () => {
    const id = "11111111-2222-3333-4444-555555555555"
    const html = `<a href="/championship/${id}">\n   September\n   2026\n  </a>`
    expect(championshipsFrom(html)).toEqual([{ id, name: "September 2026" }])
  })

  it("still lists the ids, for callers that only want those", () => {
    const id = "11111111-2222-3333-4444-555555555555"
    expect(championshipIdsFrom(`<a href="/championship/${id}">September 2026</a>`)).toEqual([id])
  })

  /**
   * A name found on a later page still counts.
   *
   * ACSM lists a championship twice across pages, so the walk keeps the first
   * sighting of an id — and a first sighting through `/export` alone carries
   * no name. Keeping that one and discarding the page that has the title link
   * puts the championship back on screen as a UUID, which is what reading
   * names was for.
   */
  it("takes the name from whichever page has one", async () => {
    const id = "11111111-2222-3333-4444-555555555555"
    const pages: Record<string, string> = {
      "/championships": `<a href="/championship/${id}/export">Export</a>
        <a href="/championships?page=2">Next</a>`,
      "/championships?page=2": `<a href="/championship/${id}">September 2026</a>`,
    }
    await expect(walkChampionships(async (p) => pages[p] ?? "")).resolves.toEqual([
      { id, name: "September 2026" },
    ])
  })
})
