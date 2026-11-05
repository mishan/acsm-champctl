import { describe, expect, it } from "vitest"

import { addSpectatorCars } from "../src/acsm/add-spectators.js"
import type { ChampionshipForm } from "../src/acsm/championship-form.js"
import type { FormField } from "../src/acsm/form.js"

const GRIDMOM = { name: "Recorder", model: "ford_transit", guid: "90000000000000002", skin: "tv" }

/**
 * A spectator row as 2.4.15 posts it, in its order: measured from the body
 * ACSM's own "Add Spectator(s)" button sent (docs/acsm-champ-form.md §4.7).
 */
const spectatorRow = (name: string, guid: string, uuid: string): FormField[] =>
  [
    ["EntrantAutoFill", ""],
    ["EntryList.OverwriteAllEvents", "0"],
    ["EntryList.InternalUUID", uuid],
    ["EntryList.Spectator", "true"],
    ["EntryList.Name", name],
    ["EntryList.Team", "BATL"],
    ["EntryList.GUID", guid],
    ["EntryList.Car", "ford_transit"],
    ["EntryList.Skin", "35_BATL"],
    ["EntryList.Ballast", "5"],
    ["EntryList.Restrictor", "0"],
    ["EntryList.FixedSetup", ""],
  ].map(([name, value]) => ({ name: name!, value: value! }))

const page = (): FormField[] => [
  { name: "Championship.SpectatorCar.Enabled", value: "1" },
  ...spectatorRow("Stream", "90000000000000001", "c3bf0e07-673e-45e9-8d52-059cd69252d4"),
  { name: "numEntrantsToAdd", value: "1" },
  { name: "ClassName", value: "GT" },
  { name: "EntrantAutoFill", value: "" },
  { name: "EntryList.OverwriteAllEvents", value: "0" },
  { name: "EntryList.InternalUUID", value: "00000000-0000-0000-0000-000000000000" },
  { name: "EntryList.Name", value: "Ann" },
]

const form = (fields: FormField[], spectatorRows = 1) =>
  ({ fields, spectatorRows, rows: spectatorRows + 1, entrantsPerClass: [1] }) as ChampionshipForm

describe("addSpectatorCars", () => {
  it("inserts the row ACSM's own Add button does, right after the last spectator car", () => {
    const fields = page()
    const edit = addSpectatorCars([GRIDMOM])
    edit.apply(fields, form(fields))
    const at = fields.findIndex((f) => f.name === "numEntrantsToAdd")
    expect(fields.slice(at - 12, at)).toEqual([
      { name: "EntrantAutoFill", value: "" },
      { name: "EntryList.OverwriteAllEvents", value: "0" },
      { name: "EntryList.InternalUUID", value: "" },
      { name: "EntryList.Spectator", value: "true" },
      { name: "EntryList.Name", value: "Recorder" },
      { name: "EntryList.Team", value: "" },
      { name: "EntryList.GUID", value: "90000000000000002" },
      { name: "EntryList.Car", value: "ford_transit" },
      { name: "EntryList.Skin", value: "tv" },
      { name: "EntryList.Ballast", value: "0" },
      { name: "EntryList.Restrictor", value: "0" },
      { name: "EntryList.FixedSetup", value: "" },
    ])
    expect(fields.slice(1, 13)).toEqual(page().slice(1, 13))
  })

  it.each([
    ["no spectator car to copy", form(page(), 0), [GRIDMOM], /no spectator cars/],
    ["more than have been measured", form(page(), 3), [GRIDMOM], /4 spectator cars.*at most 3/],
    [
      "a car the form already has",
      form(page()),
      [{ ...GRIDMOM, guid: "90000000000000001" }],
      /already/,
    ],
  ])("refuses %s", (_, f, cars, message) => {
    expect(() => addSpectatorCars(cars).check?.(f)).toThrow(message)
  })

  it("refuses when the championship's own spectator cars share a GUID", () => {
    // The read-back matches spectator cars by GUID, so it couldn't tell a good
    // add from a bad one and would stop champctl writing after a good save.
    const f = form(
      [...spectatorRow("A", "", "u1"), ...spectatorRow("B", "", "u2")].map((x) => ({ ...x })),
      2,
    )
    expect(() => addSpectatorCars([GRIDMOM]).check?.(f)).toThrow(/share a GUID/)
  })

  it("copies OverwriteAllEvents wherever in the row a build renders it", () => {
    const fields = page()
    const [oae] = fields.splice(2, 1)
    fields.splice(12, 0, oae!)
    addSpectatorCars([GRIDMOM]).apply(fields, form(fields))
    expect(fields.filter((f) => f.name === "EntryList.OverwriteAllEvents")).toHaveLength(3)
  })

  it("refuses to copy a spectator row with a field it doesn't know", () => {
    const fields = page()
    fields.splice(5, 0, { name: "EntryList.TransferTeamPoints", value: "0" })
    expect(() => addSpectatorCars([GRIDMOM]).apply(fields, form(fields))).toThrow(
      /EntryList.TransferTeamPoints/,
    )
  })
})
