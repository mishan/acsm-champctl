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
  setOne,
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
 * The hidden input that marks the spectator car's row: `value="true"`, once.
 *
 * Older ACSM source never read it — the line in `BuildEntryList` was commented
 * out — so champctl stripped it as noise. BATL's September 2026 build reads it:
 * a livery push that left it out had ACSM take the spectator car as the first
 * class entrant, move every driver down a row and drop the last one off the
 * end. A browser sends it, so champctl sends it, exactly as rendered. It marks
 * one row rather than describing every row, so it is exempt from the arity
 * check and counted here instead.
 */
export const SPECTATOR_MARKER = "EntryList.Spectator"

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
 * ACSM's marker for the whole hidden class block its "Add another class" button
 * clones.
 *
 * A second, larger template than `#entrantTemplate` and easy to miss, because
 * it *contains* one. `new.html` renders it before the real classes:
 *
 *     <div id="class-template" style="display: none;">
 *         {{ template "championship-class" ... "Class" $.DefaultClass ... }}
 *     </div>
 *     {{ range $classIndex, $class := $f.Classes }} ... {{ end }}
 *
 * so it carries its own `ClassName`, its own `EntryList.NumEntrants` — zero,
 * since the default class has no entrants — and its own `#entrantTemplate` row.
 */
export const CLASS_TEMPLATE_ID = "class-template"

/**
 * The spectator car's clone-me row, which `initSpectatorCarTemplate` removes on
 * load exactly as `initEntrantTemplate` removes `#entrantTemplate`.
 *
 * New with BATL's September 2026 update: before it, the spectator template was
 * an `#entrantTemplate` like the class one, and was stripped as one. After it,
 * the blank row stayed in the payload ahead of the real spectator car — 32
 * rows for 30 entrants — and the first livery push on the new build was
 * refused by the row arithmetic below rather than written one row out.
 */
export const SPECTATOR_TEMPLATE_ID = "spectatorTemplate"

export interface StrippedTemplates {
  html: string
  /** `#class-template` blocks removed. */
  classTemplates: number
  /** `#entrantTemplate` rows removed, after the class templates went. */
  entrantTemplates: number
  /** `#spectatorTemplate` rows removed. */
  spectatorTemplates: number
  /** The hidden balance-of-performance row removed: 0 or 1. */
  bopTemplates: number
  /** True when the last `.class-bop` wasn't the hidden template ACSM expects. */
  unexpectedBop: boolean
}

/**
 * Removes both clone-me templates, in the order and by the markers `manager.js`
 * uses.
 *
 * `initClassSetup` removes the class one:
 *
 *     let $tmpl = $document.find("#class-template");
 *     championships.$classTemplate = $tmpl.clone();
 *     $tmpl.remove();
 *
 * and `RaceSetup` removes an `#entrantTemplate` per class block, and — since
 * BATL's September 2026 update — `initSpectatorCarTemplate` a
 * `#spectatorTemplate`. A browser therefore submits none of them, and champctl —
 * which runs no JavaScript — has to remove each by hand.
 *
 * **Missing the class one is not a cosmetic error.** Measured against a real
 * BATL championship: the form rendered 32 entrant rows, `ClassName` twice and
 * `EntryList.NumEntrants` as `0, 29`. Posting that has ACSM read row 0 as the
 * spectator car, build an empty first class, and then take the *next* 29 rows
 * as the real class — which begins one row early, so every driver inherits the
 * previous one's car and skin and the last is dropped off the end. It would
 * also have created a phantom empty class on every save.
 *
 * Class first, deliberately: removing the outer block takes the entrant
 * template inside it along too, and the count then says how many *real* class
 * blocks there were rather than how many templates existed.
 */
export function stripClonedTemplates(html: string): StrippedTemplates {
  const $ = cheerio.load(html)

  const classTemplates = $(`#${CLASS_TEMPLATE_ID}`)
  const classCount = classTemplates.length
  classTemplates.remove()

  const entrantTemplates = $(`#${ENTRANT_TEMPLATE_ID}`)
  const entrantCount = entrantTemplates.length
  entrantTemplates.remove()

  const spectatorTemplates = $(`#${SPECTATOR_TEMPLATE_ID}`)
  const spectatorCount = spectatorTemplates.length
  spectatorTemplates.remove()

  // `handleGlobalBoP` clones the *last* `.class-bop` on the page as the row it
  // stamps out per car, and removes it. That row is a hidden one outside any
  // class; posted, it adds a balance-of-performance entry for no car. Anything
  // else in last place is a layout champctl hasn't seen, and the caller refuses
  // it rather than removing a real row the way ACSM's own script would.
  const bops = $(".class-bop")
  const lastBop = bops.last()
  let bopCount = 0
  let unexpectedBop = false
  if (bops.length > 0) {
    if (lastBop.hasClass("d-none") && lastBop.closest(".class-bop-wrapper").length === 0) {
      lastBop.remove()
      bopCount = 1
    } else {
      unexpectedBop = true
    }
  }

  return {
    html: $.html(),
    classTemplates: classCount,
    entrantTemplates: entrantCount,
    spectatorTemplates: spectatorCount,
    bopTemplates: bopCount,
    unexpectedBop,
  }
}

