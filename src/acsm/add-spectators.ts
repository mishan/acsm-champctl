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

/**
 * Every field a spectator row renders, and what a new one carries in it, given
 * the value in the row it's copied from.
 */
function newRowValue(name: string, car: LeagueSpectatorCar, copied: string): string | undefined {
  // The Custom Shaders Patch car flags BATL's build renders on every row:
  // ACSM's own Add copies a car's settings from the last spectator car.
  if (name.startsWith("EntryList.CarFlags.")) return copied
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
          const value = newRowValue(f.name, car, f.value)
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
 * Where the last spectator row's fields are: back from its InternalUUID
 * through whatever a build renders before it (EntrantAutoFill,
 * OverwriteAllEvents, BATL's car flags) to the previous row's last field, and
 * forward to its FixedSetup, which ends every row on every build measured.
 * Without one before the next non-row field, the row isn't one champctl knows.
 */
function lastSpectatorRow(
  fields: readonly FormField[],
  spectatorRows: number,
): { start: number; end: number } {
  const isRowField = (name: string) => name.startsWith("EntryList.") || name === "EntrantAutoFill"
  let seen = -1
  const at = fields.findIndex(
    (f) => f.name === "EntryList.InternalUUID" && ++seen === spectatorRows - 1,
  )
  const after = new Set<string>(["EntryList.InternalUUID"])
  let end = at + 1
  for (; end < fields.length && fields[end - 1]!.name !== "EntryList.FixedSetup"; end++) {
    const name = fields[end]!.name
    if (!isRowField(name) || after.has(name)) {
      throw new ChampionshipFormError(
        `The spectator car's row on the form doesn't end in EntryList.FixedSetup, so champctl ` +
          `can't tell where it ends. Nothing was written.`,
      )
    }
    after.add(name)
  }
  const before = new Set<string>()
  let start = at
  for (; start > 0; start--) {
    const name = fields[start - 1]!.name
    if (!isRowField(name) || after.has(name) || before.has(name)) break
    before.add(name)
  }
  return { start, end }
}
