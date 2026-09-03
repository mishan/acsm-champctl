import { describe, expect, it } from "vitest"

import {
  CHAMPIONSHIP_REQUIRED_ENTRY_LIST_FIELDS,
  ChampionshipFormError,
  currentNames,
  currentSkins,
  entrantRowIndex,
  findChampionshipForm,
  setEntrantSkin,
  findEntrantRow,
  stripClonedTemplates,
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

/** One `championship-class` block: a ClassName, an #entrantTemplate, entrants. */
function classBlock(
  entrants: { name: string; skin: string }[],
  options: { templates?: boolean } = {},
): string {
  const { templates = true } = options
  return `
    <div class="card race-setup">
      <input type="hidden" name="ClassID" value="class-1">
      <input type="text" name="ClassName" value="RSS Formula Hybrid">
      ${templates ? `<div id="entrantTemplate" class="entrant">${entrantRow()}</div>` : ""}
      ${entrants.map((e) => entrantRow(e)).join("")}
      <input type="hidden" name="EntryList.NumEntrants" value="${entrants.length}">
    </div>`
}

/**
 * The page, in the order 2.4.15 renders it.
 *
 * The `#class-template` block is the one that bit: `new.html` renders a whole
 * hidden `championship-class` for the "Add another class" button, carrying its
 * own ClassName, its own EntryList.NumEntrants of 0, and its own
 * #entrantTemplate — and `manager.js` removes the lot on load. The old fixture
 * had no such block, which is why the suite was green against a form champctl
 * could not actually write.
 */
function championshipPage(
  classes: { entrants: { name: string; skin: string }[] }[],
  options: { spectator?: boolean; templates?: boolean; classTemplate?: boolean } = {},
): string {
  const { spectator = true, templates = true, classTemplate = true } = options

  const spectatorBlock = spectator
    ? `<div class="visible-spectator-enabled" style="display: none">
         ${entrantRow({ name: "Stream Van", skin: "van", spectator: true })}
       </div>`
    : ""

  // Reconstructed from what BATL's 2.4.15 actually rendered, rather than from
  // reading the template: 32 entrant rows for 29 entrants, `ClassName` twice,
  // `EntryList.NumEntrants` as "0, 29", and exactly *one* #entrantTemplate. The
  // only arrangement that gives those four numbers is a class-template block
  // holding a plain entrant row and no entrant template of its own — which is
  // class.html's `{{ else }}` branch. Guessing it held an #entrantTemplate
  // instead made the fixture add up by luck at three entrants and fail at 29.
  const classTemplateBlock = classTemplate
    ? `<div id="class-template" style="display: none;">
         <div class="card race-setup">
           <input type="hidden" name="ClassID" value="">
           <input type="text" name="ClassName" value="">
           ${entrantRow()}
           <input type="hidden" name="EntryList.NumEntrants" value="0">
         </div>
       </div>`
    : ""

  return `<html><body>
    <form action="/search"><input name="q"></form>
    <form action="${CHAMPIONSHIP_SUBMIT_PATH}" method="post">
      <input type="text" name="ChampionshipName" value="September 2026">
      ${spectatorBlock}
      ${classTemplateBlock}
      ${classes.map((c) => classBlock(c.entrants, { templates })).join("")}
    </form>
  </body></html>`
}

const roster = [
  { name: "Misha", skin: "misha_old" },
  { name: "postaL", skin: "postal_01" },
  { name: "", skin: "" },
]

describe("stripClonedTemplates", () => {
  it("removes both templates the browser removes", () => {
    const { html, classTemplates, entrantTemplates } = stripClonedTemplates(
      championshipPage([{ entrants: roster }]),
    )
    // One #class-template, and one #entrantTemplate left over in the real class
    // — the class template's own entrant template went with the block.
    expect({ classTemplates, entrantTemplates }).toEqual({
      classTemplates: 1,
      entrantTemplates: 1,
    })
    expect(html).not.toContain("entrantTemplate")
    expect(html).not.toContain("class-template")
  })

  it("takes the class template's ClassName and NumEntrants with it", () => {
    // The heart of the bug. Left in, the form carries ClassName twice and
    // NumEntrants as "0, 29", and ACSM builds an empty first class and then
    // reads the real one starting a row early.
    const before = championshipPage([{ entrants: roster }])
    const after = stripClonedTemplates(before).html
    const count = (h: string, needle: string) => h.split(needle).length - 1
    expect(count(before, 'name="ClassName"')).toBe(2)
    expect(count(after, 'name="ClassName"')).toBe(1)
    expect(count(before, 'name="EntryList.NumEntrants"')).toBe(2)
    expect(count(after, 'name="EntryList.NumEntrants"')).toBe(1)
  })

  it("removes the rows' fields, not merely the ids", () => {
    const before = championshipPage([{ entrants: roster }])
    const after = stripClonedTemplates(before).html
    const countNames = (h: string) => h.split('name="EntryList.Name"').length - 1
    // spectator + the class template's row + the real #entrantTemplate + 3
    expect(countNames(before)).toBe(6)
    expect(countNames(after)).toBe(4)
  })

  it("removes an #entrantTemplate in every real class", () => {
    const { entrantTemplates } = stripClonedTemplates(
      championshipPage([{ entrants: roster.slice(0, 2) }, { entrants: roster.slice(0, 1) }]),
    )
    expect(entrantTemplates).toBe(2)
  })

  it("removes a class template that does carry its own entrant template", () => {
    // master's class.html renders #entrantTemplate unconditionally, so a build
    // where the hidden block holds one has to work too. Removing the outer
    // block takes it along, which is why the class template goes first.
    const page = championshipPage([{ entrants: roster }]).replace(
      '<div id="class-template" style="display: none;">',
      '<div id="class-template" style="display: none;"><div id="entrantTemplate" class="entrant">' +
        '<input type="text" name="EntryList.Name" value=""></div>',
    )
    const { html, classTemplates, entrantTemplates } = stripClonedTemplates(page)
    expect(classTemplates).toBe(1)
    // One, not two: the class template's own entrant template went with the
    // block, so this count means "real class blocks" rather than "templates
    // that existed". Removing the entrant templates first would report 2 and
    // make the number useless for diagnosing a form.
    expect(entrantTemplates).toBe(1)
    expect(html).not.toContain("entrantTemplate")
  })

  it("leaves a page with no templates alone", () => {
    const page = championshipPage([{ entrants: roster }], {
      templates: false,
      classTemplate: false,
    })
    expect(stripClonedTemplates(page)).toMatchObject({
      classTemplates: 0,
      entrantTemplates: 0,
    })
  })
})

describe("findChampionshipForm", () => {
  it("accounts for every row: spectator, then the class", () => {
    const form = findChampionshipForm(championshipPage([{ entrants: roster }]), PAGE_URL)
    expect(form).toMatchObject({
      droppedClassTemplates: 1,
      droppedTemplateRows: 1,
      entrantsPerClass: [3],
      hasSpectatorRow: true,
      rows: 4,
    })
  })

  it("reads the same form whether or not the class template is there", () => {
    // The regression, stated as the property that matters: a page carrying the
    // hidden class block has to parse to the same payload as one without it,
    // because the browser makes them identical before submitting.
    const withTemplate = findChampionshipForm(championshipPage([{ entrants: roster }]), PAGE_URL)
    const without = findChampionshipForm(
      championshipPage([{ entrants: roster }], { classTemplate: false }),
      PAGE_URL,
    )
    expect(withTemplate.rows).toBe(without.rows)
    expect(withTemplate.entrantsPerClass).toEqual(without.entrantsPerClass)
    expect(currentNames(withTemplate)).toEqual(currentNames(without))
    expect(currentSkins(withTemplate)).toEqual(currentSkins(without))
  })

  it("refuses the real form shape when the class template is left in", () => {
    // What BATL's manager produced: 31 rows against classes claiming 0 + 29.
    // Reconstructed here at the sizes that failed, so a change that stops
    // removing #class-template fails in the suite rather than on race night.
    const page = championshipPage([{ entrants: roster }])
    const keptTemplate = page.replace(/id="class-template"/, 'id="kept-template"')
    expect(() => findChampionshipForm(keptTemplate, PAGE_URL)).toThrowError(
      /entrant rows, and the classes account for 3 \(0 \+ 3\)/,
    )
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
      droppedClassTemplates: 1,
      droppedTemplateRows: 2,
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

  it("finds a driver's row by their name", () => {
    // Preferred over the arithmetic for deciding where to write: the index is
    // derived from assumptions that each had to be learned by being wrong,
    // where the name is rendered in the very row being edited.
    const f = form()
    expect(findEntrantRow(f, "Misha")).toBe(1)
    expect(findEntrantRow(f, "postaL")).toBe(2)
  })

  it("agrees with the arithmetic when the form is understood", () => {
    const f = form()
    expect(findEntrantRow(f, "Misha")).toBe(entrantRowIndex(f, 0, 0))
    expect(findEntrantRow(f, "postaL")).toBe(entrantRowIndex(f, 0, 1))
  })

  it("finds the spectator row, which is why an empty name never matches", () => {
    const f = form()
    expect(findEntrantRow(f, "Stream Van")).toBe(0)
    // The blank third roster slot. Matching it would put a livery on an
    // unclaimed seat.
    expect(findEntrantRow(f, "")).toBeUndefined()
    expect(findEntrantRow(f, "   ")).toBeUndefined()
  })

  it("returns undefined for somebody who is not on the form", () => {
    expect(findEntrantRow(form(), "Nobody")).toBeUndefined()
  })

  it("matches when the form carries the decomposed spelling", () => {
    // The direction the first version of this test missed: it normalised only
    // the name being looked up, so with an already-NFC form the assertion held
    // with the code removed.
    const page = championshipPage([{ entrants: [{ name: "Ricky Ha\u0308kkinen", skin: "old" }] }])
    const f = findChampionshipForm(page, PAGE_URL)
    expect(findEntrantRow(f, "Ricky H\u00e4kkinen")).toBe(1)
  })

  it("matches a name whose accents are encoded differently", () => {
    const page = championshipPage([{ entrants: [{ name: "Ricky H\u00e4kkinen", skin: "old" }] }])
    const f = findChampionshipForm(page, PAGE_URL)
    expect(findEntrantRow(f, "Ricky Ha\u0308kkinen")).toBe(1)
  })

  it("refuses rather than guessing when a name is in two rows", () => {
    const page = championshipPage([
      {
        entrants: [
          { name: "Misha", skin: "a" },
          { name: "Misha", skin: "b" },
        ],
      },
    ])
    const f = findChampionshipForm(page, PAGE_URL)
    expect(() => findEntrantRow(f, "Misha")).toThrowError(/in 2 rows \(1, 2\)/)
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
