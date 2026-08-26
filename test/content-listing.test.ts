/**
 * Reading installed cars and tracks off ACSM's listing pages.
 *
 * The markup here is trimmed from what 2.4.15 actually served — the shape
 * matters more than usual, because the name and the link are in different
 * places and an earlier draft that read the link's own text gave every car an
 * empty name.
 */

import { describe, expect, it } from "vitest"

import { itemsFrom, pageLinksFrom, readInstalledContent } from "../src/acsm/content.js"

/** One card, as 2.4.15 renders it: name in an h3, link as an empty overlay. */
function card(kind: "car" | "track", id: string, name: string): string {
  return `
    <div class="${kind}-wrapper">
      <div class="card mt-2 mb-2 pt-0 pb-0 card-${kind}">
        <div class="card-body row">
          <div class="col-12 col-sm-8 col-md-10">
            <h3 class="mb-0">${name}</h3>
            <div class="mb-2"><span class="badge bg-default-content">Default</span></div>
          </div>
        </div>
      </div>
      <a href="/${kind}/${id}" class="${kind}-link"> </a>
      <a href="/${kind}/${id}/delete" class="btn btn-danger">Delete</a>
    </div>`
}

describe("installed content off the listing pages", () => {
  it("pairs the folder name with the name a person recognises", () => {
    const html = `<div>${card("car", "ks_abarth_595ss", "Abarth 595SS")}</div>`
    expect(itemsFrom(html, "car")).toEqual([{ id: "ks_abarth_595ss", name: "Abarth 595SS" }])
  })

  /**
   * The link 2.4.15 renders for a car is an empty overlay — the name sits in
   * an `<h3>` in the card above it. That is the opposite of the championships
   * listing, where the name *is* the link text, and reading it the same way
   * here sends folder ids to a screen whose whole purpose is to not make
   * anyone type one.
   */
  it("does not take the name from the link, which is empty", () => {
    const html = card("track", "ks_brands_hatch", "Brands Hatch")
    expect(itemsFrom(html, "track")[0]?.name).toBe("Brands Hatch")
  })

  /**
   * 1.7.9's listing, which is the build CI runs the browser suite against, and
   * a different shape entirely: no anchor at all — the card carries
   * `data-href` and JavaScript makes it clickable — and the card is labelled
   * `card-car` whether it holds a car or a track.
   *
   * Worth pinning because the difference is invisible to a grep: `data-href`
   * contains the string `href="/track/spa"` looks for, so the raw markup reads
   * as though it has links. A parser that only looks for `<a href>` finds
   * nothing here and says the manager has no content installed.
   */
  it("reads 1.7.9's listing, where the card carries the link", () => {
    const html = `
      <div class="card mt-2 mb-2 pt-0 pb-0 card-car" data-href="/track/spa">
        <div class="card-body row">
          <div class="col-12 col-sm-8 col-md-10">
            <h3 class="mb-0">Spa</h3>
            <div class="mb-2"><span class="badge bg-default-content">Default</span></div>
          </div>
        </div>
      </div>`
    expect(itemsFrom(html, "track")).toEqual([{ id: "spa", name: "Spa" }])
    // And the same card is not read as a car, despite what it is called.
    expect(itemsFrom(html, "car")).toEqual([])
  })

  it("counts a car once, not once per link to it", () => {
    // Every card carries at least a view link and a delete link.
    expect(itemsFrom(card("car", "abarth500", "Abarth 500"), "car")).toHaveLength(1)
  })

  it("ignores the other listing's links", () => {
    const html = `${card("car", "abarth500", "Abarth 500")}${card("track", "spa", "Spa")}`
    expect(itemsFrom(html, "car").map((i) => i.id)).toEqual(["abarth500"])
    expect(itemsFrom(html, "track").map((i) => i.id)).toEqual(["spa"])
  })

  /**
   * A card with no heading is still an installed car. The screen only offers
   * what comes out of here, so dropping it would make that car unpickable —
   * and under a strict picker, unusable.
   */
  it("falls back to the folder name rather than dropping the entry", () => {
    expect(itemsFrom(`<a href="/car/rss_formula_hybrid_2021"></a>`, "car")).toEqual([
      { id: "rss_formula_hybrid_2021", name: "rss_formula_hybrid_2021" },
    ])
  })

  describe("pagination", () => {
    it("finds the further pages", () => {
      const html = `<a href="/cars?page=1">2</a><a href="/cars?page=2">3</a>`
      expect(pageLinksFrom(html, "/cars").sort()).toEqual(["/cars?page=1", "/cars?page=2"])
    })

    /**
     * `/cars` renders its "previous" control as `?page=-1` while on the first
     * page. Following it costs a request to be handed page one again, under a
     * limiter that allows five reads in twenty seconds.
     */
    it("does not follow the previous-page control off the front page", () => {
      expect(pageLinksFrom(`<a href="/cars?page=-1">Previous</a>`, "/cars")).toEqual([])
    })

    it("does not treat the page it is on as a further page", () => {
      expect(pageLinksFrom(`<a href="/cars?page=1">2</a>`, "/cars?page=1")).toEqual([])
    })

    it("walks every page and keeps them in one list", async () => {
      const pages: Record<string, string> = {
        "/cars": `${card("car", "a", "Alfa")}<a href="/cars?page=1">2</a>`,
        "/cars?page=1": `${card("car", "b", "BMW")}<a href="/cars?page=-1">Previous</a>`,
        "/tracks": card("track", "spa", "Spa"),
      }
      const content = await readInstalledContent(async (p) => pages[p] ?? "")
      expect(content.cars.map((c) => c.id)).toEqual(["a", "b"])
      expect(content.tracks.map((t) => t.id)).toEqual(["spa"])
    })

    /**
     * Sorted by the name people read. The listing's own order is by folder
     * name, which puts "ks_brands_hatch" under K.
     */
    it("sorts by display name, not by folder name", async () => {
      const pages: Record<string, string> = {
        "/tracks": `${card("track", "ks_brands_hatch", "Brands Hatch")}${card("track", "aa_zzz", "Zandvoort")}`,
      }
      const content = await readInstalledContent(async (p) => pages[p] ?? "")
      expect(content.tracks.map((t) => t.name)).toEqual(["Brands Hatch", "Zandvoort"])
    })

    /**
     * Stops rather than throws, unlike the championships walk. A short list
     * there is a silently incomplete archive; here it is a few cars missing
     * from a dropdown, and answering "no cars at all" would be worse.
     */
    it("gives up quietly on a listing that links to itself forever", async () => {
      let n = 0
      const content = await readInstalledContent(async () => {
        n++
        return `${card("car", `c${n}`, `Car ${n}`)}<a href="/cars?page=${n}">next</a>`
      })
      expect(content.cars.length).toBeGreaterThan(0)
      expect(n, "bounded rather than looping").toBeLessThanOrEqual(80)
    })
  })
})
