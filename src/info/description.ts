/**
 * The championship page's description, as the plain text the create screen
 * edits.
 *
 * 2.4.x keeps it as HTML in `Info`, pictures and all, and exports no
 * `Description`; older builds keep plain text in `Description`. Reading only
 * `Description` showed BATL's clones an empty box, and writing only it left
 * the source's real description on the new championship.
 */

import type { Championship } from "../acsm/types.js"
import { infoText } from "./embed.js"

export function descriptionText(c: Championship): string {
  if (typeof c.Info !== "string") return c.Description ?? ""
  const { title, body } = infoText(c.Info)
  return [title, body].filter(Boolean).join("\n\n")
}

/**
 * The fields that give a championship cloned from `source` this description.
 *
 * Text left as it was keeps the source's HTML as it was, formatting and
 * pictures included. Changed text becomes plain paragraphs, which is all a
 * text box can say.
 */
export function descriptionFields(source: Championship, text: string): Partial<Championship> {
  if (typeof source.Info !== "string") return { Description: text }
  if (text === descriptionText(source)) return {}
  return { Info: paragraphs(text) }
}

function paragraphs(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("")
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}
