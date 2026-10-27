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
const DESCRIPTION_LIMIT = 4096
const FIELD_LIMIT = 1024

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

  const rounds = events(c).map((ev, i) => {
    const track = ev.RaceSetup?.Track?.trim() ?? ""
    const name = `${i + 1}. ${o.trackNames.get(track) ?? (trackLabel(ev.RaceSetup) || "to be announced")}`
    if (eventHasResults(ev)) return `~~${name}~~`
    const quali = qualiStart(ev, o.profile)
    return quali?.isValid ? `${name}: <t:${quali.toSeconds()}:F>` : `${name}: date to come`
  })

  const links = [
    ...(signUp ? [`[Sign up](${signUp})`] : []),
    ...o.links.map((l) => `[${l.label}](${l.url})`),
    ...(o.carsetUrl ? [`[Everyone's liveries](${o.carsetUrl})`] : []),
  ]
  const liveries = o.profile.discord?.livery ? "Send your livery with `/livery upload`." : ""

  return {
    title: story.title || c.Name?.trim() || "This season",
    ...(signUp ? { url: signUp } : {}),
    description: clip(story.body, DESCRIPTION_LIMIT),
    fields: [
      ...(rounds.length ? [{ name: "Rounds", value: clip(rounds.join("\n"), FIELD_LIMIT) }] : []),
      ...(links.length || liveries
        ? [
            {
              name: "Links",
              value: clip([links.join(" · "), liveries].filter(Boolean).join("\n"), FIELD_LIMIT),
            },
          ]
        : []),
    ],
    footer: "Times are qualifying, in your own time zone.",
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
  const walk = (node: AnyNode) => {
    for (const child of $(node).children().toArray()) {
      const tag = child.tagName.toLowerCase()
      if (/^h[1-6]$/.test(tag) || tag === "p" || tag === "li") {
        const text = inline($, child)
          .replace(/[ \t]*\n[ \t]*/g, "\n")
          .trim()
        if (!text) continue
        if (/^h[1-6]$/.test(tag)) {
          if (title === undefined) title = text
          else blocks.push({ text: `**${text}**`, item: false })
        } else blocks.push({ text: tag === "li" ? `• ${text}` : text, item: tag === "li" })
      } else walk(child)
    }
  }
  walk($("body").get(0) ?? ($.root().get(0) as AnyNode))
  const body = blocks
    .map((b, i) => (i === 0 ? "" : b.item && blocks[i - 1]?.item ? "\n" : "\n\n") + b.text)
    .join("")
  return { ...(title ? { title } : {}), body }
}

function inline($: CheerioAPI, node: AnyNode): string {
  return $(node)
    .contents()
    .toArray()
    .map((n) => {
      if (n.type === "text") return markdownSafe(n.data.replace(/\s+/g, " "))
      if (n.type !== "tag") return ""
      const tag = n.tagName.toLowerCase()
      if (tag === "br") return "\n"
      // A list item wraps its text in a paragraph.
      if (tag === "p") return inline($, n)
      const text = inline($, n)
      if (tag === "a") {
        const href = $(n).attr("href") ?? ""
        if (!/^https?:\/\//.test(href) || !text.trim()) return text
        return text.trim() === markdownSafe(href) ? href : `[${text.trim()}](${href})`
      }
      if ((tag === "strong" || tag === "b") && text.trim()) return `**${text.trim()}**`
      if ((tag === "em" || tag === "i") && text.trim()) return `*${text.trim()}*`
      return text
    })
    .join("")
}

/** Text that reads as itself, not as Discord markdown. */
function markdownSafe(text: string): string {
  return text.replace(/[\\*_~`|]/g, "\\$&")
}

/** At most `limit` characters, cut at a line where it can be. */
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit - 1)
  const line = cut.lastIndexOf("\n")
  return `${line > limit / 2 ? cut.slice(0, line) : cut}…`
}
