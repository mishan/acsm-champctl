/**
 * Content checks (plan §6.4).
 *
 * Everything that needs to know what is installed on the server runs only when
 * a ContentIndex is supplied. The pit-count check runs regardless, because an
 * unknown pit count is exactly the thing that silently disables the grid
 * checks in §6.1 — it needs to be visible rather than inferred from silence.
 */

import { ANY_CAR_MODEL } from "../../acsm/types.js"
import {
  availableCars,
  claimedSlots,
  eventLabel,
  events,
  slots,
  spectatorCar,
  trackLabel,
} from "../../acsm/view.js"
import type { Check } from "../context.js"
import { humanList, pluralize } from "../finding.js"

export const trackNotInstalled: Check = {
  id: "content.track-missing",
  section: "6.4",
  run(ctx, emit) {
    const content = ctx.content
    if (!content) return

    events(ctx.championship).forEach((ev, i) => {
      const track = (ev.RaceSetup?.Track ?? "").trim()
      if (!track) return
      const layout = (ev.RaceSetup?.TrackLayout ?? "").trim()
      if (content.hasTrack(track, layout)) return

      const label = eventLabel(ev, i + 1)
      const what = layout ? `the ${layout} layout of ${track}` : track
      emit(
        "ERROR",
        "content.track-missing",
        `${what} isn't installed on the server, so ${label} can't run.`,
        { round: i + 1, event: label, path: `Events[${i}].RaceSetup.Track` },
        { track, layout },
      )
    })
  },
}

export const carNotInstalled: Check = {
  id: "content.car-missing",
  section: "6.4",
  run(ctx, emit) {
    const content = ctx.content
    if (!content) return

    const models = availableCars(ctx.championship)
    const spectatorModel = spectatorCar(ctx.championship)?.Model
    if (spectatorModel) models.add(spectatorModel)

    const missing = [...models].filter((m) => !content.hasCar(m))
    if (missing.length === 0) return

    emit(
      "ERROR",
      "content.car-missing",
      `${humanList(missing)} ${pluralize(missing.length, "isn't", "aren't")} installed on the server.`,
      { path: "Classes[].AvailableCars" },
      { models: missing },
    )
  },
}

export const skinMissing: Check = {
  id: "content.skin-missing",
  section: "6.4",
  run(ctx, emit) {
    const content = ctx.content
    if (!content) return

    const seen = new Set<string>()
    events(ctx.championship).forEach((ev, i) => {
      const label = eventLabel(ev, i + 1)
      for (const s of claimedSlots(ev.EntryList)) {
        const model = (s.entrant.Model ?? "").trim()
        const skin = (s.entrant.Skin ?? "").trim()
        if (!model || !skin || model === ANY_CAR_MODEL) continue

        const available = content.skinsFor(model)
        if (!available || available.has(skin)) continue

        const key = `${model}/${skin}`
        if (seen.has(key)) continue
        seen.add(key)

        const who = s.entrant.Name || s.key
        emit(
          "WARN",
          "content.skin-missing",
          `${who} is set to the ${skin} skin for ${model} at ${label}, and the server doesn't have it.`,
          { round: i + 1, event: label, path: `Events[${i}].EntryList.${s.key}.Skin` },
          { model, skin },
        )
      }
    })
  },
}

export const unknownPitCount: Check = {
  id: "content.pit-count-unknown",
  section: "6.4",
  run(ctx, emit) {
    const reported = new Set<string>()

    events(ctx.championship).forEach((ev, i) => {
      const rs = ev.RaceSetup
      const track = trackLabel(rs)
      if (!track || reported.has(track)) return

      const record = ctx.pits.get(rs?.Track ?? "", rs?.TrackLayout)
      const label = eventLabel(ev, i + 1)
      const loc = { round: i + 1, event: label, path: `Events[${i}].RaceSetup.Track` }

      if (!record) {
        reported.add(track)
        const maxClients = rs?.MaxClients ?? 0
        const biggest = Math.max(
          maxClients,
          ...slots(ev.EntryList).map((s) => (s.entrant.PitBox ?? 0) + 1),
          0,
        )
        emit(
          "WARN",
          "content.pit-count-unknown",
          `I don't know how many pit boxes ${track} has, so I can't tell whether ${biggest} cars fit.`,
          loc,
          { track, needed: biggest },
        )
        return
      }

      if (!record.verifiedAt) {
        reported.add(track)
        emit(
          "WARN",
          "content.pit-count-unverified",
          `${track}'s pit count of ${record.pitboxes} came from ${record.source} and nobody has verified it.`,
          loc,
          { track, pitboxes: record.pitboxes, source: record.source },
        )
      }
    })
  },
}

export const contentChecks: readonly Check[] = [
  trackNotInstalled,
  carNotInstalled,
  skinMissing,
  unknownPitCount,
]
