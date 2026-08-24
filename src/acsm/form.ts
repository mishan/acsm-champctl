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
 *  - unchecked checkboxes and unselected radios are omitted
 *  - disabled controls are omitted; readonly ones are NOT (ACSM renders the
 *    championship entrant name, team and GUID readonly, and they must be sent)
 *  - a select with nothing marked selected submits its first option
 *  - buttons are omitted, since no button was "clicked"
 *  - unnamed controls are omitted
 */
export function parseForm(html: string, options: ParseFormOptions = {}): ParsedForm {
  const $ = cheerio.load(html)
  const selector = options.selector ?? "form"
  const form = $(selector).first()
  if (form.length === 0) {
    throw new FormParseError(`No form matching ${selector} on the page`)
  }

  const fields: FormField[] = []
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
        if (first.length > 0) push(name, optionValue($, first[0]!))
      }
      return
    }

    if (tag === "textarea") {
      push(name, $el.text())
      return
    }

    const type = ($el.attr("type") ?? "text").toLowerCase()
    if (type === "submit" || type === "button" || type === "reset" || type === "image") return
    if (type === "file") {
      // Nothing meaningful to echo back; multipart parts are built explicitly.
      return
    }
    if (type === "checkbox" || type === "radio") {
      if ($el.attr("checked") === undefined) return
      push(name, $el.attr("value") ?? "on")
      return
    }
    push(name, $el.attr("value") ?? "")
  })

  const action = form.attr("action") ?? ""
  return {
    action: resolveAction(action, options.pageUrl),
    method: (form.attr("method") ?? "GET").toUpperCase() === "POST" ? "POST" : "GET",
    enctype: form.attr("enctype") ?? "application/x-www-form-urlencoded",
    fields,
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
export function setAt(fields: FormField[], name: string, index: number, value: string): FormField[] {
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
 * Checks the invariant ACSM's parser assumes: every `EntryList.*` key appears
 * the same number of times.
 *
 * A mismatch means either the form rendered something we don't understand or a
 * mutation went wrong. Either way the POST must not go out — a short array is
 * an index-out-of-range panic in ACSM, and a long one silently reassigns
 * entrant data (docs/acsm-write-path.md §1).
 *
 * The two bare checkboxes are excluded because ACSM renders them unpaired and
 * reads them positionally anyway; champctl omits them entirely (§4).
 */
export const UNPAIRED_ENTRY_LIST_CHECKBOXES = [
  "EntryList.OverwriteAllEvents",
  "EntryList.TransferTeamPoints",
] as const

export interface EntryListShapeProblem {
  key: string
  count: number
  expected: number
}

export function checkEntryListShape(fields: readonly FormField[]): EntryListShapeProblem[] {
  const counts = shape(fields)
  const excluded = new Set<string>(UNPAIRED_ENTRY_LIST_CHECKBOXES)
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

  return entries
    .filter(([, n]) => n !== expected)
    .map(([key, n]) => ({ key, count: n, expected }))
}
