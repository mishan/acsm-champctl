import { describe, expect, it } from "vitest"

import {
  FormParseError,
  checkEntryListShape,
  count,
  findFormByAction,
  getAll,
  getOne,
  parseForm,
  parseForms,
  removeAll,
  setAt,
  setOne,
  shape,
  toBody,
  type FormField,
} from "../src/acsm/form.js"
import { entrant, fakeEventForm, fakeImportPage } from "./support/acsm-html.js"

const threeEntrants = [entrant("alice"), entrant("bob"), entrant("carol")]

describe("parsing an ACSM event form", () => {
  const form = () => parseForm(fakeEventForm({ entrants: threeEntrants }))

  it("reads the action, method and enctype", () => {
    const f = form()
    expect(f.method).toBe("POST")
    expect(f.action).toBe("/championship/abc/event/submit")
  })

  it("keeps repeated keys in document order", () => {
    // Order is everything: ACSM indexes EntryList.* as parallel arrays.
    expect(getAll(form().fields, "EntryList.Name")).toEqual(["alice", "bob", "carol"])
    expect(getAll(form().fields, "EntryList.GUID")).toHaveLength(3)
  })

  it("submits readonly fields", () => {
    // Championship entrant rows are readonly, and a browser still sends them.
    // Treating readonly like disabled would blank every name on save.
    expect(getAll(form().fields, "EntryList.Name")).toContain("alice")
  })

  it("omits disabled and unnamed controls", () => {
    const names = form().fields.map((f) => f.name)
    expect(names).not.toContain("Disabled")
    expect(names.filter((n) => !n)).toHaveLength(0)
  })

  /**
   * Not "on", and not absent. ACSM's global submit handler rewrites every
   * checkbox to an explicit "1" or "0" before the browser serialises the form,
   * so "1"/"0" is the only shape its Go side has ever been handed, and it reads
   * "on" as false.
   *
   * This test used to assert browser behaviour — unchecked omitted, checked as
   * "on" — and it was that faithfulness that made a finalize destructive:
   * echoing `Race.Enabled=on` back turned the session off, and a save took the
   * event from three sessions to none while reporting success.
   */
  it("sends every checkbox as 1 or 0, the way ACSM's own submit handler does", () => {
    const fields = form().fields
    expect(getOne(fields, "RaceExtraLap"), "unchecked").toBe("0")
    expect(getOne(fields, "AllowDuplicateSkinChoices"), "checked").toBe("1")
  })

  /**
   * Measured against 2.4.15, not reasoned about. The event form renders one
   * skin `<select>` per entrant, and the ones belonging to `any_car_model`
   * slots come back with no options at all, because ACSM populates them from
   * JavaScript that champctl doesn't run. Six entrants gave two skins; forcing
   * that POST through by hand got an HTTP 500 out of ACSM, which indexes these
   * arrays in parallel without a length check. Padding turned it into a 302
   * with every skin still attached to its own car.
   */
  it("submits an empty value for a select with no options, unlike a browser", () => {
    const fields = parseForm(
      fakeEventForm({
        entrants: [
          entrant("alice"),
          entrant("bob", { model: "any_car_model", skin: "" }),
          entrant("carol", { model: "any_car_model", skin: "" }),
        ],
      }),
    ).fields

    // One per entrant, not one per entrant that has a skin to choose from.
    expect(count(fields, "EntryList.Skin")).toBe(count(fields, "EntryList.Name"))
    expect(getAll(fields, "EntryList.Skin")).toEqual(["alice_01", "", ""])
    // And so it is a payload postForm will actually agree to send.
    expect(checkEntryListShape(fields)).toEqual([])
  })

  it("omits buttons and file inputs", () => {
    const names = form().fields.map((f) => f.name)
    expect(names).not.toContain("submitButton")
    expect(names).not.toContain("championshipFile")
  })

  it("reads textarea content", () => {
    expect(getOne(form().fields, "Description")).toBe("A description")
  })

  it("takes only selected options from a multiple select", () => {
    expect(getAll(form().fields, "Cars")).toEqual(["rss_formula_hybrid_2021"])
  })

  it("falls back to the first option when a single select has no selection", () => {
    // ACSM renders EntryList.FixedSetup with an unselected placeholder.
    expect(getAll(form().fields, "EntryList.FixedSetup")).toEqual(["", "", ""])
  })

  it("resolves a relative action against the page URL", () => {
    const f = parseForm(fakeEventForm({ entrants: threeEntrants }), {
      pageUrl: "https://acsm.example/championship/abc/event/e1/edit",
    })
    expect(f.action).toBe("https://acsm.example/championship/abc/event/submit")
  })

  it("throws rather than guessing when there is no form", () => {
    expect(() => parseForm("<html><body>nothing</body></html>")).toThrow(FormParseError)
  })
})

