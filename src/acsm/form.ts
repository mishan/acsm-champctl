/**
 * HTML form parsing, as an ordered multimap.
 *
 * ACSM parses `EntryList.*` keys as parallel arrays indexed by position — see
 * docs/acsm-write-path.md §1. A plain object loses both the repetition and the
 * order, and either loss silently corrupts an entry list. So the representation
 * here is an ordered list of pairs, and it stays that way all the way to the
 * request body.
 *
 * This deliberately reproduces what a *browser* would submit, because that is
 * the only payload shape ACSM is known to handle correctly.
 */

import * as cheerio from "cheerio"
import type { AnyNode } from "domhandler"

/** One submitted name/value pair, in document order. */
export interface FormField {
  name: string
  value: string
}

export interface ParsedForm {
  /** Resolved absolute action URL, or the page URL when the form has none. */
  action: string
  method: "GET" | "POST"
  enctype: string
  fields: FormField[]
  /**
   * Names of `<input type="file">` controls. Not in `fields` — a file has no
   * value to echo back — but callers need the name to build a multipart part.
   */
  fileFields: string[]
  /**
   * Names of `<textarea>` controls. Their current value *is* in `fields`;
   * this says which fields those were, which is how the import path tells a
   * paste-the-JSON form from an upload-a-file one.
   */
  textAreaFields: string[]
  /**
   * Names of `<input type="checkbox">` controls, checked or not. Every one of
   * them is in `fields` as "1" or "0" — see the checkbox branch in
   * `parseForm` for why they are not browser-standard here.
   */
  checkboxFields: string[]
}

export class FormParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FormParseError"
  }
}

export interface ParseFormOptions {
  /** CSS selector for the form. Defaults to the first form on the page. */
  selector?: string
  /** Page URL, used to resolve a relative action. */
  pageUrl?: string
}

/**
 * Extracts the fields a browser would submit for a form.
 *
 * Follows the HTML submission rules that matter here:
 *  - unselected radios are omitted
 *  - disabled controls are omitted; readonly ones are NOT (ACSM renders the
 *    championship entrant name, team and GUID readonly, and they must be sent)
 *  - a select with nothing marked selected submits its first option
 *  - buttons are omitted, since no button was "clicked"
 *  - unnamed controls are omitted
 *
 * Two deliberate departures from the browser, both because ACSM does not
 * actually consume a browser-standard payload. Each is the difference between
 * a working write and a destroyed event, and each was measured rather than
 * reasoned about:
 *
 *  - **Checkboxes** go out as "1" or "0", always, never "on" and never absent.
 *    ACSM's own JavaScript rewrites them that way on submit, so "1"/"0" is the
 *    only thing its Go side has ever been given. See the checkbox branch.
 *  - **A `<select>` with no options** submits an empty value, where a browser
 *    submits nothing. See the select branch.
 */
export function parseForm(html: string, options: ParseFormOptions = {}): ParsedForm {
  const $ = cheerio.load(html)
  const selector = options.selector ?? "form"
  const form = $(selector).first()
  if (form.length === 0) {
    throw new FormParseError(`No form matching ${selector} on the page`)
  }
  return parseFormElement($, form, options.pageUrl)
}

/** Every form on the page, in document order. */
export function parseForms(html: string, options: ParseFormOptions = {}): ParsedForm[] {
  const $ = cheerio.load(html)
  const out: ParsedForm[] = []
  $(options.selector ?? "form").each((_, el) => {
    out.push(parseFormElement($, $(el), options.pageUrl))
  })
  return out
}

/**
 * The form whose action contains `needle`.
 *
 * Pages carry navigation and search forms, so "the first form" is usually the
 * wrong one — that is how the import page came back reporting no file field.
 */
export function findFormByAction(
  html: string,
  needle: string,
  options: ParseFormOptions = {},
): ParsedForm | undefined {
  return parseForms(html, options).find((f) => f.action.includes(needle))
}