export interface ChampionshipForm {
  /** Fields as a browser would submit them: templates gone, unread keys gone. */
  fields: FormField[]
  action: string
  /** `#class-template` blocks dropped. One on every build seen so far. */
  droppedClassTemplates: number
  /** `#entrantTemplate` rows dropped, once the class templates had gone. */
  droppedTemplateRows: number
  /** `EntryList.NumEntrants`, one per class, in document order. */
  entrantsPerClass: number[]
  /** True when a spectator row precedes the classes — premium only. */
  hasSpectatorRow: boolean
  /** Total entrant rows in the payload, spectator included. */
  rows: number
  /**
   * The championship description as the page holds it, for the editor to load:
   * `#ChampionshipInfoHolder`. The `ChampionshipInfo` textarea itself renders
   * empty and is filled by the page's script, so posting the form as parsed
   * erased the description. `fields` carries this in its place; a caller that
   * can read the stored value exactly should set that instead (see
   * `setDescription`), because this has been through an HTML parser.
   */
  description: string
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
  const stripped = stripClonedTemplates(html)
  const form = findFormByAction(stripped.html, CHAMPIONSHIP_SUBMIT_PATH, { pageUrl })
  if (!form) {
    throw new ChampionshipFormError(
      `No form posting to ${CHAMPIONSHIP_SUBMIT_PATH} on the championship edit page. On 2.4.x ` +
        `every page redirects to /intro/checks until the first-run wizard is finished, and this ` +
        `is what that looks like. Otherwise, check this account may edit championships.`,
    )
  }

  if (stripped.unexpectedBop) {
    throw new ChampionshipFormError(
      `Refusing to write the championship form: the last balance-of-performance row on the ` +
        `page isn't the hidden template ACSM's script removes. Posting it as parsed could add or ` +
        `drop a BoP entry. Run \`npm run recon:champ-form -- <championship-id>\` against this ` +
        `manager and compare with docs/acsm-champ-form.md §4.2.`,
    )
  }

  const fields = [...form.fields]
  const description = cheerio.load(stripped.html)("#ChampionshipInfoHolder").html()?.trim() ?? ""
  if (getAll(fields, "ChampionshipInfo").length > 1) {
    throw new ChampionshipFormError(
      "The championship form renders more than one ChampionshipInfo field, which champctl doesn't know how to fill.",
    )
  }
  if (description && !(getAll(fields, "ChampionshipInfo")[0] ?? "").trim()) {
    setOne(fields, "ChampionshipInfo", description)
  }

  const entrantsPerClass = getAll(fields, "EntryList.NumEntrants").map((v) =>
    Number.parseInt(v, 10),
  )
  if (entrantsPerClass.length === 0 || entrantsPerClass.some((n) => !Number.isFinite(n) || n < 0)) {
    throw new ChampionshipFormError(
      `The championship form has no usable EntryList.NumEntrants. That field is how ACSM decides ` +
        `which rows belong to which class, so champctl cannot place an entrant without it.`,
    )
  }

