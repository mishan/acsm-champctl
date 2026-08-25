/**
 * What the browser is allowed to see.
 *
 * The shapes are declared in `wire.ts`, which the client imports too. This
 * module is the only thing that builds them, and nothing else in `src/web/`
 * serialises an engine object directly. That one rule does two jobs.
 *
 * The first is privacy. A championship export carries the entry list, and a
 * parsed event form carries it twice over: driver names, Steam GUIDs, chosen
 * cars, pit boxes. The finalize screen needs none of it — it sets a lap count
 * and a quali time — so none of it is sent. Deciding that once, in a module
 * whose whole purpose is the decision, beats deciding it at each of five
 * handlers and getting it right at four.
 *
 * The second is that the browser and the CLI should be looking at the same
 * thing. `changes` here is the same `changes` the CLI prints, and `formChanges`
 * is the same list of fields that will actually be posted. The preview cannot
 * lie about what the write does, because it is showing the write's own account
 * of itself rather than a second description assembled for display.
 */

import { DateTime } from "luxon"

import type { Championship, ChampionshipEvent, ChampionshipSummary } from "../acsm/types.js"
import { eventHasStarted, eventLabel, events, trackLabel } from "../acsm/view.js"
import type { FormFieldChange } from "../finalize/format.js"
import { readFormat } from "../finalize/format.js"
import type { CheckReport } from "../gridmom/finding.js"
import type { EmitResult } from "../emit/month.js"
import type { FinalizePlan } from "../finalize/plan.js"
import { currentQualiStart, practiceMinutesFor } from "../finalize/schedule.js"
import type { LeagueProfile } from "../profile/types.js"
import type {
  ChampionshipListItem,
  ChampionshipView,
  LocalTimeView,
  MonthPlanView,
  MonthRoundView,
  PlanView,
  PostedField,
  RoundView,
} from "./wire.js"

export type * from "./wire.js"

/**
 * The list, with anything that has no id dropped.
 *
 * A summary with no ID is not something the UI can navigate to, and rendering
 * it as a row that does nothing when tapped is worse than not rendering it.
 */
export function championshipList(
  summaries: readonly ChampionshipSummary[],
): ChampionshipListItem[] {
  const out: ChampionshipListItem[] = []
  for (const s of summaries) {
    const id = (s.ID ?? "").trim()
    if (!id) continue
    out.push({ id, name: (s.Name ?? "").trim() || id })
  }
  return out
}

export function championshipView(c: Championship, profile: LeagueProfile): ChampionshipView {
  return {
    id: (c.ID ?? "").trim(),
    name: (c.Name ?? "").trim(),
    timezone: profile.schedule.timezone,
    rounds: events(c).map((ev, i) => roundView(ev, i + 1, profile)),
  }
}

export function roundView(ev: ChampionshipEvent, round: number, profile: LeagueProfile): RoundView {
  const zone = profile.schedule.timezone
  const practiceMinutes = practiceMinutesFor(ev, profile.schedule.practiceMinutes)
  const quali = currentQualiStart(ev, zone, practiceMinutes)

  return {
    round,
    eventId: (ev.ID ?? "").trim(),
    track: trackLabel(ev.RaceSetup),
    label: eventLabel(ev, round),
    started: eventHasStarted(ev),
    format: readFormat(ev),
    practiceMinutes,
    quali: quali ? localTime(quali) : null,
    // Derived rather than read off `Scheduled` directly, so the two never
    // disagree: `currentQualiStart` is what champctl believes the quali time
    // is, and practice start is that minus the practice length by definition.
    // Reading the raw field would also mean rendering Go's zero time for an
    // unscheduled event as though it were a date in the year 1.
    practiceStart: quali ? localTime(quali.minus({ minutes: practiceMinutes })) : null,
  }
}

/**
 * The month as a review screen, not as a championship export.
 *
 * The export is a large document of ACSM's own bookkeeping, and handing it to
 * a browser invites reading the wrong field to answer a question this can
 * answer directly. What crosses is §5.1 step 5: the rounds with their tracks
 * and times, the grid cap and what bound it, and what the emitter decided
 * rather than inherited.
 */
export function monthPlanView(
  planId: string,
  sourceId: string,
  result: EmitResult,
  gridmom: CheckReport,
  profile: LeagueProfile,
): MonthPlanView {
  const zone = profile.schedule.timezone
  const rounds = events(result.championship).map((ev, i): MonthRoundView => {
    const scheduled = result.schedule[i]
    const track = ev.RaceSetup?.Track ?? ""
    const layout = ev.RaceSetup?.TrackLayout ?? ""
    return {
      round: i + 1,
      track,
      ...(layout ? { layout } : {}),
      label: trackLabel(ev.RaceSetup),
      quali: localTime(DateTime.fromISO(scheduled?.qualiStart ?? "", { zone }).setZone(zone)),
      moved: scheduled?.overridden === true,
      ...(scheduled?.note ? { note: scheduled.note } : {}),
    }
  })

  return {
    planId,
    sourceId,
    name: result.championship.Name ?? "",
    rounds,
    grid: {
      maxClients: result.grid.maxClients,
      ...(result.grid.bindingTrack ? { bindingTrack: result.grid.bindingTrack } : {}),
      unknownTracks: result.grid.unknownTracks,
      summary: result.grid.summary,
    },
    derived: result.derived,
    gridmom,
    blocked: gridmom.counts.ERROR > 0,
    needsAcknowledgement: gridmom.counts.WARN > 0,
  }
}

function localTime(dt: DateTime): LocalTimeView {
  return {
    date: dt.toFormat("yyyy-MM-dd"),
    time: dt.toFormat("HH:mm"),
    display: dt.toFormat("yyyy-MM-dd HH:mm ZZZZ"),
  }
}

/**
 * The plan, minus the parsed form.
 *
 * `plan.form` is the whole rendered event page: every `EntryList.*` key for
 * every entrant, which is the league's driver names and Steam GUIDs. The CLI
 * strips it from `--json` output for tidiness; here it is a disclosure, so the
 * shape is built by naming what goes out rather than by deleting what doesn't.
 * A field added to `FinalizePlan` later is then absent from the response until
 * someone decides it should be there.
 */
export function planView(planId: string, plan: FinalizePlan): PlanView {
  return {
    planId,
    championshipId: plan.championshipId,
    eventId: plan.eventId,
    round: plan.round,
    current: plan.current,
    desired: plan.desired,
    changes: plan.changes,
    formChanges: plan.formChanges.map(postedField),
    schedule: plan.schedule
      ? {
          from: plan.schedule.from ?? null,
          to: plan.schedule.to,
          fields: Object.entries(plan.schedule.values).map(([name, value]) => ({ name, value })),
        }
      : null,
    gridmom: plan.gridmom,
    blocked: plan.blocked,
    needsAcknowledgement: plan.gridmom.counts.WARN > 0,
    noop: plan.noop,
  }
}

/**
 * `undefined` becomes `null` deliberately.
 *
 * `JSON.stringify` drops an undefined property, so a field the form doesn't
 * currently carry would arrive as an object with no `before` key at all — and
 * "absent from the response" reads to a UI exactly like "absent from the
 * form", which is a different claim. The CLI prints `(absent)` for this case;
 * `null` is how JSON says the same thing.
 */
function postedField(f: FormFieldChange): PostedField {
  return { name: f.name, before: f.before ?? null, after: f.after }
}
