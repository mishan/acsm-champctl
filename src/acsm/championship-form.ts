/**
 * The championship edit form — the one champctl writes a livery through.
 *
 * A different form from the event one, and the only place a change to an
 * entrant reaches every round. `ChampionshipEvent.CombineEntryLists` builds the
 * list ACSM actually races from `championship.AllEntrants()`, so the class
 * entry list is the source and the per-event lists are overrides on top of it.
 * champctl writes the source and leaves the overrides alone.
 *
 * Three things about this form are not what a naive read of the HTML says, and
 * each of them is a way to silently destroy an entry list.
 *
 * **1. Two of the rendered entrant rows are not entrants.** `manager.js` copies
 * `#entrantTemplate` for the "Add Entrant(s)" button and then removes it from
 * the DOM:
 *
 *     let $tmpl = this.$parent.find("#entrantTemplate");
 *     if (!$entrantTemplate && $tmpl.length > 0) { $entrantTemplate = $tmpl.prop("id", "").clone(true, true); }
 *     $tmpl.remove();
 *
 * so a browser submits fewer rows than the server rendered — measured on
 * BATL's 2.4.15, 32 rendered for 29 entrants. champctl runs no JavaScript, and
 * `EntryList.*` keys are parallel positional arrays, so keeping those rows
 * shifts every entrant and pushes the last ones past `start+length`, where
 * ACSM simply never reads them. This module does what the page does: removes
 * them before parsing.
 *
 * **2. Row 0 is the spectator car, not a driver.** `HandleCreateChampionship`
 * on premium reads one row for `championship.SpectatorCar` before it reads any
 * class, then walks each class for its own `EntryList.NumEntrants` rows.
 *
 * **3. `EntryList.EntrantID` is not rendered here at all**, unlike the event
 * form. ACSM's template excludes it when `$.IsChampionship`, and
 * `BuildEntryList` then falls to `e.PitBox = i`. That is what the ACSM UI's own
 * Save does, so champctl matches it rather than inventing values — see
 * `CHAMPIONSHIP_REQUIRED_ENTRY_LIST_FIELDS`.
 *
 * Measurements behind all of this are in docs/acsm-champ-form.md.
 */

import * as cheerio from "cheerio"

import {
  type FormField,
  REQUIRED_ENTRY_LIST_FIELDS,
  count,
  findFormByAction,
  getAll,
  removeAll,
  setAt,
} from "./form.js"
import { CHAMPIONSHIP_SUBMIT_PATH } from "./paths.js"

export class ChampionshipFormError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ChampionshipFormError"
  }
}

/** ACSM's id for the row its "Add Entrant(s)" button clones. */
export const ENTRANT_TEMPLATE_ID = "entrantTemplate"

/**
 * Rendered on the spectator rows and never read.
 *
 * `BuildEntryList` has the line that would read it commented out:
 *
 *     // Despite having the option for SpectatorMode, the server does not
 *     // support it, and panics if set to 1
 *     // SpectatorMode: formValueAsInt(r.Form["EntryList.Spectator"][i]),
 *
 * It is stripped rather than echoed because it is the wrong length — two
 * occurrences against thirty rows — and `checkEntryListShape` is right to
 * refuse that. Sending nothing is exactly as meaningful as sending it.
 */
export const RENDERED_BUT_UNREAD_ENTRY_LIST_FIELDS = ["EntryList.Spectator"] as const

/**
 * What a POST to this form must carry, which is the event form's list minus
 * `EntryList.EntrantID`.
 *
 * Not a relaxation of the rule in `form.ts` but the same rule applied to a form
 * that genuinely does not render the field. Omitting it means ACSM assigns
 * `PitBox = i`, and that is what an admin clicking Save in the ACSM UI does
 * too, because a browser has nothing to send either.
 *
 * The alternative — sending each entrant's stored `PitBox` — was considered and
 * rejected. It preserves pit boxes, and it hands `AddInPitBox` the chance to
 * put two entrants in one box, where it overwrites and one driver disappears
 * from the championship. BATL neither assigns nor promises pit boxes
 * (docs/acsm-2.4.15.md §5), so the safe option costs nothing.
 */
export const CHAMPIONSHIP_REQUIRED_ENTRY_LIST_FIELDS = REQUIRED_ENTRY_LIST_FIELDS.filter(
  (f) => f !== "EntryList.EntrantID",
)

/**
 * Removes the clone-me template rows, exactly as `manager.js` does on load.
 *
 * By id rather than by looking hidden: on 2.4.15 the class template row is not
 * hidden at all, so a styling heuristic finds nothing and every entrant shifts
 * by one. Duplicate ids are not valid HTML and ACSM renders one per class block
 * plus one for the spectator, so this deliberately matches all of them.
 */
export function stripEntrantTemplates(html: string): { html: string; removed: number } {
  const $ = cheerio.load(html)
  const templates = $(`#${ENTRANT_TEMPLATE_ID}`)
  const removed = templates.length
  templates.remove()
  return { html: $.html(), removed }
}

