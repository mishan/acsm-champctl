import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createCanvas, loadImage } from "@napi-rs/canvas"
import { afterEach, describe, expect, it } from "vitest"

import { StaticAcsmReader, type AcsmReader } from "../src/acsm/client.js"
import type { Championship } from "../src/acsm/types.js"
import { parsePodium } from "../src/bot/podium.js"
import {
  finishedAt,
  postPodium,
  postRecentPodiums,
  type TrophyDeps,
  type TrophyPost,
} from "../src/bot/trophies.js"
import { cardColor, NO_PREVIEW_COLOR, renderPodium, textColor } from "../src/bot/trophy-image.js"
import { SqliteTrophyStore } from "../src/bot/trophy-store.js"
import { championship, raceEvent } from "./support/build.js"

/**
 * A finished championship's page, shaped like BATL's manager renders it. A
 * multi-class one labels each card with its class and colors it; a
 * single-class one does neither.
 */
function page(cards: { place: number; driver: string; cls?: string; color?: string }[]): string {
  const card = (c: (typeof cards)[number]) => `
    <div class="col-6 col-lg-3 col-md-3 col-sm-6 entrant-car">
      <div class="card card-block"${c.color ? ` style="color: white; background: ${c.color}"` : ""}>
        <img src="/content/cars/car/skins/${c.driver}/preview.jpg" alt="Car Skin" class="card-img-top"/>
        <div class="card-body p-1 text-center">
          ${c.cls ? `<small>${c.cls}</small><br/>` : ""}
          ${c.place}${["th", "st", "nd", "rd"][c.place] ?? "th"} Place
          <p class="mb-0"><small>${c.driver}<br/></small></p>
        </div>
      </div>
    </div>`
  return `<html><body><div class="row car-skin-overview-container">${cards.map(card).join("")}</div></body></html>`
}

const single = page([
  { place: 1, driver: "ada" },
  { place: 2, driver: "bo" },
  { place: 3, driver: "cy" },
  { place: 4, driver: "di" },
])

const multi = page([
  { place: 1, driver: "ada", cls: "Platinum", color: "#00cc00" },
  { place: 2, driver: "bo", cls: "Platinum", color: "#00cc00" },
  { place: 1, driver: "cy", cls: "Gold", color: "#c4c400" },
  { place: 3, driver: "di", cls: "Platinum", color: "#00cc00" },
])

describe("reading the podium off a finished championship's page", () => {
  it("takes the top three, in order", () => {
    expect(parsePodium(single)).toEqual([
      {
        name: "",
        places: [
          { place: 1, driver: "ada", preview: "/content/cars/car/skins/ada/preview.jpg" },
          { place: 2, driver: "bo", preview: "/content/cars/car/skins/bo/preview.jpg" },
          { place: 3, driver: "cy", preview: "/content/cars/car/skins/cy/preview.jpg" },
        ],
      },
    ])
  })

  it("splits a multi-class row by the class on each card, with its color", () => {
    const podium = parsePodium(multi)
    expect(podium).not.toBeTypeOf("string")
    const classes = podium as Exclude<typeof podium, string>
    expect(classes.map((c) => [c.name, c.color, c.places.map((p) => p.driver)])).toEqual([
      ["Platinum", "#00cc00", ["ada", "bo", "di"]],
      ["Gold", "#c4c400", ["cy"]],
    ])
  })

  it("calls a page with no finishers absent: the championship isn't finished", () => {
    expect(parsePodium("<html><body><div id='drivers'></div></body></html>")).toBe("absent")
  })

  it.each([
    ["a card with no place", single.replace("1st Place", "Winner")],
    ["a class that doesn't start at first", single.replace("1st Place", "5th Place")],
    ["two finisher rows", single.replace("</body>", `${single}</body>`)],
  ])("refuses %s rather than posting a guessed podium", (_, html) => {
    expect(parsePodium(html)).toBe("unrecognised")
  })
})