describe("EntryList.EntrantID", () => {
  it("blocks the write when a form doesn't render it", () => {
    // Omit the key and ACSM's else branch sets PitBox to the list index,
    // renumbering every entrant (docs/acsm-write-path.md §2). Nothing counts
    // wrong in that payload — nine arrays of three, all agreeing — so arity
    // alone sees a clean form and the write goes out.
    const f = parseForm(fakeEventForm({ entrants: threeEntrants, renderEntrantId: false }))
    expect(count(f.fields, "EntryList.EntrantID")).toBe(0)
    expect(checkEntryListShape(f.fields)).toEqual([
      { key: "EntryList.EntrantID", count: 0, expected: 3 },
    ])
  })

  it("carries the pit box when it is rendered", () => {
    const f = parseForm(
      fakeEventForm({
        entrants: [
          entrant("alice", { pitBox: 3 }),
          entrant("bob", { pitBox: 16 }),
          entrant("carol", { pitBox: 27 }),
        ],
        renderEntrantId: true,
      }),
    )
    expect(getAll(f.fields, "EntryList.EntrantID")).toEqual(["3", "16", "27"])
  })
})

describe("entry list shape checking", () => {
  it("passes a well-formed form", () => {
    const f = parseForm(fakeEventForm({ entrants: threeEntrants, renderEntrantId: true }))
    expect(checkEntryListShape(f.fields)).toEqual([])
  })

  /**
   * These were called unpaired because a browser drops the unchecked ones,
   * leaving one value for three entrants — which ACSM then applies to the
   * wrong entrant (docs/acsm-write-path.md §4). That is true of a *plain*
   * browser and false of this one: ACSM's submit handler gives every checkbox
   * an explicit 0 or 1 first, so a real browser sends all three, correctly
   * paired, and the feature works.
   *
   * champctl now produces the same three values. It still strips them before
   * POST, which is unchanged behaviour and still safe — absent reads as false
   * for everyone. Sending them faithfully would preserve a genuinely ticked
   * one, and is worth doing once someone has measured it against a live
   * manager rather than inferring it from the handler.
   */
  it("pairs the per-entrant checkboxes once ACSM's 1/0 rewrite is accounted for", () => {
    const f = parseForm(
      fakeEventForm({
        entrants: [
          entrant("alice"),
          entrant("bob", { overwriteAllEvents: true }),
          entrant("carol"),
        ],
      }),
    )
    expect(count(f.fields, "EntryList.OverwriteAllEvents")).toBe(3)
    expect(getAll(f.fields, "EntryList.OverwriteAllEvents")).toEqual(["0", "1", "0"])
    expect(checkEntryListShape(f.fields)).toEqual([])
  })

  it("catches a dropped value, which would scramble the entry list", () => {
    const f = parseForm(fakeEventForm({ entrants: threeEntrants }))
    const fields = f.fields.filter(
      (x, i) =>
        !(
          x.name === "EntryList.GUID" &&
          i === f.fields.findIndex((y) => y.name === "EntryList.GUID")
        ),
    )
    const problems = checkEntryListShape(fields)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({ key: "EntryList.GUID", count: 2, expected: 3 })
  })

  it("says nothing about a form with no entry list", () => {
    expect(checkEntryListShape([{ name: "Track", value: "suzuka" }])).toEqual([])
  })

  it("catches a key dropped entirely, not just one shortened", () => {
    // Every remaining array still agrees at three, so there is nothing for a
    // count to disagree with. ACSM indexes EntryList.Name unguarded, so this
    // payload is an index-out-of-range panic in the manager rather than a
    // validation message (docs/acsm-write-path.md §1).
    const fields = parseForm(fakeEventForm({ entrants: threeEntrants })).fields.filter(
      (f) => f.name !== "EntryList.Name",
    )
    expect(checkEntryListShape(fields)).toEqual([{ key: "EntryList.Name", count: 0, expected: 3 }])
  })

  it("doesn't demand an entry list from a form that has none", () => {
    // The required-key rule only applies once a payload carries entrants;
    // otherwise every non-entrant form on the manager becomes unwritable.
    const fields = parseForm(fakeEventForm({ entrants: [] })).fields
    expect(fields.some((f) => f.name.startsWith("EntryList."))).toBe(false)
    expect(checkEntryListShape(fields)).toEqual([])
  })

  it("ignores EntryList.NumEntrants, a form-level count", () => {
    // 1.7.9's event form renders this once alongside 24-long arrays. Treating
    // it as a truncated array would make postForm refuse every real payload.
    const fields = parseForm(fakeEventForm({ entrants: threeEntrants })).fields
    fields.push({ name: "EntryList.NumEntrants", value: "3" })
    expect(checkEntryListShape(fields)).toEqual([])
  })

  it("flags an unrecognised EntryList field rather than assuming it's a counter", () => {
    // Fails closed. If ACSM adds another form-level field this blocks writes
    // until someone looks at it and adds it to NON_ARRAY_ENTRY_LIST_FIELDS —
    // which costs a diagnosis, where guessing wrong costs an entry list.
    const fields = parseForm(fakeEventForm({ entrants: threeEntrants })).fields
    fields.push({ name: "EntryList.SomeFutureCounter", value: "3" })
    expect(checkEntryListShape(fields)).toEqual([
      { key: "EntryList.SomeFutureCounter", count: 1, expected: 3 },
    ])
  })

  it("catches a two-entrant payload missing one value", () => {
    // The case an earlier "ignore anything appearing once" rule let through:
    // drop one of two GUIDs and the count falls to 1, which looked like a
    // form-level field.
    const fields = parseForm(fakeEventForm({ entrants: [entrant("a"), entrant("b")] })).fields
    const i = fields.findIndex((f) => f.name === "EntryList.GUID")
    expect(i).toBeGreaterThanOrEqual(0)
    fields.splice(i, 1)
    expect(checkEntryListShape(fields)).toEqual([{ key: "EntryList.GUID", count: 1, expected: 2 }])
  })

  it("still catches a genuinely truncated array", () => {
    const fields = parseForm(fakeEventForm({ entrants: threeEntrants })).fields
    const i = fields.findIndex((f) => f.name === "EntryList.GUID")
    fields.splice(i, 1)
    expect(checkEntryListShape(fields)).toHaveLength(1)
  })
})

