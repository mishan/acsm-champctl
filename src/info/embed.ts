/**
 * The championship's info message (`discord.info`): one embed in the
 * announcements channel, built from what ACSM says about the season.
 *
 * An embed because the story alone runs close to Discord's 2,000 characters
 * for a bot's message, and an embed's description takes 4,096. Round times are
 * Discord timestamps, so everyone reads them in their own time zone.
 */

import { type CheerioAPI, load } from "cheerio"
import type { AnyNode } from "domhandler"

import type { Championship } from "../acsm/types.js"
import { eventHasResults, events, trackLabel } from "../acsm/view.js"
import { qualiStart, signUpLink } from "../bot/announce.js"
import type { LeagueProfile } from "../profile/types.js"

/** Discord's limits on an embed. */
const TITLE_LIMIT = 256
const DESCRIPTION_LIMIT = 4096
const FIELD_LIMIT = 1024
const EMBED_LIMIT = 6000

export interface InfoEmbed {
  title: string
  url?: string
  description: string
  fields: { name: string; value: string }[]
  footer: string
}

export interface InfoOptions {
  profile: LeagueProfile
  baseUrl: string
  /** Track folders to the names ACSM lists them under. */
  trackNames: ReadonlyMap<string, string>
  /** Where the carset downloads from, if it has anything in it. */
  carsetUrl?: string
  links: readonly { label: string; url: string }[]
}

export function infoEmbed(c: Championship, o: InfoOptions): InfoEmbed {
  const story = infoText(typeof c.Info === "string" ? c.Info : "")
  const signUp = signUpLink(c, o.baseUrl)

  const rounds = events(c)
  const rows = rounds.map((ev, i) => {
    const track = ev.RaceSetup?.Track?.trim() ?? ""
    const layout = ev.RaceSetup?.TrackLayout?.trim() ?? ""
    const named = o.trackNames.get(track)
    // The listing names a track, not its layouts: a season on two layouts of
    // one track needs them told apart.
    const twoLayouts = rounds.some(
      (other) =>
        other.RaceSetup?.Track?.trim() === track &&
        (other.RaceSetup?.TrackLayout?.trim() ?? "") !== layout,
    )
    const label = named
      ? markdownSafe(twoLayouts && layout ? `${named} (${layout})` : named)
      : markdownSafe(trackLabel(ev.RaceSetup)) || "to be announced"
    const name = `${i + 1}. ${label}`
    if (eventHasResults(ev)) return `~~${name}~~`
    const quali = qualiStart(ev, o.profile)
    return quali?.isValid ? `${name}: <t:${quali.toSeconds()}:F>` : `${name}: date to come`
  })

  const links = [
    // The same page either way; ACSM only takes sign-ups on it while they're on.
    ...(signUp ? [link(c.SignUpForm?.Enabled === false ? "Details" : "Sign up", signUp)] : []),
    ...o.links.map((l) => link(l.label, l.url)),
    ...(o.carsetUrl ? [link("Everyone's liveries", o.carsetUrl)] : []),
  ]
  const liveries = o.profile.discord?.livery ? "Send your livery with `/livery upload`." : ""

  const title = clip(story.title || c.Name?.trim() || "This season", TITLE_LIMIT)
  const footer = "Times are qualifying, in your own time zone."
  const fields = [
    ...(rows.length ? [{ name: "Rounds", value: clip(rows.join("\n"), FIELD_LIMIT) }] : []),
    ...(links.length || liveries
      ? [
          {
            name: "Links",
            value: clip([links.join(" · "), liveries].filter(Boolean).join("\n"), FIELD_LIMIT),
          },
        ]
      : []),
  ]
  // Discord refuses an embed over 6,000 characters in all, so the story gives way.
  const rest =
    title.length + footer.length + fields.reduce((n, f) => n + f.name.length + f.value.length, 0)
  return {
    title,
    ...(signUp ? { url: signUp } : {}),
    description: clip(story.body, Math.min(DESCRIPTION_LIMIT, EMBED_LIMIT - rest)),
    fields,
    footer,
  }
}