describe("drawing the podium", () => {
  const jpeg = async () => {
    const c = createCanvas(1022, 575)
    const g = c.getContext("2d")
    g.fillStyle = "#c00"
    g.fillRect(0, 0, 1022, 575)
    return new Uint8Array(await c.encode("jpeg"))
  }

  it("draws a card per place, side by side", async () => {
    const podium = (parsePodium(single) as Exclude<ReturnType<typeof parsePodium>, string>)[0]!
    const png = await renderPodium(podium, [await jpeg(), await jpeg(), await jpeg()])
    const image = await loadImage(png)
    expect(image.width).toBeGreaterThan(image.height * 2)
    expect(png.subarray(1, 4).toString()).toBe("PNG")
  })

  /** The color at the middle of a panel's preview area, as #rrggbb. */
  const pixel = async (png: Buffer, panel: number): Promise<string> => {
    const image = await loadImage(png)
    const c = createCanvas(image.width, image.height)
    const g = c.getContext("2d")
    g.drawImage(image, 0, 0)
    // Three panels with two gaps between them; the preview fills each panel's top.
    const panelWidth = (image.width * 250) / (3 * 250 + 2 * 12)
    const x = Math.round(panel * (panelWidth * (1 + 12 / 250)) + panelWidth / 2)
    const [r, gr, b] = g.getImageData(x, Math.round(panelWidth * 0.28), 1, 1).data
    return `#${[r!, gr!, b!].map((v) => v.toString(16).padStart(2, "0")).join("")}`
  }

  it("still draws the others when one driver's preview couldn't be fetched", async () => {
    // Asserted on the pixels: a renderer that drew nothing would pass a check
    // that only decodes the PNG.
    const podium = (parsePodium(single) as Exclude<ReturnType<typeof parsePodium>, string>)[0]!
    const png = await renderPodium(podium, [await jpeg(), undefined, await jpeg()])
    const red = (hex: string) => Number.parseInt(hex.slice(1, 3), 16) > 180
    expect(red(await pixel(png, 0))).toBe(true)
    expect(await pixel(png, 1)).toBe(NO_PREVIEW_COLOR)
    expect(red(await pixel(png, 2))).toBe(true)
  })

  it("gives a class named for a metal that metal's color, whatever ACSM picked", () => {
    // BATL's Platinum, Gold and Silver are green, yellow and red in ACSM.
    const of = (name: string, color = "#00cc00") => cardColor({ name, color, places: [] })
    expect(of("Platinum")).not.toBe("#00cc00")
    expect(new Set([of("Platinum"), of("Gold"), of("Silver"), of("Bronze")]).size).toBe(4)
    expect(of("GT3")).toBe("#00cc00")
    expect(cardColor({ name: "", places: [] })).toBe("#343a40")
  })

  it.each(["#00cc00", "#c4c400", "#b70000", "#343a40", "#d6dae1", "#d4a72c", "#b3b8c0", "#b4783f"])(
    "keeps the text readable on %s",
    (bg) => {
      // WCAG AA for large text: 3:1. Always-white text was 1.9:1 on ACSM's Gold.
      const lum = (hex: string) => {
        const [r, g, b] = [1, 3, 5].map((i) => {
          const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
        })
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
      }
      const [a, b] = [lum(bg), lum(textColor(bg))]
      expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThanOrEqual(3)
    },
  )
})

const NOW = new Date("2026-10-20T12:00:00Z")
const raced = (completed: string) => raceEvent({ CompletedTime: completed } as never)

describe("when a championship finished", () => {
  it("is the latest round's completion, once every round has results", () => {
    const c = championship({
      Events: [raced("2026-10-01T20:00:00Z"), raced("2026-10-15T21:30:00Z")],
    })
    expect(finishedAt(c)?.toISOString()).toBe("2026-10-15T21:30:00.000Z")
  })

  it("is undefined while a round is still to be raced", () => {
    const c = championship({ Events: [raced("2026-10-01T20:00:00Z"), raceEvent()] })
    expect(finishedAt(c)).toBeUndefined()
  })

  it("is undefined for a championship with no rounds", () => {
    expect(finishedAt(championship({ Events: [] }))).toBeUndefined()
  })
})

