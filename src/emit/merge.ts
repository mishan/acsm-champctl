/**
 * Deep merge for the template-and-overlay pipeline (plan §4.1).
 *
 * The design rule this exists to serve:
 *
 * > Do not model ACSM's championship schema. It is a large undocumented Go
 * > struct that will drift across versions. [...] Anything not explicitly
 * > modelled flows through untouched. That property is what makes this survive
 * > ACSM upgrades.
 *
 * So this merges *values*, not a schema. It knows nothing about championships,
 * and adding knowledge of them here would be the mistake.
 *
 * Three decisions worth stating, because each has an obvious alternative that
 * is wrong for this job:
 *
 * **Arrays replace, never merge.** `Events` and `Classes` are ordered lists
 * where position is meaning — round 1, round 2. Merging a two-event overlay
 * into a five-event template index-by-index would leave rounds 3 to 5 from
 * last month attached to this month's championship, which is exactly the kind
 * of silent, plausible wrongness this tool exists to prevent. Replacing is
 * loud: you get what you asked for.
 *
 * **`undefined` means "not specified", `null` means "set it to null".** An
 * overlay is usually built by spreading partial objects, and TypeScript's
 * optional properties become `undefined` rather than absent. Treating that as
 * "blank this field" would let an unmentioned field silently clear.
 *
 * **Nothing is mutated.** The template is typically a fixture or an archived
 * export, and a merge that scribbled on it would corrupt the source of truth
 * for every later merge in the same process.
 */

import { FORBIDDEN_KEYS } from "../acsm/write.js"

/**
 * A `{}`-shaped object, and nothing with a prototype of its own.
 *
 * Stricter than `isPlainObject` in `acsm/diff.ts`, on purpose: a deep merge
 * that recursed into a Date or a class instance would take it apart field by
 * field and hand back a plain object wearing its properties. The looser one is
 * right for diffing, where walking anything object-shaped is exactly what is
 * wanted. The two used to share the name `isPlainObject`, which made importing
 * the wrong one compile and read correctly at the call site; they are named
 * apart now so the difference is a decision rather than an accident.
 */
function isMergeableObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v) as unknown
  return proto === Object.prototype || proto === null
}

/**
 * Deep-merges `overlay` onto `base`, returning a new value.
 *
 * Plain objects merge key by key; everything else replaces.
 */
export function deepMerge<T>(base: T, overlay: unknown): T {
  if (overlay === undefined) return base
  if (!isMergeableObject(base) || !isMergeableObject(overlay)) return overlay as T

  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    if (FORBIDDEN_KEYS.has(key)) continue
    if (value === undefined) continue
    out[key] = key in out ? deepMerge(out[key], value) : value
  }
  return out as T
}

/**
 * Merges a chain left to right: template, then league defaults, then month,
 * then event overrides. Later wins.
 */
export function mergeAll<T>(base: T, ...overlays: readonly unknown[]): T {
  return overlays.reduce<T>((acc, o) => deepMerge(acc, o), base)
}

/**
 * Strips `undefined` values so a spread-built overlay says what it means.
 *
 * `{ Name: undefined }` and `{}` describe the same intent — "I have nothing to
 * say about Name" — but only the second is obviously that on inspection. Used
 * when an overlay is assembled from optional inputs.
 */
export function definedOnly<T extends object>(o: T): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) out[k] = v
  }
  return out as Partial<T>
}