/**
 * ACSM's championship info, an HTML page edited in its rich text box, as
 * Discord markdown. Its first heading is the title. Images and videos are
 * left out: an embed can't hold them inline.
 */
export function infoText(html: string): { title?: string; body: string } {
  const $ = load(html)
  $("img, iframe, script, style").remove()
  let title: string | undefined
  const blocks: { text: string; item: boolean }[] = []
  const add = (raw: string, kind: "heading" | "item" | "text") => {
    const text = raw.replace(/[ \t]*\n[ \t]*/g, "\n").trim()
    if (!text) return
    if (kind === "heading" && title === undefined) title = text
    else if (kind === "heading") blocks.push({ text: `**${text}**`, item: false })
    else blocks.push({ text: kind === "item" ? `• ${text}` : text, item: kind === "item" })
  }
  const walk = (node: AnyNode) => {
    // Text outside any paragraph, straight under the body or a div, is a
    // paragraph of its own.
    let loose: AnyNode[] = []
    const flush = () => {
      add(loose.map((n) => inline($, n)).join(""), "text")
      loose = []
    }
    for (const child of $(node).contents().toArray()) {
      const tag = child.type === "tag" ? child.tagName.toLowerCase() : ""
      if (!tag || INLINE.has(tag)) {
        loose.push(child)
        continue
      }
      flush()
      if (/^h[1-6]$/.test(tag)) add(inline($, child), "heading")
      else if (tag === "p") add(inline($, child), "text")
      else if (tag === "li") add(inline($, child), "item")
      else walk(child)
    }
    flush()
  }
  walk($("body").get(0) ?? ($.root().get(0) as AnyNode))
  const body = blocks
    .map((b, i) => (i === 0 ? "" : b.item && blocks[i - 1]?.item ? "\n" : "\n\n") + b.text)
    .join("")
  return { ...(title ? { title } : {}), body }
}

/** Tags that sit inside a line of text rather than starting one. */
const INLINE = new Set([
  "a",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "span",
  "br",
  "code",
  "small",
  "sub",
  "sup",
  "font",
])

function inline($: CheerioAPI, node: AnyNode): string {
  if (node.type === "text") return markdownSafe(node.data.replace(/\s+/g, " "))
  if (node.type !== "tag") return ""
  const tag = node.tagName.toLowerCase()
  if (tag === "br") return "\n"
  const text = $(node)
    .contents()
    .toArray()
    .map((n) => inline($, n))
    .join("")
  if (tag === "a") {
    const href = $(node).attr("href") ?? ""
    if (!/^https?:\/\//.test(href) || !text.trim()) return text
    return text.trim() === markdownSafe(href) ? href : link(text.trim(), href, true)
  }
  if ((tag === "strong" || tag === "b") && text.trim()) return `**${text.trim()}**`
  if ((tag === "em" || tag === "i") && text.trim()) return `*${text.trim()}*`
  return text
}

/** A markdown link that a bracket in its text or its URL can't break. */
function link(text: string, url: string, safe = false): string {
  const label = safe ? text : markdownSafe(text)
  return `[${label}](${url.replace(/\(/g, "%28").replace(/\)/g, "%29")})`
}

/**
 * Text that reads as itself, not as Discord markdown: its emphasis, links,
 * and the headings, quotes and lists a line can start.
 */
function markdownSafe(text: string): string {
  return text.replace(/[\\*_~`|[\]]/g, "\\$&").replace(/^(\s*)([#>-])/gm, "$1\\$2")
}

/** At most `limit` characters, cut at a line where it can be. */
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit - 1)
  const line = cut.lastIndexOf("\n")
  return `${line > limit / 2 ? cut.slice(0, line) : cut}…`
}
