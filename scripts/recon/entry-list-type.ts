/**
 * Where do `EntryListType` and `PracticeEntryListType` live, and do they survive?
 *
 * Two questions, both raised by a real BATL export whose events carried neither
 * field while the championship carried both (plan §4.4):
 *
 * 1. Structural — are they championship-level? Answerable read-only, off any
 *    export the manager already has.
 * 2. Behavioural — does a championship-level `PracticeEntryListType: 2` come
 *    back as 2? This is the one §5.4 recorded as a "silent value change" and
 *    flagged as not-to-be-allowlisted-until-understood. It needs a write, so
 *    this imports one championship and deletes it again.
 *
 * Loopback only, and it says which build answered — a 1.7.x answer settles
 * nothing about 2.4.x (docs/acsm-write-path.md §0), so the version is part of
 * the result rather than a footnote.
 */

import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"

import { exportPath } from "../../src/acsm/paths.js"
import { AcsmSession } from "../../src/acsm/session.js"
import type { Championship } from "../../src/acsm/types.js"
import { importChampionship } from "../../src/acsm/write.js"

const BASE = process.env.ACSM_PROBE_URL ?? "http://127.0.0.1:8773"
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(BASE)) {
  throw new Error(`Refusing to write to ${BASE}. This probe imports championships; loopback only.`)
}

const health = (await (await fetch(`${BASE}/healthcheck.json`)).json()) as { Version?: string }
console.log(`manager: ${health.Version ?? "unknown"} at ${BASE}`)

const session = new AcsmSession({ baseUrl: BASE, rateLimit: false })
await session.login({
  username: process.env.ACSM_PROBE_USER ?? "admin",
  password: process.env.ACSM_PROBE_PASS ?? "servermanager",
})

const seed = JSON.parse(readFileSync("fixtures/synthetic/recon-seed.json", "utf8")) as Championship

/** A fresh copy of the seed with the two fields set where 2.4.x keeps them. */
function candidate(entry: number | undefined, practice: number | undefined): Championship {
  const c: Championship = {
    ...seed,
    ID: randomUUID(),
    Name: `champctl EntryListType probe — safe to delete`,
    Events: (seed.Events ?? []).map((e) => ({ ...e, ID: randomUUID() })),
    Classes: (seed.Classes ?? []).map((k) => ({ ...k, ID: randomUUID() })),
  }
  // Deleted rather than set to undefined, so "absent" is really absent — that
  // is the case the seeds were accidentally testing and it turned out to be
  // the whole answer.
  if (entry === undefined) delete c.EntryListType
  else c.EntryListType = entry
  if (practice === undefined) delete c.PracticeEntryListType
  else c.PracticeEntryListType = practice
  return c
}

const cases: [string, number | undefined, number | undefined][] = [
  ["absent (what champctl used to send)", undefined, undefined],
  ["locked race, partially locked practice (what BATL asks for)", 1, 2],
  ["unlocked both", 0, 0],
]

for (const [label, entry, practice] of cases) {
  const sent = candidate(entry, practice)
  const { championshipId } = await importChampionship(session, sent, { now: new Date() })
  const back = await session.getJson<Championship>(exportPath(championshipId))
  const rs = (back.Events ?? [])[0]?.RaceSetup ?? {}
  console.log(
    `\n${label}\n` +
      `  sent      EntryListType=${JSON.stringify(entry)} PracticeEntryListType=${JSON.stringify(practice)}\n` +
      `  returned  EntryListType=${JSON.stringify(back.EntryListType)} PracticeEntryListType=${JSON.stringify(back.PracticeEntryListType)}\n` +
      `  on the event's RaceSetup: present=${Object.hasOwn(rs, "EntryListType")} ` +
      `LockedEntryList=${JSON.stringify(rs.LockedEntryList)} PickupModeEnabled=${JSON.stringify(rs.PickupModeEnabled)}\n` +
      `  ${championshipId}`,
  )
}

console.log("\nDelete these in Server Manager; the probe does not.")
