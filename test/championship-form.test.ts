import { describe, expect, it } from "vitest"

import {
  CHAMPIONSHIP_REQUIRED_ENTRY_LIST_FIELDS,
  ChampionshipFormError,
  currentNames,
  currentSkins,
  entrantRowIndex,
  findChampionshipForm,
  setEntrantSkin,
  stripEntrantTemplates,
} from "../src/acsm/championship-form.js"
import { checkEntryListShape, getAll } from "../src/acsm/form.js"
import { CHAMPIONSHIP_SUBMIT_PATH } from "../src/acsm/paths.js"

const PAGE_URL = "https://acsm.example/championship/abc/edit"

/**
 * One entrant row, shaped like ACSM's `entrant` partial on the championship
 * form: no `EntryList.EntrantID`, and the skin select carrying only the current
 * skin because `manager.js` rebuilds that list on load.
 */
function entrantRow(opts: { name?: string; skin?: string; spectator?: boolean } = {}): string {
  const { name = "", skin = "", spectator = false } = opts
  return `
    <div class="entrant">
      <input type="hidden" name="EntryList.InternalUUID" value="00000000-0000-0000-0000-000000000000">
      <select name="EntryList.Car"><option value="rss_formula_hybrid_2021" selected>car</option></select>
      <select name="EntryList.Skin">${skin ? `<option value="${skin}" selected>${skin}</option>` : ""}</select>
      <input type="text" name="EntryList.Name" value="${name}">
      <input type="text" name="EntryList.Team" value="">
      <input type="text" name="EntryList.GUID" value="">
      <input type="number" name="EntryList.Ballast" value="0">
      <input type="number" name="EntryList.Restrictor" value="0">
      <select name="EntryList.FixedSetup"><option value="" selected></option></select>
      <input type="checkbox" name="EntryList.OverwriteAllEvents">
      ${spectator ? `<input type="checkbox" name="EntryList.Spectator">` : `<input type="checkbox" name="EntryList.TransferTeamPoints">`}
    </div>`
}

/**
 * The page, in the order 2.4.15 renders it: a spectator block with its own
 * template, then each class with its own template ahead of the real entrants.
 */
function championshipPage(
  classes: { entrants: { name: string; skin: string }[] }[],
  options: { spectator?: boolean; templates?: boolean } = {},
): string {
  const { spectator = true, templates = true } = options
  const tmpl = (spec = false) =>
    templates ? `<div id="entrantTemplate">${entrantRow({ spectator: spec })}</div>` : ""

  const spectatorBlock = spectator
    ? `${tmpl(true)}${entrantRow({ name: "Stream Van", skin: "van", spectator: true })}`
    : ""

  const classBlocks = classes
    .map(
      (c) => `
      <div class="card">
        <input type="hidden" name="ClassID" value="class-1">
        <input type="text" name="ClassName" value="RSS Formula Hybrid">
        ${tmpl()}
        ${c.entrants.map((e) => entrantRow(e)).join("")}
        <input type="hidden" name="EntryList.NumEntrants" value="${c.entrants.length}">
      </div>`,
    )
    .join("")

  return `<html><body>
    <form action="/search"><input name="q"></form>
    <form action="${CHAMPIONSHIP_SUBMIT_PATH}" method="post">
      <input type="text" name="ChampionshipName" value="September 2026">
      ${spectatorBlock}
      ${classBlocks}
    </form>
  </body></html>`
}

const roster = [
  { name: "Misha", skin: "misha_old" },
  { name: "postaL", skin: "postal_01" },
  { name: "", skin: "" },
]

describe("stripEntrantTemplates", () => {
  it("removes every #entrantTemplate, not just the first", () => {
    // Duplicate ids are not valid HTML, and ACSM renders one per class block
    // plus one for the spectator. A selector that stopped at the first would
    // leave a row behind and shift every entrant after it.
    const { html, removed } = stripEntrantTemplates(championshipPage([{ entrants: roster }]))
    expect(removed).toBe(2)
    expect(html).not.toContain("entrantTemplate")
  })

  it("removes the row's fields, not merely the id", () => {
    const before = championshipPage([{ entrants: roster }])
    const after = stripEntrantTemplates(before).html
    const countNames = (h: string) => h.split('name="EntryList.Name"').length - 1
    expect(countNames(before)).toBe(6) // 2 templates + spectator + 3 entrants
    expect(countNames(after)).toBe(4)
  })

  it("leaves a page with no templates alone", () => {
    const page = championshipPage([{ entrants: roster }], { templates: false })
    expect(stripEntrantTemplates(page)).toMatchObject({ removed: 0 })
  })
})