export interface ChampionshipForm {
  /** Fields as a browser would submit them: templates gone, unread keys gone. */
  fields: FormField[]
  action: string
  /** How many `#entrantTemplate` rows were dropped. Expect one per class, plus
   *  one for the spectator block on premium. */
  droppedTemplateRows: number
  /** `EntryList.NumEntrants`, one per class, in document order. */
  entrantsPerClass: number[]
  /** True when a spectator row precedes the classes — premium only. */
  hasSpectatorRow: boolean
  /** Total entrant rows in the payload, spectator included. */
  rows: number
}

/**
 * Parses the championship form and refuses anything it cannot account for.
 *
 * The load-bearing part is the arithmetic at the end. Every other check here
 * looks for a specific known problem; that one catches the unknown ones,
 * because a build that renders a row champctl doesn't understand shows up as a
 * count that doesn't add up rather than as a driver getting someone else's car.
 */
export function findChampionshipForm(html: string, pageUrl: string): ChampionshipForm {
  const stripped = stripEntrantTemplates(html)
  const form = findFormByAction(stripped.html, CHAMPIONSHIP_SUBMIT_PATH, { pageUrl })
  if (!form) {
    throw new ChampionshipFormError(
      `No form posting to ${CHAMPIONSHIP_SUBMIT_PATH} on the championship edit page. On 2.4.x ` +
        `every page redirects to /intro/checks until the first-run wizard is finished, and this ` +
        `is what that looks like. Otherwise, check this account may edit championships.`,
    )
  }

  const fields = [...form.fields]
  for (const key of RENDERED_BUT_UNREAD_ENTRY_LIST_FIELDS) removeAll(fields, key)

  const entrantsPerClass = getAll(fields, "EntryList.NumEntrants").map((v) =>
    Number.parseInt(v, 10),
  )
  if (entrantsPerClass.length === 0 || entrantsPerClass.some((n) => !Number.isFinite(n) || n < 0)) {
    throw new ChampionshipFormError(
      `The championship form has no usable EntryList.NumEntrants. That field is how ACSM decides ` +
        `which rows belong to which class, so champctl cannot place an entrant without it.`,
    )
  }

  const rows = count(fields, "EntryList.Name")
  const classTotal = entrantsPerClass.reduce((a, b) => a + b, 0)

  // Premium reads one row for the spectator car before any class; the OSS build
  // has no spectator car and reads none. Deriving it from the arithmetic rather
  // than from a version string means a build that changes this is caught here
  // instead of by an entry list arriving one place out.
  let hasSpectatorRow: boolean
  if (rows === classTotal + 1) hasSpectatorRow = true
  else if (rows === classTotal) hasSpectatorRow = false
  else {
    throw new ChampionshipFormError(
      `Refusing to write the championship form: it has ${rows} entrant rows, and the classes ` +
        `account for ${classTotal} (${entrantsPerClass.join(" + ")}) — with or without a leading ` +
        `spectator-car row, that doesn't add up. ${stripped.removed} #entrantTemplate ${
          stripped.removed === 1 ? "row was" : "rows were"
        } already dropped. ACSM reads these as parallel positional arrays, so writing a payload ` +
        `champctl can't account for would give entrants each other's cars. Run ` +
        `\`npm run recon:champ-form\` against this manager and compare with docs/acsm-champ-form.md.`,
    )
  }

  return {
    fields,
    action: form.action,
    droppedTemplateRows: stripped.removed,
    entrantsPerClass,
    hasSpectatorRow,
    rows,
  }
}

/**
 * The row index of the nth entrant of the nth class.
 *
 * Both indices are zero-based and in the order the export lists them, which is
 * `CAR_0`, `CAR_1`, ... — the same order `ChampionshipClass.Entrants.AsSlice`
 * renders and `slots()` reads.
 */
export function entrantRowIndex(
  form: ChampionshipForm,
  classIndex: number,
  entrantIndex: number,
): number {
  const size = form.entrantsPerClass[classIndex]
  if (size === undefined) {
    throw new ChampionshipFormError(
      `The championship form has ${form.entrantsPerClass.length} classes; there is no class ${classIndex}.`,
    )
  }
  if (entrantIndex < 0 || entrantIndex >= size) {
    throw new ChampionshipFormError(
      `Class ${classIndex} has ${size} entrants on the form; there is no entrant ${entrantIndex}. ` +
        `The entry list changed between reading the export and reading the form.`,
    )
  }
  const before = form.entrantsPerClass.slice(0, classIndex).reduce((a, b) => a + b, 0)
  return (form.hasSpectatorRow ? 1 : 0) + before + entrantIndex
}

/**
 * Sets one entrant's skin in place, leaving every other value as rendered.
 *
 * `setAt` rather than `setOne`: these are positional arrays, and replacing "the"
 * value of a repeated key is how an entry list gets scrambled.
 */
export function setEntrantSkin(fields: FormField[], rowIndex: number, skin: string): void {
  setAt(fields, "EntryList.Skin", rowIndex, skin)
}

/** The skins currently rendered, in row order, for a before/after preview. */
export function currentSkins(form: ChampionshipForm): string[] {
  return getAll(form.fields, "EntryList.Skin")
}

/** The entrant names currently rendered, in row order. */
export function currentNames(form: ChampionshipForm): string[] {
  return getAll(form.fields, "EntryList.Name")
}