  // The pairing ACSM actually iterates, checked on its own.
  //
  // `HandleCreateChampionship` loops `for i := range r.Form["ClassName"]` and
  // reads `r.Form["EntryList.NumEntrants"][i]` inside it, so `ClassName` decides
  // how many classes get built and the shorter of the two arrays wins silently.
  // The arithmetic below cannot see that, because it only ever sums
  // `NumEntrants`: one `ClassName` against `NumEntrants` of 1 and 2, over a
  // spectator row and three entrants, adds up exactly (4 = 3 + 1) and still
  // builds a single class of one — dropping two drivers with no error anywhere.
  const classNames = count(fields, "ClassName")
  if (classNames !== entrantsPerClass.length) {
    throw new ChampionshipFormError(
      `Refusing to write the championship form: it renders ${classNames} ClassName ` +
        `${classNames === 1 ? "field" : "fields"} but ${entrantsPerClass.length} ` +
        `EntryList.NumEntrants (${entrantsPerClass.join(", ")}). ACSM builds one class per ` +
        `ClassName and takes the entrant count from the same position, so a payload where those ` +
        `two disagree drops whichever classes the shorter list doesn't reach — without an error, ` +
        `and after the save. champctl dropped ${stripped.classTemplates} #${CLASS_TEMPLATE_ID}, ` +
        `${stripped.entrantTemplates} #${ENTRANT_TEMPLATE_ID} and ` +
        `${stripped.spectatorTemplates} #${SPECTATOR_TEMPLATE_ID} already. Run ` +
        `\`npm run recon:champ-form -- <championship-id>\` against this manager — it only ` +
        `reads — and compare with docs/acsm-champ-form.md §4.2.`,
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
        `spectator-car row, that doesn't add up. champctl dropped ` +
        `${stripped.classTemplates} #${CLASS_TEMPLATE_ID}, ` +
        `${stripped.entrantTemplates} #${ENTRANT_TEMPLATE_ID} and ` +
        `${stripped.spectatorTemplates} #${SPECTATOR_TEMPLATE_ID} already, and found ` +
        `${count(fields, "ClassName")} ClassName ${count(fields, "ClassName") === 1 ? "field" : "fields"}. ` +
        `ACSM reads these as parallel positional arrays, so writing a payload champctl can't ` +
        `account for would give entrants each other's cars. Run \`npm run recon:champ-form -- ` +
        `<championship-id>\` against this manager — it only reads — and compare with ` +
        `docs/acsm-champ-form.md §4.2.`,
    )
  }

  const markers = getAll(fields, SPECTATOR_MARKER)
  const expectedMarkers = hasSpectatorRow ? 1 : 0
  if (markers.length !== expectedMarkers || markers.some((v) => v !== "true")) {
    throw new ChampionshipFormError(
      `Refusing to write the championship form: it carries ${SPECTATOR_MARKER} ` +
        `${markers.length === 0 ? "nowhere" : `as ${markers.map((v) => JSON.stringify(v)).join(", ")}`}, ` +
        `where the row count says ${expectedMarkers === 1 ? 'one row, marked "true"' : "none"}. ACSM reads that marker to tell the ` +
        `spectator car from the drivers, and getting it wrong moves every driver a row. Run ` +
        `\`npm run recon:champ-form -- <championship-id>\` against this manager and compare with ` +
        `docs/acsm-champ-form.md §4.2.`,
    )
  }

  return {
    fields,
    action: form.action,
    description,
    droppedClassTemplates: stripped.classTemplates,
    droppedTemplateRows: stripped.entrantTemplates,
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
 * The row holding this driver, found by their name.
 *
 * Preferred over `entrantRowIndex` for deciding where to write, and the
 * difference is which fact is doing the work. The arithmetic index is *derived*:
 * it assumes a leading spectator row, that class blocks are in export order, and
 * that nothing else on the page renders an entrant row. Every one of those had
 * to be learned by being wrong about it. The name is not derived — it is
 * rendered in the row champctl wants to edit, right next to the skin.
 *
 * `undefined` when the name is not there, and a refusal when it is there twice,
 * because the whole point is to not guess. NFC on both sides, matching
 * `src/liveries/pack.ts`: a decomposed "ä" from a macOS zip is the same name as
 * the precomposed one the manager holds.
 */
export function findEntrantRow(form: ChampionshipForm, driverName: string): number | undefined {
  const wanted = driverName.normalize("NFC").trim()
  if (!wanted) return undefined

  const names = currentNames(form)
  const found: number[] = []
  names.forEach((name, i) => {
    if (name.normalize("NFC").trim() === wanted) found.push(i)
  })

  if (found.length > 1) {
    throw new ChampionshipFormError(
      `The championship form has "${wanted}" in ${found.length} rows (${found.join(", ")}), so ` +
        `champctl can't tell which one to put the livery on. Fix the duplicate entrant in ACSM.`,
    )
  }
  return found[0]
}

/**
 * Sets one entrant's skin in place, leaving every other value as rendered.
 *
 * `setAt` rather than `setOne`: these are positional arrays, and replacing "the"
 * value of a repeated key is how an entry list gets scrambled.
 */
/**
 * Sets the description to send, from the stored value.
 *
 * `findChampionshipForm` fills it from the page's holder, which keeps the save
 * from erasing it but has been re-serialised by an HTML parser on the way. The
 * championship export carries the value ACSM stored, byte for byte.
 */
export function setDescription(fields: FormField[], info: string): void {
  setOne(fields, "ChampionshipInfo", info)
}

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