function parseFormElement(
  $: cheerio.CheerioAPI,
  form: cheerio.Cheerio<AnyNode>,
  pageUrl: string | undefined,
): ParsedForm {
  const fields: FormField[] = []
  const fileFields: string[] = []
  const textAreaFields: string[] = []
  const checkboxFields: string[] = []
  const push = (name: string | undefined, value: string): void => {
    if (name) fields.push({ name, value })
  }

  form.find("input, select, textarea").each((_, el) => {
    const $el = $(el)
    if ($el.attr("disabled") !== undefined) return

    const name = $el.attr("name")
    if (!name) return

    const tag = (el as { tagName?: string }).tagName?.toLowerCase()

    if (tag === "select") {
      const selected = $el.find("option[selected]")
      const multiple = $el.attr("multiple") !== undefined
      if (selected.length > 0) {
        selected.each((_i, opt) => push(name, optionValue($, opt)))
      } else if (!multiple) {
        // A single select with no explicit selection submits its first option.
        const first = $el.find("option").first()
        // An option-less select is where champctl has to stop imitating a
        // browser. ACSM renders one per entrant whose car has no skins to
        // choose from — every `any_car_model` slot, which is what an unclaimed
        // sign-up looks like (plan §4.4) — and it populates the options in
        // JavaScript that champctl doesn't run. A browser submits nothing for
        // an empty select, so the EntryList.Skin array arrives shorter than the
        // rest, and ACSM indexes these in parallel without a length check:
        // measured against 2.4.15, six names with two skins is an HTTP 500.
        // Sending an empty value keeps the arrays aligned and each entrant
        // keeps its own skin, which is also measured rather than assumed.
        if (first.length > 0) push(name, optionValue($, first[0]!))
        else push(name, "")
      }
      return
    }

    if (tag === "textarea") {
      textAreaFields.push(name)
      push(name, $el.text())
      return
    }

    const type = ($el.attr("type") ?? "text").toLowerCase()
    if (type === "submit" || type === "button" || type === "reset" || type === "image") return
    if (type === "file") {
      // Nothing meaningful to echo back; multipart parts are built explicitly.
      // The name is still needed to build one, hence fileFields.
      fileFields.push(name)
      return
    }
    if (type === "radio") {
      if ($el.attr("checked") === undefined) return
      push(name, $el.attr("value") ?? "on")
      return
    }

    // Checkboxes are not browser-standard here, and this is the single most
    // destructive thing champctl got wrong. ACSM rewrites every one of them in
    // a global submit handler before the browser serialises the form:
    //
    //   $("form").submit(function () {
    //     $(this).find('input[type="checkbox"]').each(function () {
    //       t.is(":checked") ? t.attr("value", "1")
    //                        : (t.after().append(t.clone().attr({type: "hidden", value: 0})),
    //                           t.prop("disabled", true))
    //     })
    //   })
    //
    // So what ACSM's Go side ever sees is an explicit "1" or "0", never the
    // browser default of "on" — and it parses accordingly, reading "on" as
    // false. Echoing the form back the way a browser would therefore turns off
    // every box that was on. Measured on 2.4.5: a save that sent
    // `Race.Enabled=on` dropped the practice, qualifying and race
    // configuration entirely, taking the event from three sessions to none
    // while reporting success. Sending "1" for those same six boxes preserves
    // all three.
    if (type === "checkbox") {
      checkboxFields.push(name)
      push(name, $el.attr("checked") === undefined ? "0" : "1")
      return
    }
    push(name, $el.attr("value") ?? "")
  })

  const action = form.attr("action") ?? ""
  return {
    action: resolveAction(action, pageUrl),
    method: (form.attr("method") ?? "GET").toUpperCase() === "POST" ? "POST" : "GET",
    enctype: form.attr("enctype") ?? "application/x-www-form-urlencoded",
    fields,
    fileFields,
    textAreaFields,
    checkboxFields,
  }
}

function optionValue($: cheerio.CheerioAPI, opt: unknown): string {
  const $opt = $(opt as never)
  const v = $opt.attr("value")
  return v !== undefined ? v : $opt.text().trim()
}

function resolveAction(action: string, pageUrl: string | undefined): string {
  if (!pageUrl) return action
  try {
    return new URL(action || pageUrl, pageUrl).toString()
  } catch {
    return action
  }
}

// ---------------------------------------------------------------------------
// Working with parsed fields
// ---------------------------------------------------------------------------

/** Every value for a key, in order. */
export function getAll(fields: readonly FormField[], name: string): string[] {
  return fields.filter((f) => f.name === name).map((f) => f.value)
}

/** First value for a key, or undefined. */
export function getOne(fields: readonly FormField[], name: string): string | undefined {
  return fields.find((f) => f.name === name)?.value
}

export function count(fields: readonly FormField[], name: string): number {
  let n = 0
  for (const f of fields) if (f.name === name) n++
  return n
}

/**
 * Replaces every value for a single-valued key, in place, preserving position.
 * Appends when the key is absent.
 *
 * Refuses to touch a repeated key: those are positional arrays and changing one
 * blindly is how an entry list gets scrambled. Use `setAt` for those.
 */
