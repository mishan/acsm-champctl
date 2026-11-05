/**
 * Adding spectator cars to a championship through its edit form.
 *
 * The row is built the way ACSM's own "Add Spectator(s)" button builds it: a
 * copy of the last spectator car's row, inserted right after it, with an empty
 * `InternalUUID` for ACSM to fill (measured on 2.4.15, docs/acsm-champ-form.md
 * §4.7). ACSM reads the first rows as spectator cars by counting the
 * `EntryList.Spectator` markers, so the new row carries its own.
 */

import type { LeagueSpectatorCar } from "../profile/types.js"
import { ChampionshipFormError, MAX_SPECTATOR_ROWS, SPECTATOR_MARKER } from "./championship-form.js"
import type { ChampionshipEdit } from "./championship-save.js"
import { type FormField, getAll } from "./form.js"

/** Every field a spectator row renders, and what a new one carries in it. */
function newRowValue(name: string, car: LeagueSpectatorCar): string | undefined {
  switch (name) {
    case "EntrantAutoFill":
    case "EntryList.InternalUUID":
    case "EntryList.Team":
    case "EntryList.FixedSetup":
      return ""
    case "EntryList.OverwriteAllEvents":
    case "EntryList.Ballast":
    case "EntryList.Restrictor":
      return "0"
    case SPECTATOR_MARKER:
      return "true"
    case "EntryList.Name":
      return car.name
    case "EntryList.GUID":
      return car.guid
    case "EntryList.Car":
      return car.model
    case "EntryList.Skin":
      return car.skin ?? ""
    default:
      return undefined
  }
}

/** Fields that may come before a row's InternalUUID in it. */
const LEADING = new Set(["EntrantAutoFill", "EntryList.OverwriteAllEvents"])

export function addSpectatorCars(cars: readonly LeagueSpectatorCar[]): ChampionshipEdit {
  return {
    what: "the spectator cars it added",
    check(form) {
      // Copying needs a row to copy, and a championship with none renders the
      // spectator section differently; that has not been measured.
      if (form.spectatorRows === 0) {
        throw new ChampionshipFormError(
          `This championship has no spectator cars, and champctl only adds one beside another. ` +
            `Add the first in ACSM.`,
        )
      }
      const total = form.spectatorRows + cars.length
      if (total > MAX_SPECTATOR_ROWS) {
        throw new ChampionshipFormError(
          `Adding ${cars.length} would make ${total} spectator cars, and champctl has measured ` +
            `at most ${MAX_SPECTATOR_ROWS}.`,
        )
      }
      const present = getAll(form.fields, "EntryList.GUID").slice(0, form.spectatorRows)
      // The read-back tells spectator cars apart by GUID.
      if (new Set(present).size !== present.length) {
        throw new ChampionshipFormError(
          `Two of this championship's spectator cars share a GUID, so champctl couldn't check ` +
            `what adding one did. Give each its own in ACSM first.`,
        )
      }
      for (const car of cars) {
        if (present.includes(car.guid)) {
          throw new ChampionshipFormError(
            `${car.name} (${car.guid}) is already a spectator car here.`,
          )
        }
      }
    },
    apply(fields, form) {
      const span = lastSpectatorRow(fields, form.spectatorRows)
      const rows: FormField[] = cars.flatMap((car) =>
        fields.slice(span.start, span.end).map((f) => {
          const value = newRowValue(f.name, car)
          if (value === undefined) {
            throw new ChampionshipFormError(
              `The spectator car's row on the form has ${f.name}, which champctl doesn't know how ` +
                `to fill for a new one. Nothing was written.`,
            )
          }
          return { name: f.name, value }
        }),
      )
      fields.splice(span.end, 0, ...rows)
    },
    addsSpectators: cars.map((c) => ({
      Name: c.name,
      GUID: c.guid,
      Model: c.model,
      Skin: c.skin ?? "",
    })),
  }
}

/**
 * Where the last spectator row's fields are: its InternalUUID, the leading
 * fields just before it, and the row fields after it up to a field that isn't
 * a row's or one the row already has, which is where the next row starts.
 */
function lastSpectatorRow(
  fields: readonly FormField[],
  spectatorRows: number,
): { start: number; end: number } {
  let seen = -1
  const at = fields.findIndex(
    (f) => f.name === "EntryList.InternalUUID" && ++seen === spectatorRows - 1,
  )
  const names = new Set<string>(["EntryList.InternalUUID"])
  let start = at
  while (start > 0 && LEADING.has(fields[start - 1]!.name) && !names.has(fields[start - 1]!.name)) {
    names.add(fields[--start]!.name)
  }
  let end = at + 1
  for (; end < fields.length; end++) {
    const name = fields[end]!.name
    if (!(name.startsWith("EntryList.") || LEADING.has(name)) || names.has(name)) break
    names.add(name)
  }
  return { start, end }
}
