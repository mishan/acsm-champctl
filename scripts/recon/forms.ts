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

import { resolve } from "node:path"

import {
  NON_ARRAY_ENTRY_LIST_FIELDS,
  findFormByAction,
  parseForm,
  shape,
} from "../../src/acsm/form.js"
import type { AcsmSession } from "../../src/acsm/session.js"
import type { Championship } from "../../src/acsm/types.js"
import { events, sessionKeysUsed } from "../../src/acsm/view.js"
import {
  IMPORT_PATH,
  detectImportMechanism,
  eventEditPath,
  eventSchedulePath,
  exportPath,
  importChampionship,
} from "../../src/acsm/write.js"
import {
  connect,
  log,
  redactBaseUrl,
  runRecon,
  seedChampionship,
  stableUrl,
  writeArtefact,
} from "./env.js"
import { raggedKeys } from "./report.js"

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
    // Masked: actions resolve to absolute URLs, so they carry the host, and
    // the championship/event UUIDs are new on every run. See stableUrl.
    path: stableUrl(path),
    action: stableUrl(form.action),
    method: form.method,
    enctype: form.enctype,
    shape: shape(form.fields),
    order: [...new Set(form.fields.map((f) => f.name))],
  }
}

/**
 * Server Manager's version, so a capture from a 1.7.x harness is never
 * mistaken for one from the 2.4.5 BATL runs. See docs/acsm-write-path.md §0 —
 * some of these answers are version-specific and some aren't.
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

async function main(): Promise<void> {
  const session = await connect()
  log(`Logged in to ${session.baseUrl} as ${session.username}`)

  const version = await serverVersion(session)
  log(`Server Manager version: ${version ?? "unknown"}`)
  if (version && version.startsWith("1.")) {
    log(`  Note: BATL runs 2.4.5. Treat the EntrantID and premium-endpoint`)
    log(`  answers below as provisional — see docs/acsm-write-path.md §0.`)
  }

  // ---------------------------------------------------------------- import
  // How a championship is handed over differs by version: 1.7.9 renders a
  // textarea and reads r.FormValue("import"); 2.4.5 takes a multipart upload.
  const mechanism = await detectImportMechanism(session)
  const importForm = findFormByAction(
    await session.getText(IMPORT_PATH),
    IMPORT_PATH,
    { pageUrl: session.url(IMPORT_PATH) },
  )
  log(
    `Import: ${mechanism.kind === "file" ? "multipart file upload" : "form field (paste JSON)"}` +
      ` named "${mechanism.field}", enctype=${importForm?.enctype ?? "?"}`,
  )

  log("")
  log("Seeding a championship to experiment on...")
  const { championship: seed, source } = await seedChampionship(
    session,
    FIXTURE,
    "champctl recon — safe to delete",
    // The entrants page 404s unless sign-ups are on, and that page is the
    // approve/reject queue recon item 5 is about.
    { keepSignUpsEnabled: true },
  )
  log(`  using ${source}`)

  // The literal session keys this build uses. ACSM's SessionType constants are
  // "PRACTICE"/"QUALIFY"/"RACE", but exports have carried friendly spellings
  // too, and a map lookup with the wrong key fails silently.
  const seedKeys = sessionKeysUsed(seed)
  if (seedKeys.length > 0) log(`  session keys in this build: ${seedKeys.join(", ")}`)

  const imported = await importChampionship(session, seed, { mechanism })
  const championshipId = imported.championshipId!
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

  // The EntryList keys that aren't per-entrant arrays, reported separately so
  // the ragged list below only contains things worth looking at. The two
  // checkboxes are rendered unpaired, which breaks ACSM's positional read
  // (docs/acsm-write-path.md §4); NumEntrants is a form-level counter.
  for (const key of NON_ARRAY_ENTRY_LIST_FIELDS) {
    const n = editSnapshot.shape[key] ?? 0
    if (n > 0 && n !== nameCount) {
      log(`  ${key} appears ${n} times for ${nameCount} entrants — known not to be an array.`)
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
  const scheduleForm = findScheduleForm(viewHtml, session.url(viewPath), eventId)
  if (scheduleForm) {
    snapshots.push({ ...scheduleForm, path: stableUrl(schedulePath) })
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
    // Approve/reject links carry the entrant's Steam GUID; the URL shape is
    // what recon item 5 is about, not who is in the list.
    await writeArtefact("entrant-status-links.json", {
      path: stableUrl(entrantsPath),
      links: links.map(stableUrl),
    })
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

  await writeArtefact(version ? `forms-${version}.json` : "forms.json", {
    capturedAt: new Date().toISOString(),
    serverManagerVersion: version ?? "unknown",
    // Host stripped: this file is committed and public (see
    // fixtures/recon/README.md). The scheme and port still say which
    // service the capture came from.
    baseUrl: redactBaseUrl(session.baseUrl),
    // How this build takes a championship. 1.7.9 pastes JSON into a textarea;
    // 2.4.5 uploads a file. Recorded because it changed between them.
    seedSource: stableUrl(source),
    sessionKeys: sessionKeysUsed(exported),
    importMechanism: mechanism.kind,
    importField: mechanism.field,
    importEnctype: importForm?.enctype,
    entrantIdRendered: entrantIdCount > 0,
    entrantCount: nameCount,
    forms: snapshots,
    trackInfoPath: stableUrl(trackPath),
    trackInfo,
  })

  log("")
  log(`Wrote fixtures/recon/${version ? `forms-${version}.json` : "forms.json"}`)
  log(`Clean up with: delete championship ${championshipId} in the UI, or docker compose down -v`)
}

/** Finds the form whose action mentions this event id, e.g. the schedule form. */
function findScheduleForm(
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


await runRecon("recon:forms", main)