export function setOne(fields: FormField[], name: string, value: string): FormField[] {
  const occurrences = count(fields, name)
  if (occurrences > 1) {
    throw new FormParseError(
      `${name} appears ${occurrences} times; it is a positional array, so use setAt`,
    )
  }
  const i = fields.findIndex((f) => f.name === name)
  if (i === -1) fields.push({ name, value })
  else fields[i] = { name, value }
  return fields
}

/** Replaces the nth value of a repeated key, preserving position. */
export function setAt(
  fields: FormField[],
  name: string,
  index: number,
  value: string,
): FormField[] {
  let seen = 0
  for (let i = 0; i < fields.length; i++) {
    if (fields[i]!.name !== name) continue
    if (seen === index) {
      fields[i] = { name, value }
      return fields
    }
    seen++
  }
  throw new FormParseError(`${name} has only ${seen} values; no index ${index}`)
}

/** Drops every occurrence of a key. */
export function removeAll(fields: FormField[], name: string): FormField[] {
  for (let i = fields.length - 1; i >= 0; i--) {
    if (fields[i]!.name === name) fields.splice(i, 1)
  }
  return fields
}

/** Encodes for `application/x-www-form-urlencoded`, order preserved. */
export function toBody(fields: readonly FormField[]): URLSearchParams {
  const params = new URLSearchParams()
  for (const f of fields) params.append(f.name, f.value)
  return params
}

/** Key -> number of occurrences, for recon snapshots and drift detection. */
export function shape(fields: readonly FormField[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const f of fields) out[f.name] = (out[f.name] ?? 0) + 1
  return out
}

/**
 * The two `EntryList.*` checkboxes ACSM renders unpaired, and reads wrongly.
 *
 * Plain checkboxes with no hidden partner field, once per entrant, read by
 * position (docs/acsm-write-path.md §4). A browser omits unchecked boxes
 * entirely, so ticking the box on the 12th entrant sends a single value at
 * index 0 and ACSM applies it to the *first* entrant. The feature can only
 * behave when every box is ticked or none are.
 *
 * Two corrections, both measured, and together they make this a smaller problem
 * than it reads:
 *
 * 1. **They are not unpaired to a real browser.** ACSM rewrites every checkbox
 *    to an explicit 1 or 0 on submit (see the checkbox branch in `parseForm`),
 *    so a browser sends all N, correctly paired, and the positional read above
 *    is fed what it expects. The `formValueAsInt(...) == 1` in ACSM's own code
 *    is the same fact from the other side.
 * 2. **Neither field is on the 2.4.x event form at all.** Measured on 2.4.5:
 *    zero rendered for six entrants, and neither name appears anywhere on the
 *    page. They live on the championship *edit* form, which champctl does not
 *    drive — and there they render 8 and 7 times for 6 entrants, so whatever
 *    the extra rows are, that form needs its own reading before anything
 *    writes it.
 *
 * So champctl still strips them, and on 2.4.x that strips nothing. Kept because
 * 1.7.9 does render them on the event form, and absent means "false for
 * everyone" — the only reading that cannot quietly apply one entrant's setting
 * to another. Sending them faithfully is a change to make when champctl drives
 * the form that actually has them.
 */
export const UNPAIRED_ENTRY_LIST_CHECKBOXES = [
  "EntryList.OverwriteAllEvents",
  "EntryList.TransferTeamPoints",
] as const

/**
 * `EntryList.*` keys that are NOT per-entrant arrays, and so are exempt from
 * the arity check below.
 *
 * The two unpaired checkboxes, plus `NumEntrants` — a single form-level count
 * found on 1.7.9's event form. That one is echoed back rather than stripped,
 * because ACSM reads it as one number rather than positionally.
 */
export const NON_ARRAY_ENTRY_LIST_FIELDS = [
  ...UNPAIRED_ENTRY_LIST_CHECKBOXES,
  "EntryList.NumEntrants",
] as const

