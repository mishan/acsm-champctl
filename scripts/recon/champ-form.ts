/**
 * Championship-form recon — the reading champctl needs before it can set a
 * driver's livery at championship level.
 *
 *   npm run recon:champ-form                 # seed a championship, then read it
 *   npm run recon:champ-form -- <id>         # read one that already exists
 *
 * champctl drives the *event* form and only the event form. Setting a skin
 * there is the wrong place for a livery drop: `CombineEntryLists` starts from
 * the championship's class entrants and then lets each event's own entrant
 * overwrite `Skin` on top, so a per-round save has to be repeated for every
 * round and is undone by anything that rewrites the class list.
 *
 * ACSM's answer is `EntryList.OverwriteAllEvents`, a per-entrant checkbox on
 * this form. On save it walks every ticked class entrant and copies its
 * properties down onto each event's entry list. From championship_manager.go:
 *
 *   // look at each entrant to see if their properties should overwrite all
 *   // event properties set up in the event entrylist. this is useful for
 *   // globally changing skins, restrictor values etc.
 *
 * So the write is one POST rather than one per round. What stops champctl
 * making it today is that nobody has read the form. docs/acsm-2.4.15.md §5
 * measured `EntryList.OverwriteAllEvents` at **8** occurrences and
 * `EntryList.TransferTeamPoints` at **7** for **6** entrants, and until those
 * two numbers have an explanation there is no safe way to say which occurrence
 * belongs to which driver — and `EntryList.*` keys are parallel positional
 * arrays, so guessing gives entrants each other's data (§1).
 *
 * This script answers, for whatever build it is pointed at:
 *
 *   1. Is `EntryList.EntrantID` rendered here? §2 predicts not — the template
 *      excludes it when `$.IsChampionship` — and its `else` branch sets
 *      `PitBox = i`, so a save renumbers every class entrant to its position.
 *   2. Where do the extra `OverwriteAllEvents` / `TransferTeamPoints`
 *      occurrences sit? A hidden clone-me template row would explain them.
 *   3. Is `EntryList.Skin` a select here, and how many options does it carry?
 *   4. Would `checkEntryListShape` refuse this form as it stands? That is what
 *      `postForm` would do, so it is the question with a write on the end of it.
 *
 * Commit the output. The diff on the next ACSM upgrade is the point.
 */

import * as cheerio from "cheerio"

import {
  REQUIRED_ENTRY_LIST_FIELDS,
  UNPAIRED_ENTRY_LIST_CHECKBOXES,
  checkEntryListShape,
  findFormByAction,
  shape,
} from "../../src/acsm/form.js"
import type { AcsmSession } from "../../src/acsm/session.js"
import type { Championship } from "../../src/acsm/types.js"
import { events } from "../../src/acsm/view.js"
import {
  CHAMPIONSHIP_SUBMIT_PATH,
  championshipEditPath,
  detectImportMechanism,
  exportPath,
  importChampionship,
} from "../../src/acsm/write.js"
import { connect, log, runRecon, seedChampionship, writeArtefact } from "./env.js"
import {
  type ControlSite,
  describeControls,
  internalUuidJoin,
  raggedKeys,
  redactBaseUrl,
  stableSource,
  stableUrl,
  summariseControls,
} from "./report.js"

const FIXTURE = "fixtures/synthetic/recon-seed.json"

/** The keys whose arity on this form is the open question. */
const PROBED_FIELDS = [...REQUIRED_ENTRY_LIST_FIELDS, ...UNPAIRED_ENTRY_LIST_CHECKBOXES] as const

/**
 * Server Manager's version. Same job as in `forms.ts`, and worth the duplicate:
 * every answer here is version-specific, and a capture that can't say which
 * build produced it is a capture nobody can trust twice.
 */
async function serverVersion(session: AcsmSession): Promise<string | undefined> {
  try {
    const health = await session.getJson<Record<string, unknown>>("/healthcheck.json")
    for (const key of ["Version", "version", "ServerManagerVersion"]) {
      const v = health[key]
      if (typeof v === "string" && v) return v
    }
  } catch {
    // Fall through to scraping the page footer.
  }
  try {
    const html = await session.getText("/")
    const m = /v?(\d+\.\d+\.\d+)/.exec(html.slice(html.lastIndexOf("<footer")))
    return m?.[1]
  } catch {
    return undefined
  }
}

/**
 * How many options each `EntryList.Skin` select offers.
 *
 * Counts only. The option *values* are skin folder names, which on a league's
 * manager are driver handles — and this file is committed.
 */
function skinOptionCounts(html: string): number[] {
  const $ = cheerio.load(html)
  return $('select[name="EntryList.Skin"]')
    .toArray()
    .map((el) => $(el).find("option").length)
}