describe("mutating fields", () => {
  const fields = (): FormField[] => parseForm(fakeEventForm({ entrants: threeEntrants })).fields

  it("replaces a single-valued key in place", () => {
    const f = fields()
    const before = f.findIndex((x) => x.name === "Sessions.Race.Laps")
    setOne(f, "Sessions.Race.Laps", "22")
    expect(f.findIndex((x) => x.name === "Sessions.Race.Laps")).toBe(before)
    expect(getOne(f, "Sessions.Race.Laps")).toBe("22")
  })

  it("appends a key that isn't there yet", () => {
    const f = fields()
    setOne(f, "RaceExtraLap", "on")
    expect(getOne(f, "RaceExtraLap")).toBe("on")
  })

  it("refuses to blind-set a repeated key", () => {
    // Setting one of three EntryList.Name values without saying which is how
    // an entry list gets scrambled.
    expect(() => setOne(fields(), "EntryList.Name", "mallory")).toThrow(/positional array/)
  })

  it("sets the nth value of a repeated key, preserving position", () => {
    const f = fields()
    setAt(f, "EntryList.Name", 1, "roberta")
    expect(getAll(f, "EntryList.Name")).toEqual(["alice", "roberta", "carol"])
  })

  it("refuses an index past the end", () => {
    expect(() => setAt(fields(), "EntryList.Name", 7, "x")).toThrow(/only 3 values/)
  })

  it("removes every occurrence", () => {
    const f = fields()
    removeAll(f, "EntryList.Name")
    expect(count(f, "EntryList.Name")).toBe(0)
  })
})

describe("encoding", () => {
  it("preserves repetition and order in the body", () => {
    const body = toBody([
      { name: "EntryList.Name", value: "alice" },
      { name: "EntryList.Name", value: "bob" },
      { name: "Track", value: "suzuka" },
    ])
    expect(body.toString()).toBe("EntryList.Name=alice&EntryList.Name=bob&Track=suzuka")
    expect(body.getAll("EntryList.Name")).toEqual(["alice", "bob"])
  })

  it("summarises a form as a shape", () => {
    const s = shape(parseForm(fakeEventForm({ entrants: threeEntrants })).fields)
    expect(s["EntryList.Name"]).toBe(3)
    expect(s["Track"]).toBe(1)
  })
})

describe("finding the right form on a page", () => {
  it("skips the navbar search form that every ACSM page carries", () => {
    // Taking the first form is how the import page came back reporting no
    // file field: the navbar search form is first in the document.
    const html = fakeImportPage("file", "championshipFile")
    expect(parseForm(html).action).toBe("/cars")

    const form = findFormByAction(html, "/championship/import")
    expect(form?.action).toBe("/championship/import")
    expect(form?.enctype).toBe("multipart/form-data")
  })

  it("returns every form in document order", () => {
    expect(parseForms(fakeImportPage("textarea")).map((f) => f.action)).toEqual([
      "/cars",
      "/championship/import",
    ])
  })

  it("is undefined when nothing matches, rather than guessing", () => {
    expect(findFormByAction(fakeImportPage("file"), "/nope")).toBeUndefined()
  })
})

describe("import page shapes", () => {
  it("exposes a file input's name without submitting it", () => {
    const form = findFormByAction(
      fakeImportPage("file", "championshipFile"),
      "/championship/import",
    )!
    expect(form.fileFields).toEqual(["championshipFile"])
    expect(form.textAreaFields).toEqual([])
    // A file has no value to echo back, so it isn't a submittable field.
    expect(form.fields.map((f) => f.name)).not.toContain("championshipFile")
  })

  it("exposes a textarea as both a field and a textarea", () => {
    // 1.7.9's import is a textarea read with r.FormValue("import").
    const form = findFormByAction(fakeImportPage("textarea", "import"), "/championship/import")!
    expect(form.textAreaFields).toEqual(["import"])
    expect(form.fileFields).toEqual([])
    expect(getOne(form.fields, "import")).toBe("")
  })
})