/**
 * The `EntryList.*` keys a POST must carry once it carries any entrants at all.
 *
 * Counting keys against each other cannot see a key that isn't there: a payload
 * with nine of these arrays at length 24 and the tenth missing entirely is
 * perfectly consistent, and passes an arity check with nothing to compare. What
 * ACSM does with it is not consistent at all.
 *
 * The first nine are indexed unguarded in `BuildEntryList` — `r.Form[k][i]` with
 * no length test — so a missing one is an index-out-of-range panic in the
 * manager (docs/acsm-write-path.md §1). `EntrantID` is guarded, and is here for
 * the opposite reason: its `else` branch assigns `PitBox = i`, so omitting it
 * doesn't leave pit boxes alone, it renumbers every entrant to its position in
 * the list (§2). A panic is loud; that one is silent, and worse.
 *
 * Fails closed, like the arity check it sits beside. If some form legitimately
 * renders without one of these, the write stops and someone reads the recon
 * output — which costs a diagnosis. Guessing the other way costs an entry list.
 */
export const REQUIRED_ENTRY_LIST_FIELDS = [
  "EntryList.Car",
  "EntryList.Skin",
  "EntryList.Name",
  "EntryList.Team",
  "EntryList.GUID",
  "EntryList.Ballast",
  "EntryList.Restrictor",
  "EntryList.FixedSetup",
  "EntryList.InternalUUID",
  "EntryList.EntrantID",
] as const

/**
 * Drops the unpaired checkboxes. Returns a new array.
 *
 * Not in place: callers pass fields they parsed from the page, and a write
 * path that quietly edited its own input would be a nasty thing to debug.
 */
export function stripUnpairedCheckboxes(fields: readonly FormField[]): FormField[] {
  const drop = new Set<string>(UNPAIRED_ENTRY_LIST_CHECKBOXES)
  return fields.filter((f) => !drop.has(f.name))
}

/**
 * Checks the invariant ACSM's parser assumes: every `EntryList.*` key that is
 * a per-entrant array appears the same number of times.
 *
 * A mismatch means either the form rendered something we don't understand or a
 * mutation went wrong. Either way the POST must not go out — a short array is
 * an index-out-of-range panic in ACSM, and a long one silently reassigns
 * entrant data (docs/acsm-write-path.md §1).
 *
 * Only the fields named in `NON_ARRAY_ENTRY_LIST_FIELDS` are exempt. An earlier
 * version also exempted anything appearing exactly once, so that a new
 * form-level counter couldn't block writes — but that let a two-entrant payload
 * missing one value through, which is precisely the case this exists to catch.
 * Fails closed instead: an unrecognised `EntryList.*` key with the wrong count
 * blocks the write, and the fix is to add it to the list above once someone has
 * checked what it is. Being wrong in that direction costs a diagnosis; being
 * wrong the other way costs an entry list.
 */

export interface EntryListShapeProblem {
  key: string
  count: number
  expected: number
}

export interface EntryListShapeOptions {
  /**
   * Which keys a payload carrying entrants must include.
   *
   * Defaults to `REQUIRED_ENTRY_LIST_FIELDS`, which describes the *event* form.
   * The championship form legitimately renders no `EntryList.EntrantID` — its
   * template excludes the field when `$.IsChampionship` — so a caller writing
   * that form passes `CHAMPIONSHIP_REQUIRED_ENTRY_LIST_FIELDS` instead.
   *
   * A parameter rather than a looser default on purpose. The default has to
   * keep failing closed for every caller that doesn't think about it, and the
   * one caller that has measured its form says so at the call site, where the
   * reason is next to the code.
   */
  required?: readonly string[]
}

export function checkEntryListShape(
  fields: readonly FormField[],
  options: EntryListShapeOptions = {},
): EntryListShapeProblem[] {
  const required = options.required ?? REQUIRED_ENTRY_LIST_FIELDS
  const counts = shape(fields)
  const excluded = new Set<string>(NON_ARRAY_ENTRY_LIST_FIELDS)
  const entries = Object.entries(counts).filter(
    ([k]) => k.startsWith("EntryList.") && !excluded.has(k),
  )
  if (entries.length === 0) return []

  // The most common count is the entrant count; anything else is the problem.
  const tally = new Map<number, number>()
  for (const [, n] of entries) tally.set(n, (tally.get(n) ?? 0) + 1)
  let expected = entries[0]![1]
  let best = -1
  for (const [n, howMany] of tally) {
    if (howMany > best || (howMany === best && n > expected)) {
      best = howMany
      expected = n
    }
  }

  const problems = entries
    .filter(([, n]) => n !== expected)
    .map(([key, n]) => ({ key, count: n, expected }))

  // A key that isn't there has no count to disagree with, so the loop above
  // can't see it — which is why the required list exists.
  if (expected > 0) {
    for (const key of required) {
      if (counts[key] === undefined) problems.push({ key, count: 0, expected })
    }
  }

  return problems
}