describe("posting podiums", () => {
  let dir = ""
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = ""
  })

  /** A manager with these championships and pages, and a store on disk. */
  const setup = async (champs: Championship[], pages: Record<string, string>) => {
    dir = await mkdtemp(join(tmpdir(), "champctl-trophy-"))
    const store = await SqliteTrophyStore.open(join(dir, "store.db"))
    const inner = new StaticAcsmReader(champs)
    const reader: AcsmReader = {
      listChampionships: () => inner.listChampionships(),
      exportChampionship: (id) => inner.exportChampionship(id),
      exportChampionshipRaw: (id) => inner.exportChampionshipRaw(id),
      standings: () => inner.standings(),
      championshipPage: async (id) => pages[id] ?? "<html></html>",
      healthcheck: () => inner.healthcheck(),
      listContent: () => inner.listContent(),
    }
    const posts: TrophyPost[] = []
    const deps: TrophyDeps = {
      reader,
      fetchAsset: async () => undefined,
      post: async (m) => {
        posts.push(m)
      },
      posted: (id) => store.posted(id),
      record: (id, cls) => store.record(id, cls, NOW),
    }
    return { deps, posts, store }
  }

  const finished = (ID: string, Name: string, completed: string) =>
    championship({ ID, Name, Events: [raced(completed)] })

  it("posts a championship that finished this week, once however often it runs", async () => {
    const { deps, posts } = await setup([finished("a", "October", "2026-10-18T21:00:00Z")], {
      a: single,
    })
    await postRecentPodiums(deps, NOW)
    await postRecentPodiums(deps, NOW)

    expect(posts).toHaveLength(1)
    expect(posts[0]!.content).toBe("**October**")
    expect(posts[0]!.files[0]!.name).toBe("October-podium.png")
    // The results are in the image's pixels; the alt text says them too.
    expect(posts[0]!.files[0]!.description).toBe(
      "October: 1st place ada, 2nd place bo, 3rd place cy",
    )
  })

  it("leaves seasons that finished before this week alone", async () => {
    // The first night would otherwise post every season the league has run.
    const { deps, posts } = await setup([finished("old", "March", "2026-03-30T21:00:00Z")], {
      old: single,
    })
    expect(await postRecentPodiums(deps, NOW)).toEqual([])
    expect(posts).toEqual([])
  })

  it("leaves a championship with rounds still to race alone", async () => {
    const running = championship({
      ID: "r",
      Name: "Live",
      Events: [raced("2026-10-18T21:00:00Z"), raceEvent()],
    })
    const { deps, posts } = await setup([running], { r: single })
    await postRecentPodiums(deps, NOW)
    expect(posts).toEqual([])
  })

  it("posts one image per class, titled with it", async () => {
    const { deps, posts } = await setup([finished("m", "Radicals", "2026-10-18T21:00:00Z")], {
      m: multi,
    })
    await postRecentPodiums(deps, NOW)
    expect(posts.map((p) => p.content)).toEqual(["**Radicals — Platinum**", "**Radicals — Gold**"])
  })

  it("finishes a multi-class post that stopped part way, without repeating a class", async () => {
    const { deps, posts, store } = await setup(
      [finished("m", "Radicals", "2026-10-18T21:00:00Z")],
      { m: multi },
    )
    store.record("m", "Platinum", NOW)
    await postRecentPodiums(deps, NOW)
    expect(posts.map((p) => p.content)).toEqual(["**Radicals — Gold**"])
  })

  it("says so, and posts nothing, when the podium isn't laid out as expected", async () => {
    const { deps, posts } = await setup([finished("a", "October", "2026-10-18T21:00:00Z")], {
      a: single.replace("1st Place", "Winner"),
    })
    const [outcome] = await postRecentPodiums(deps, NOW)
    expect(outcome?.kind).toBe("failed")
    expect(posts).toEqual([])
  })

  it("posts again on demand, for trophy <id>", async () => {
    const { deps, posts } = await setup([finished("a", "October", "2026-10-18T21:00:00Z")], {
      a: single,
    })
    await postRecentPodiums(deps, NOW)
    await postPodium(deps, "a", "October", true)
    expect(posts).toHaveLength(2)
  })
})