describe("findChampionshipForm", () => {
  it("accounts for every row: spectator, then the class", () => {
    const form = findChampionshipForm(championshipPage([{ entrants: roster }]), PAGE_URL)
    expect(form).toMatchObject({
      droppedTemplateRows: 2,
      entrantsPerClass: [3],
      hasSpectatorRow: true,
      rows: 4,
    })
  })

  it("takes the championship form, not the navbar search form", () => {
    // Every ACSM page carries a search form, so "the first form" is that one —
    // the trap that made recon report the import page had no file field.
    const form = findChampionshipForm(championshipPage([{ entrants: roster }]), PAGE_URL)
    expect(getAll(form.fields, "ChampionshipName")).toEqual(["September 2026"])
  })

  it("copes with a build that renders no spectator row", () => {
    // The OSS build has no spectator car, and HandleCreateChampionship reads no
    // row for one. Derived from the arithmetic rather than a version string.
    const page = championshipPage([{ entrants: roster }], { spectator: false })
    expect(findChampionshipForm(page, PAGE_URL)).toMatchObject({
      hasSpectatorRow: false,
      rows: 3,
    })
  })

  it("handles more than one class", () => {
    const page = championshipPage([
      { entrants: roster.slice(0, 2) },
      { entrants: roster.slice(0, 1) },
    ])
    expect(findChampionshipForm(page, PAGE_URL)).toMatchObject({
      entrantsPerClass: [2, 1],
      hasSpectatorRow: true,
      rows: 4,
      droppedTemplateRows: 3,
    })
  })

  it("strips EntryList.Spectator, which ACSM renders and never reads", () => {
    // Two occurrences against four rows. checkEntryListShape is right to refuse
    // that, and the field means nothing — the line reading it in BuildEntryList
    // is commented out.
    const form = findChampionshipForm(championshipPage([{ entrants: roster }]), PAGE_URL)
    expect(getAll(form.fields, "EntryList.Spectator")).toEqual([])
  })

  it("refuses when the rows don't add up", () => {
    // The check that catches the unknown problem rather than a known one: a row
    // champctl can't account for shows up as arithmetic instead of as a driver
    // getting someone else's car.
    const page = championshipPage([{ entrants: roster }]).replace(
      '<input type="hidden" name="EntryList.NumEntrants" value="3">',
      '<input type="hidden" name="EntryList.NumEntrants" value="7">',
    )
    expect(() => findChampionshipForm(page, PAGE_URL)).toThrowError(ChampionshipFormError)
    expect(() => findChampionshipForm(page, PAGE_URL)).toThrowError(
      /4 entrant rows, and the classes account for 7/,
    )
  })

  it("refuses a page whose template rows it could not remove", () => {
    // If ACSM renames the id, the extra rows survive and the arithmetic is what
    // notices. Simulated by renaming it here.
    const page = championshipPage([{ entrants: roster }]).replace(
      /entrantTemplate/g,
      "somethingElse",
    )
    expect(() => findChampionshipForm(page, PAGE_URL)).toThrowError(/that doesn't add up/)
  })

  it("refuses a page with no championship form", () => {
    expect(() =>
      findChampionshipForm("<html><body><form action='/x'></form></body></html>", PAGE_URL),
    ).toThrowError(/No form posting to/)
  })

  it("refuses a form with no EntryList.NumEntrants", () => {
    const page = championshipPage([{ entrants: roster }]).replace(
      /<input type="hidden" name="EntryList.NumEntrants"[^>]*>/g,
      "",
    )
    expect(() => findChampionshipForm(page, PAGE_URL)).toThrowError(
      /no usable EntryList.NumEntrants/,
    )
  })

  it("produces a payload postForm would accept for this form", () => {
    // The whole point of the module. The event form's required list would
    // refuse this because EntryList.EntrantID is genuinely not rendered here.
    const form = findChampionshipForm(championshipPage([{ entrants: roster }]), PAGE_URL)
    expect(checkEntryListShape(form.fields)).toContainEqual(
      expect.objectContaining({ key: "EntryList.EntrantID", count: 0 }),
    )
    expect(
      checkEntryListShape(form.fields, { required: CHAMPIONSHIP_REQUIRED_ENTRY_LIST_FIELDS }),
    ).toEqual([])
  })
})

describe("placing an entrant on the form", () => {
  const form = () => findChampionshipForm(championshipPage([{ entrants: roster }]), PAGE_URL)

  it("skips the spectator row when finding a class entrant", () => {
    // Off by one here means the stream van gets a driver's livery and the
    // driver gets nothing.
    const f = form()
    expect(entrantRowIndex(f, 0, 0)).toBe(1)
    expect(entrantRowIndex(f, 0, 2)).toBe(3)
  })

  it("offsets the second class by the first class's size", () => {
    const f = findChampionshipForm(
      championshipPage([{ entrants: roster.slice(0, 2) }, { entrants: roster.slice(0, 1) }]),
      PAGE_URL,
    )
    expect(entrantRowIndex(f, 0, 0)).toBe(1)
    expect(entrantRowIndex(f, 1, 0)).toBe(3)
  })

  it("starts at row 0 when there is no spectator row", () => {
    const f = findChampionshipForm(
      championshipPage([{ entrants: roster }], { spectator: false }),
      PAGE_URL,
    )
    expect(entrantRowIndex(f, 0, 0)).toBe(0)
  })

  it("refuses an entrant index the form does not have", () => {
    expect(() => entrantRowIndex(form(), 0, 3)).toThrowError(/there is no entrant 3/)
  })

  it("refuses a class the form does not have", () => {
    expect(() => entrantRowIndex(form(), 1, 0)).toThrowError(/there is no class 1/)
  })

  it("changes one skin and leaves every other row alone", () => {
    const f = form()
    expect(currentNames(f)).toEqual(["Stream Van", "Misha", "postaL", ""])
    expect(currentSkins(f)).toEqual(["van", "misha_old", "postal_01", ""])

    setEntrantSkin(f.fields, entrantRowIndex(f, 0, 0), "Misha")
    expect(currentSkins(f)).toEqual(["van", "Misha", "postal_01", ""])
  })

  it("keeps the payload's arity when it sets a skin", () => {
    const f = form()
    setEntrantSkin(f.fields, entrantRowIndex(f, 0, 1), "postaL")
    expect(
      checkEntryListShape(f.fields, { required: CHAMPIONSHIP_REQUIRED_ENTRY_LIST_FIELDS }),
    ).toEqual([])
  })
})
