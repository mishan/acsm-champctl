/**
 * Form recon — closes plan §3.4 items 4, 5 and 6, plus the import file field.
 *
 *   npm run recon:forms
 *
 * Imports a throwaway championship into the harness, then snapshots the shape
 * of every form champctl needs to drive, into fixtures/recon/. Commit the
 * output: the diff on the next ACSM upgrade is the point.
 *
 * The headline question it answers is whether `EntryList.EntrantID` is rendered
 * on the championship event form. If it isn't, saving that form renumbers every
 * pit box — see docs/acsm-write-path.md §2.
 */

import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { parseForm, shape } from "../../src/acsm/form.js"
import type { Championship } from "../../src/acsm/types.js"
import { events } from "../../src/acsm/view.js"
import {
  IMPORT_PATH,
  eventEditPath,
  eventSchedulePath,
  exportPath,
  importChampionship,
} from "../../src/acsm/write.js"
import { connect, log, runRecon, writeArtefact } from "./env.js"

const FIXTURE = resolve(process.cwd(), "fixtures/synthetic/recon-seed.json")

interface FormSnapshot {
  path: string
  action: string
  method: string
  enctype: string
  /** field name -> occurrence count. The shape, not the values. */
  shape: Record<string, number>
  /** Names only, in document order, so reordering shows up in the diff. */
  order: string[]
}

function snapshot(path: string, html: string, pageUrl: string, selector?: string): FormSnapshot {
  const form = parseForm(html, { ...(selector ? { selector } : {}), pageUrl })
  return {
    path,
    action: form.action,
    method: form.method,
    enctype: form.enctype,
    shape: shape(form.fields),
    order: [...new Set(form.fields.map((f) => f.name))],
  }
}