/**
 * The championship to read.
 *
 * A championship named on the command line is read as-is and nothing is
 * written. Without one, a throwaway is imported the way `recon:forms` does it —
 * which is the right default on the harness and the wrong thing to do to a
 * league's manager, hence the guard in `readEnv`.
 */
async function championshipToRead(session: AcsmSession): Promise<{ id: string; source: string }> {
  const named = process.argv[2]
  if (named) return { id: named, source: `existing championship ${named}, read-only` }

  log("Seeding a championship to read...")
  const { championship: seed, source } = await seedChampionship(
    session,
    FIXTURE,
    "champctl champ-form recon — safe to delete",
  )
  log(`  using ${source}`)

  const mechanism = await detectImportMechanism(session)
  const imported = await importChampionship(session, seed, { mechanism })
  log(`Imported championship ${imported.championshipId}`)
  return { id: imported.championshipId, source }
}

async function main(): Promise<void> {
  const session = await connect()
  log(`Logged in to ${session.baseUrl} as ${session.username}`)

  const version = await serverVersion(session)
  log(`Server Manager version: ${version ?? "unknown"}`)

  const { id: championshipId, source } = await championshipToRead(session)

  // Read the export too: it says how many entrants and classes there really
  // are, which is the number every count below has to be judged against. The
  // form alone cannot tell an entrant row from a template row — that is the
  // whole question.
  const exported = await session.getJson<Championship>(exportPath(championshipId))
  const classes = Array.isArray(exported.Classes) ? exported.Classes : []
  const entrantsPerClass = classes.map((c) => Object.keys(c?.Entrants ?? {}).length)
  const entrantCount = entrantsPerClass.reduce((a, b) => a + b, 0)
  const roundCount = events(exported).length

  log("")
  log(
    `Championship has ${classes.length} ${classes.length === 1 ? "class" : "classes"} ` +
      `(${entrantsPerClass.join(" + ") || "0"} entrants), ${roundCount} rounds.`,
  )

  // ---------------------------------------- can OverwriteAllEvents reach anything
  // Asked before the form is even fetched, because a "no" here makes the rest
  // moot: the mechanism joins class entrant to event entrant on InternalUUID,
  // and a miss is silent. Plan §5.5 says these UUIDs are per-list and therefore
  // never line up; ACSM's code assumes they do. Only one of those is true.
  const join = internalUuidJoin(exported)
  log("")
  log(`OverwriteAllEvents reach — class entrants found in each round's entry list:`)
  log(`  ${join.matchedPerRound.join(", ") || "(no rounds)"} of ${join.classEntrants}`)
  if (join.roundsWithoutEntryList.length > 0) {
    log(
      `  Rounds ${join.roundsWithoutEntryList.join(", ")} have no entry list of their own and ` +
        `use the class list whole, so nothing there needs overwriting.`,
    )
  }
  if (join.classEntrantsWithoutUuid > 0) {
    log(`  ${join.classEntrantsWithoutUuid} class entrants have no usable InternalUUID.`)
  }
  if (join.matchedEverywhere === 0 && join.classEntrants > 0) {
    log(`  !! No class entrant matches in any round. If that holds on BATL's own export,`)
    log(`     OverwriteAllEvents is a no-op there and a championship-level livery change`)
    log(`     would report success and reach nothing. Plan §5.5 would be right and the`)
    log(`     whole approach needs replacing with a per-round write.`)
  } else if (join.matchedEverywhere < join.classEntrants) {
    log(`  !! Only ${join.matchedEverywhere} of ${join.classEntrants} match in every round.`)
    log(`     The rest would be skipped silently — FindEntrantByInternalUUID returns an`)
    log(`     empty Entrant on a miss, so the copy goes into a throwaway.`)
  }

  const editPath = championshipEditPath(championshipId)
  const html = await session.getText(editPath)
  const form = findFormByAction(html, CHAMPIONSHIP_SUBMIT_PATH, { pageUrl: session.url(editPath) })
  if (!form) {
    throw new Error(
      `No form posting to ${CHAMPIONSHIP_SUBMIT_PATH} on ${editPath}. ` +
        `2.4.x redirects every page to /intro/checks until the first-run wizard is done — ` +
        `run \`npm run harness:provision\` if this is a fresh container.`,
    )
  }

  const counts = shape(form.fields)
  const sites = describeControls(html, CHAMPIONSHIP_SUBMIT_PATH, PROBED_FIELDS)

  // ------------------------------------------------------------- EntrantID
  const entrantIdCount = counts["EntryList.EntrantID"] ?? 0
  const nameCount = counts["EntryList.Name"] ?? 0
  log("")
  log(`Championship form: ${nameCount} EntryList.Name fields for ${entrantCount} stored entrants.`)
  if (entrantIdCount === 0) {
    log(`  EntryList.EntrantID is NOT rendered, as docs/acsm-write-path.md §2 predicts.`)
    log(`  BuildEntryList's else branch then sets PitBox = i, so saving this form renumbers`)
    log(`  every class entrant to its position in the list. With one class that is a`)
    log(`  reshuffle; with ${classes.length} it is two entrants claiming CAR_0, and`)
    log(`  AddInPitBox deletes one of them at practice-start.`)
  } else {
    log(`  EntryList.EntrantID is rendered ${entrantIdCount} times. Unexpected here — §2 says`)
    log(`  the template excludes it on the class list. Re-read that section before trusting it.`)
  }

  // --------------------------------------------- the 8-vs-6 / 7-vs-6 mystery
  log("")
  log(`Where the repeated keys sit:`)
  for (const key of PROBED_FIELDS) {
    const n = counts[key] ?? 0
    const summary = summariseControls(sites[key] ?? [])
    const shapes = Object.entries(summary)
    log(`  ${key}: ${n}`)
    for (const [descriptor, howMany] of shapes) log(`      ${howMany} x ${descriptor}`)
  }

  const hiddenCounts = Object.fromEntries(
    Object.entries(sites).map(([key, list]) => [key, list.filter((s) => s.hidden).length]),
  )
  const anyHidden = Object.values(hiddenCounts).some((n) => n > 0)
  if (anyHidden) {
    log("")
    log(`  Some occurrences sit inside hidden markup, which is what ACSM's clone-me`)
    log(`  "add entrant" template row looks like. Hidden does not mean unsubmitted —`)
    log(`  display:none has no effect on submission, only disabled does — so a payload`)
    log(`  built from this form carries them and they land on real entrants by position.`)
  }

  // ------------------------------------------------------------------ skins
  const skinOptions = skinOptionCounts(html)
  log("")
  if (skinOptions.length === 0) {
    log(`EntryList.Skin is not a <select> on this form. Read what it is before writing it.`)
  } else {
    log(
      `EntryList.Skin: ${skinOptions.length} selects, ` +
        `${Math.min(...skinOptions)}–${Math.max(...skinOptions)} options each.`,
    )
    if (skinOptions.some((n) => n === 0)) {
      log(`  At least one has no options. parseForm submits "" for those rather than`)
      log(`  dropping them, which keeps the arrays aligned — see the select branch in form.ts.`)
    }
  }

  // ------------------------------------------- would champctl send this at all
  const problems = checkEntryListShape(form.fields)
  log("")
  if (problems.length === 0) {
    log(`checkEntryListShape: clean. postForm would send this form as parsed.`)
  } else {
    log(`checkEntryListShape would REFUSE this form as parsed:`)
    for (const p of problems) {
      log(`  ${p.key}: ${p.count === 0 ? "missing" : p.count} against ${p.expected} entrants`)
    }
    log(`  That refusal is correct until the counts above are explained. Whatever explains`)
    log(`  them belongs in NON_ARRAY_ENTRY_LIST_FIELDS or in the writer, not in a loosened check.`)
  }

  const ragged = raggedKeys(counts, nameCount)
  if (ragged.length > 0) {
    log(`  EntryList keys that don't match the EntryList.Name count: ${ragged.join(", ")}`)
  }

  const artefact = version ? `champ-form-${version}.json` : "champ-form.json"
  await writeArtefact(artefact, {
    capturedAt: new Date().toISOString(),
    serverManagerVersion: version ?? "unknown",
    baseUrl: redactBaseUrl(session.baseUrl),
    source: stableSource(source),
    classCount: classes.length,
    entrantsPerClass,
    entrantCount,
    roundCount,
    internalUuidJoin: join,
    form: {
      path: stableUrl(editPath),
      action: stableUrl(form.action),
      method: form.method,
      enctype: form.enctype,
      shape: counts,
      order: [...new Set(form.fields.map((f) => f.name))],
    },
    entrantIdRendered: entrantIdCount > 0,
    skinSelectCount: skinOptions.length,
    skinOptionCounts: skinOptions,
    controlSites: Object.fromEntries(
      Object.entries(sites).map(([key, list]) => [key, summariseControls(list as ControlSite[])]),
    ),
    hiddenOccurrences: hiddenCounts,
    entryListShapeProblems: problems,
  })

  log("")
  log(`Wrote fixtures/recon/${artefact}`)
  if (!process.argv[2]) {
    log(`Clean up with: delete championship ${championshipId} in the UI, or docker compose down -v`)
  }
}

await runRecon("recon:champ-form", main)
