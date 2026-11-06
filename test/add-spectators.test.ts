import { describe, expect, it } from "vitest"

import { addSpectatorCars } from "../src/acsm/add-spectators.js"
import type { ChampionshipForm } from "../src/acsm/championship-form.js"
import { type FormField, getAll } from "../src/acsm/form.js"

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

/**
 * The same row as BATL's manager renders it, with the Custom Shaders Patch car
 * flags its build puts before each row's InternalUUID (measured 2026-11-06).
 * The first production add left them out, and the arity check refused it.
 */
const FLAGS = [
  "BlockKeyboard",
  "BlockJoystick",
  "BlockSteeringWheel",
  "ForceHeadlights",
  "AllowColorChange",
  "AllowTeleporting",
  "AllowImmediateRepair",
  "AllowImmediateRefuel",
]
const batlRow = (name: string, guid: string, uuid: string, flag = "0"): FormField[] => {
  const row = spectatorRow(name, guid, uuid)
  row.splice(2, 0, ...FLAGS.map((f) => ({ name: `EntryList.CarFlags.${f}`, value: flag })))
  return row
}
const batlPage = (): FormField[] => [
  { name: "Championship.SpectatorCar.Enabled", value: "1" },
  ...batlRow("Stream", "90000000000000001", "7b8ec565-c77b-4907-bae1-9f4f703ced3b", "1"),
  { name: "numEntrantsToAdd", value: "1" },
  { name: "ClassName", value: "GT" },
  { name: "EntrantAutoFill", value: "" },
  { name: "EntryList.OverwriteAllEvents", value: "0" },
  ...FLAGS.map((f) => ({ name: `EntryList.CarFlags.${f}`, value: "0" })),
  { name: "EntryList.InternalUUID", value: "00000000-0000-0000-0000-000000000000" },
  { name: "EntryList.Name", value: "Ann" },
]

describe("addSpectatorCars", () => {
  it("copies every field of the row, the car flags a build adds included", () => {
    const fields = batlPage()
    addSpectatorCars([GRIDMOM]).apply(fields, form(fields))
    const at = fields.findIndex((f) => f.name === "numEntrantsToAdd")
    const added = fields.slice(at - 20, at)
    expect(added.map((f) => f.name)).toEqual(batlRow("x", "x", "x").map((f) => f.name))
    // Copied from the car the row was copied from, as ACSM's own Add does.
    expect(
      added.filter((f) => f.name.startsWith("EntryList.CarFlags.")).map((f) => f.value),
    ).toEqual(FLAGS.map(() => "1"))
    expect(added.find((f) => f.name === "EntryList.Name")?.value).toBe("Recorder")
  })

  it("finds a second spectator car's row without taking in the first one's tail", () => {
    const fields = [
      { name: "Championship.SpectatorCar.Enabled", value: "1" },
      ...batlRow("Stream", "90000000000000001", "u1"),
      ...batlRow("Other", "90000000000000003", "u2"),
      { name: "numEntrantsToAdd", value: "1" },
    ]
    addSpectatorCars([GRIDMOM]).apply(fields, form(fields, 2))
    const names = fields.map((f) => f.name)
    expect(names.slice(-21, -1)).toEqual(batlRow("x", "x", "x").map((f) => f.name))
    expect(names.filter((n) => n === "EntryList.FixedSetup")).toHaveLength(3)
  })

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

  it("stops at the next row's leading fields when a class row follows directly", () => {
    // The stream car's flags are on, the driver's off.
    const fields = batlPage().filter((f) => f.name !== "numEntrantsToAdd" && f.name !== "ClassName")
    addSpectatorCars([GRIDMOM]).apply(fields, form(fields))
    // ACSM reads each key positionally: second value, the new car's; third, the driver's.
    expect(getAll(fields, "EntryList.CarFlags.BlockKeyboard")).toEqual(["1", "1", "0"])
    expect(getAll(fields, "EntryList.Name")).toEqual(["Stream", "Recorder", "Ann"])
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

  it("copies OverwriteAllEvents whether a build renders it before InternalUUID or after", () => {
    const fields = page()
    // From before the stream car's InternalUUID to just after it.
    const [oae] = fields.splice(2, 1)
    fields.splice(3, 0, oae!)
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