async function main(): Promise<void> {
  const session = await connect()
  log(`Logged in to ${session.baseUrl} as ${session.username}`)

  // ---------------------------------------------------------------- import
  // The import page itself tells us the file input's name, which was the last
  // unknown in the create path.
  const importHtml = await session.getText(IMPORT_PATH)
  const importForm = parseForm(importHtml, { pageUrl: session.url(IMPORT_PATH) })
  const fileFieldName = fileInputName(importHtml)
  log(`Import form: enctype=${importForm.enctype} fileField=${fileFieldName ?? "NOT FOUND"}`)

  const seed = JSON.parse(await readFile(FIXTURE, "utf8")) as Championship
  const imported = await importChampionship(session, seed, {
    ...(fileFieldName ? { fileFieldName } : {}),
  })
  const championshipId = imported.championshipId
  if (!championshipId) {
    throw new Error(
      "Import didn't redirect to a championship. Check that the file field name is right.",
    )
  }
  log(`Imported championship ${championshipId}`)

  // Re-export to learn the IDs ACSM actually assigned.
  const exported = await session.getJson<Championship>(exportPath(championshipId))
  const firstEvent = events(exported)[0]
  const eventId = firstEvent?.ID
  if (!eventId) throw new Error("Imported championship came back with no events")

  const snapshots: FormSnapshot[] = []

  // ------------------------------------------------------------ event edit
  const editPath = eventEditPath(championshipId, eventId)
  const editHtml = await session.getText(editPath)
  const editSnapshot = snapshot(editPath, editHtml, session.url(editPath))
  snapshots.push(editSnapshot)

  const entrantIdCount = editSnapshot.shape["EntryList.EntrantID"] ?? 0
  const nameCount = editSnapshot.shape["EntryList.Name"] ?? 0
  log("")
  log(`Event edit form: ${nameCount} entrants`)
  if (entrantIdCount === 0) {
    log(`  !! EntryList.EntrantID is NOT rendered.`)
    log(`     Saving this form sets every pit box to its list position, so BATL's`)
    log(`     assignments would be renumbered 0..${Math.max(0, nameCount - 1)}.`)
    log(`     champctl must send EntrantID explicitly. See docs/acsm-write-path.md §2.`)
  } else if (entrantIdCount === nameCount) {
    log(`  EntryList.EntrantID is rendered ${entrantIdCount} times — pit boxes round-trip.`)
  } else {
    log(`  !! EntryList.EntrantID appears ${entrantIdCount} times but there are ${nameCount} entrants.`)
  }

  // The unpaired checkboxes: present in the form but omitted when unchecked,
  // which breaks ACSM's positional read (docs/acsm-write-path.md §4).
  for (const key of ["EntryList.OverwriteAllEvents", "EntryList.TransferTeamPoints"]) {
    const n = editSnapshot.shape[key] ?? 0
    if (n > 0 && n !== nameCount) {
      log(`  ${key} appears ${n} times for ${nameCount} entrants — unpaired, as expected.`)
    }
  }

  const ragged = raggedKeys(editSnapshot.shape, nameCount)
  if (ragged.length > 0) {
    log(`  EntryList keys that don't match the entrant count: ${ragged.join(", ")}`)
  }

  // -------------------------------------------------------------- schedule
  // Scheduling is a separate endpoint, so changing a quali time is two
  // requests, not one (plan §5.2). Its fields live on the championship view.
  const viewPath = `/championship/${championshipId}`
  const viewHtml = await session.getText(viewPath)
  const schedulePath = eventSchedulePath(championshipId, eventId)
  const scheduleForm = findFormByAction(viewHtml, session.url(viewPath), eventId)
  if (scheduleForm) {
    snapshots.push({ ...scheduleForm, path: schedulePath })
    log("")
    log(`Schedule form fields: ${scheduleForm.order.join(", ")}`)
  } else {
    log("")
    log(`!! No schedule form found on ${viewPath}. It may be built by JS rather than rendered.`)
  }

  // -------------------------------------------------------------- entrants
  // The sign-up queue. Approve/reject is a GET on
  // /championship/{id}/entrant/{guid}, not a POST — see write-path §5.
  const entrantsPath = `/championship/${championshipId}/entrants`
  try {
    const entrantsHtml = await session.getText(entrantsPath)
    const links = entrantStatusLinks(entrantsHtml)
    log("")
    log(`Entrants page: ${links.length} status links${links[0] ? `, e.g. ${links[0]}` : ""}`)
    await writeArtefact("entrant-status-links.json", { path: entrantsPath, links })
  } catch (e) {
    log(`Entrants page unavailable: ${e instanceof Error ? e.message : String(e)}`)
  }

  // ------------------------------------------------------------ pit counts
  // /content/tracks/{track}/ui/ui_track.json is the `acsm` pit-count source.
  // With no content installed this 404s, which is itself worth recording.
  const track = firstEvent.RaceSetup?.Track ?? "suzuka"
  const trackPath = `/content/tracks/${track}/ui/ui_track.json`
  let trackInfo: unknown = null
  try {
    trackInfo = await session.getJson(trackPath)
    log("")
    log(`Track info for ${track}: ${JSON.stringify(trackInfo).slice(0, 200)}`)
  } catch (e) {
    log("")
    log(`Track info for ${track} unavailable (expected with no content installed): ${
      e instanceof Error ? e.message : String(e)
    }`)
  }

  await writeArtefact("forms.json", {
    capturedAt: new Date().toISOString(),
    baseUrl: session.baseUrl,
    importFileField: fileFieldName,
    importEnctype: importForm.enctype,
    entrantIdRendered: entrantIdCount > 0,
    entrantCount: nameCount,
    forms: snapshots,
    trackInfoPath: trackPath,
    trackInfo,
  })

  log("")
  log(`Wrote fixtures/recon/forms.json`)
  log(`Clean up with: delete championship ${championshipId} in the UI, or docker compose down -v`)
}

/** The name of the first file input on a page. */
function fileInputName(html: string): string | undefined {
  const m = /<input[^>]*type=["']file["'][^>]*>/i.exec(html)
  if (!m) return undefined
  const name = /name=["']([^"']+)["']/i.exec(m[0])
  return name?.[1]
}

/** Finds the form whose action mentions this event id, e.g. the schedule form. */
function findFormByAction(
  html: string,
  pageUrl: string,
  eventId: string,
): FormSnapshot | undefined {
  // Try each form on the page until one has a matching action.
  for (let i = 0; i < 40; i++) {
    try {
      const s = snapshot("", html, pageUrl, `form:nth-of-type(${i + 1})`)
      if (s.action.includes(eventId) && s.action.includes("schedule")) return s
    } catch {
      break
    }
  }
  return undefined
}

function entrantStatusLinks(html: string): string[] {
  const out = new Set<string>()
  const re = /href=["']([^"']*\/entrant\/[^"']+)["']/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) out.add(m[1]!)
  return [...out]
}

function raggedKeys(shapes: Record<string, number>, expected: number): string[] {
  return Object.entries(shapes)
    .filter(([k, n]) => k.startsWith("EntryList.") && n !== expected)
    .map(([k, n]) => `${k}=${n}`)
}

await runRecon("recon:forms", main)
