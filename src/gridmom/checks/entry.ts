/**
 * Entry list and grid checks (plan §6.1).
 *
 * The entry list is duplicated in five places — the championship class plus
 * each event — so cross-list comparison is doing real work here.
 */

import { ANY_CAR_MODEL, type EntryList } from "../../acsm/types.js"
import {
  acceptedSignUps,
  claimedSlots,
  classes,
  eventLabel,
  events,
  isAnyCarModel,
  isMultiModel,
  isUnclaimed,
  normGuid,
  raceSetupCars,
  slots,
  spectatorCar,
  spectatorCarCount,
  trackLabel,
  type Slot,
} from "../../acsm/view.js"
import type { Check, CheckContext, Emit } from "../context.js"
import { humanList, pluralize } from "../finding.js"

/** Groups slots by a key, returning only the keys with more than one slot. */
function duplicates<K>(items: Slot[], keyOf: (s: Slot) => K | undefined): Map<K, Slot[]> {
  const byKey = new Map<K, Slot[]>()
  for (const s of items) {
    const k = keyOf(s)
    if (k === undefined || k === null || k === "") continue
    const bucket = byKey.get(k)
    if (bucket) bucket.push(s)
    else byKey.set(k, [s])
  }
  for (const [k, v] of byKey) if (v.length < 2) byKey.delete(k)
  return byKey
}

/** Every entry list in the championship, labelled for messages. */
interface NamedList {
  list: EntryList | undefined
  /** e.g. `the RSS 4 class entry list` or `Suzuka's entry list`. */
  label: string
  location: { round?: number; event?: string; className?: string; path: string }
}

function allLists(ctx: CheckContext): NamedList[] {
  const out: NamedList[] = []
  classes(ctx.championship).forEach((cls, i) => {
    const name = cls.Name ?? `class ${i + 1}`
    out.push({
      list: cls.Entrants,
      label: `the ${name} class entry list`,
      location: { className: name, path: `Classes[${i}].Entrants` },
    })
  })
  events(ctx.championship).forEach((ev, i) => {
    const round = i + 1
    const label = trackLabel(ev.RaceSetup) || eventLabel(ev, round)
    out.push({
      list: ev.EntryList,
      label: `${label}'s entry list`,
      location: { round, event: label, path: `Events[${i}].EntryList` },
    })
  })
  return out
}

/**
 * The check that already has a real bug to catch: the Suzuka event has
 * duplicate pit boxes at 3, 16 and 27, and the class list at 9 and 10.
 *
 * Note the pit box lives in `PitBox` in the export but arrives as
 * `EntryList.EntrantID` in the edit form (plan §3.2) — same number, and the
 * fix is reassigning the duplicates into the list's gaps.
 */
export const duplicatePitBox: Check = {
  id: "entry.duplicate-pit-box",
  section: "6.1",
  run(ctx, emit) {
    for (const { list, label, location } of allLists(ctx)) {
      const all = slots(list)
      const dupes = duplicates(all, (s) => s.entrant.PitBox)
      if (dupes.size === 0) continue

      const boxes = [...dupes.keys()].sort((a, b) => a - b)
      const used = new Set(all.map((s) => s.entrant.PitBox).filter((p): p is number => p != null))
      const gaps = freeBoxes(used, all.length)

      const fix = gaps.length >= boxes.length
        ? ` There ${pluralize(gaps.length, "is a gap", "are gaps")} at ${humanList(gaps.slice(0, boxes.length))} to move them into.`
        : ""

      emit(
        "ERROR",
        "entry.duplicate-pit-box",
        `${cap(label)} has duplicate pit ${pluralize(boxes.length, "box", "boxes")} at ${humanList(boxes)}.${fix}`,
        location,
        {
          pitBoxes: boxes,
          gaps,
          slots: Object.fromEntries(
            [...dupes].map(([box, ss]) => [box, ss.map((s) => s.key)]),
          ),
        },
      )
    }
  },
}

/** Unused pit box indices below the list size — the obvious places to move to. */
function freeBoxes(used: Set<number>, size: number): number[] {
  const gaps: number[] = []
  for (let i = 0; i < size; i++) if (!used.has(i)) gaps.push(i)
  return gaps
}

export const spectatorPitBoxCollision: Check = {
  id: "entry.spectator-pit-box",
  section: "6.1",
  run(ctx, emit) {
    const spectator = spectatorCar(ctx.championship)
    const box = spectator?.PitBox
    if (spectator == null || box == null) return

    for (const { list, label, location } of allLists(ctx)) {
      const clash = slots(list).filter((s) => s.entrant.PitBox === box)
      if (clash.length === 0) continue
      const who = clash.map((s) => s.entrant.Name || s.key)
      emit(
        "ERROR",
        "entry.spectator-pit-box",
        `The spectator car sits in pit box ${box}, which ${humanList(who)} also ${pluralize(who.length, "uses", "use")} in ${label}.`,
        location,
        { pitBox: box, entrants: who },
      )
    }
  },
}

export const maxClientsExceedsPits: Check = {
  id: "grid.max-clients",
  section: "6.1",
  run(ctx, emit) {
    const spectators = spectatorCarCount(ctx.championship)
    events(ctx.championship).forEach((ev, i) => {
      const rs = ev.RaceSetup
      const track = trackLabel(rs)
      if (!track) return
      const record = ctx.pits.get(rs?.Track ?? "", rs?.TrackLayout)
      if (!record) return // handled by the unknown-pit-count check

      const maxClients = rs?.MaxClients ?? 0
      const needed = maxClients + spectators
      if (needed <= record.pitboxes) return

      const label = eventLabel(ev, i + 1)
      const spectatorNote = spectators > 0 ? ` plus the spectator car` : ""
      emit(
        "ERROR",
        "grid.max-clients",
        `${cap(label)} lets ${maxClients} cars on track${spectatorNote}, but ${track} only has ${record.pitboxes} pit ${pluralize(record.pitboxes, "box", "boxes")}.`,
        { round: i + 1, event: label, path: `Events[${i}].RaceSetup.MaxClients` },
        { maxClients, spectators, pitboxes: record.pitboxes, track },
      )
    })
  },
}

export const pitBoxBeyondTrackCapacity: Check = {
  id: "entry.pit-box-out-of-range",
  section: "6.1",
  run(ctx, emit) {
    events(ctx.championship).forEach((ev, i) => {
      const rs = ev.RaceSetup
      const record = ctx.pits.get(rs?.Track ?? "", rs?.TrackLayout)
      if (!record) return
      const track = trackLabel(rs)
      const label = eventLabel(ev, i + 1)

      const over = slots(ev.EntryList).filter(
        (s) => (s.entrant.PitBox ?? 0) >= record.pitboxes,
      )
      if (over.length === 0) return

      const boxes = [...new Set(over.map((s) => s.entrant.PitBox!))].sort((a, b) => a - b)
      emit(
        "ERROR",
        "entry.pit-box-out-of-range",
        `${cap(label)} puts ${pluralize(over.length, "someone", "people")} in pit ${pluralize(boxes.length, "box", "boxes")} ${humanList(boxes)}, but ${track} stops at ${record.pitboxes - 1}.`,
        { round: i + 1, event: label, path: `Events[${i}].EntryList` },
        { pitBoxes: boxes, pitboxes: record.pitboxes, track },
      )
    })
  },
}

export const modelNotInClass: Check = {
  id: "entry.model-not-available",
  section: "6.1",
  run(ctx, emit) {
    const spectatorModel = spectatorCar(ctx.championship)?.Model
    const excluded = new Set(ctx.profile.excludedCarModels ?? [])

    classes(ctx.championship).forEach((cls, i) => {
      const available = new Set((cls.AvailableCars ?? []).filter(Boolean))
      if (available.size === 0) return
      const name = cls.Name ?? `class ${i + 1}`

      const check = (list: EntryList | undefined, label: string, path: string, round?: number) => {
        for (const s of slots(list)) {
          const model = (s.entrant.Model ?? "").trim()
          if (!model || model === ANY_CAR_MODEL) continue
          if (available.has(model)) continue
          if (model === spectatorModel || excluded.has(model)) continue
          const who = s.entrant.Name || s.key
          const loc = { className: name, path: `${path}.${s.key}`, ...(round ? { round } : {}) }
          emit(
            "ERROR",
            "entry.model-not-available",
            `${who} is entered in ${label} driving ${model}, which isn't one of the ${name} cars.`,
            loc,
            { model, available: [...available], slot: s.key },
          )
        }
      }

      check(cls.Entrants, `the ${name} class`, `Classes[${i}].Entrants`)
    })

    // Event lists aren't per-class in the export, so validate them against the
    // union of every class's cars.
    const union = new Set<string>()
    for (const cls of classes(ctx.championship)) {
      for (const m of cls.AvailableCars ?? []) if (m) union.add(m)
    }
    if (union.size === 0) return

    events(ctx.championship).forEach((ev, i) => {
      const label = eventLabel(ev, i + 1)
      for (const s of slots(ev.EntryList)) {
        const model = (s.entrant.Model ?? "").trim()
        if (!model || model === ANY_CAR_MODEL) continue
        if (union.has(model)) continue
        if (model === spectatorModel || excluded.has(model)) continue
        const who = s.entrant.Name || s.key
        emit(
          "ERROR",
          "entry.model-not-available",
          `${who} is entered at ${label} driving ${model}, which isn't in the championship car list.`,
          { round: i + 1, event: label, path: `Events[${i}].EntryList.${s.key}` },
          { model, available: [...union], slot: s.key },
        )
      }
    })
  },
}

/**
 * `RaceSetup.Cars` must be derived from the class cars plus the spectator
 * model, never inherited from a template — the import test shipped a
 * `ford_transit` that way (plan §5.5).
 */
export const raceSetupCarsMismatch: Check = {
  id: "grid.race-setup-cars",
  section: "6.1",
  run(ctx, emit) {
    const expected = new Set<string>()
    for (const cls of classes(ctx.championship)) {
      for (const m of cls.AvailableCars ?? []) if (m) expected.add(m)
    }
    if (expected.size === 0) return
    const spectatorModel = spectatorCar(ctx.championship)?.Model
    if (spectatorModel) expected.add(spectatorModel)

    events(ctx.championship).forEach((ev, i) => {
      const actual = new Set(raceSetupCars(ev.RaceSetup))
      if (actual.size === 0) return
      const extra = [...actual].filter((m) => !expected.has(m))
      const missing = [...expected].filter((m) => !actual.has(m))
      if (extra.length === 0 && missing.length === 0) return

      const label = eventLabel(ev, i + 1)
      const parts: string[] = []
      if (extra.length) parts.push(`still lists ${humanList(extra)}`)
      if (missing.length) parts.push(`is missing ${humanList(missing)}`)
      emit(
        "WARN",
        "grid.race-setup-cars",
        `The car list for ${label} ${parts.join(", and ")} compared to the championship's own cars.`,
        { round: i + 1, event: label, path: `Events[${i}].RaceSetup.Cars` },
        { extra, missing, expected: [...expected] },
      )
    })
  },
}

export const eventListDiffersFromClass: Check = {
  id: "entry.event-differs-from-class",
  section: "6.1",
  run(ctx, emit) {
    const classGuids = new Set<string>()
    for (const cls of classes(ctx.championship)) {
      for (const s of claimedSlots(cls.Entrants)) {
        const g = normGuid(s.entrant.GUID)
        if (g) classGuids.add(g)
      }
    }
    if (classGuids.size === 0) return

    events(ctx.championship).forEach((ev, i) => {
      const eventGuids = new Set(
        claimedSlots(ev.EntryList).map((s) => normGuid(s.entrant.GUID)).filter(Boolean),
      )
      const missing = [...classGuids].filter((g) => !eventGuids.has(g))
      const extra = [...eventGuids].filter((g) => !classGuids.has(g))
      if (missing.length === 0 && extra.length === 0) return

      const label = eventLabel(ev, i + 1)
      const nameOf = (guid: string) => guidName(ctx, guid) ?? guid
      const parts: string[] = []
      if (missing.length) {
        parts.push(`${humanList(missing.map(nameOf))} ${pluralize(missing.length, "is", "are")} in the championship but not in this event`)
      }
      if (extra.length) {
        parts.push(`${humanList(extra.map(nameOf))} ${pluralize(extra.length, "is", "are")} in this event but not in the championship`)
      }
      emit(
        "WARN",
        "entry.event-differs-from-class",
        `${cap(label)} doesn't match the championship entry list: ${parts.join("; ")}.`,
        { round: i + 1, event: label, path: `Events[${i}].EntryList` },
        { missing, extra },
      )
    })
  },
}

function guidName(ctx: CheckContext, guid: string): string | undefined {
  for (const cls of classes(ctx.championship)) {
    for (const s of slots(cls.Entrants)) {
      if (normGuid(s.entrant.GUID) === guid && s.entrant.Name) return s.entrant.Name
    }
  }
  for (const ev of events(ctx.championship)) {
    for (const s of slots(ev.EntryList)) {
      if (normGuid(s.entrant.GUID) === guid && s.entrant.Name) return s.entrant.Name
    }
  }
  return undefined
}

export const duplicateSkins: Check = {
  id: "entry.duplicate-skin",
  section: "6.1",
  run(ctx, emit) {
    for (const { list, label, location } of allLists(ctx)) {
      // The flag is per-event; for class lists fall back to the strictest
      // setting any event uses, since the class list feeds all of them.
      const allowDupes = allowsDuplicateSkins(ctx, location.round)
      if (allowDupes) continue

      const claimed = claimedSlots(list)
      // Same skin on different models is fine — skins are per-model folders.
      const dupes = duplicates(claimed, (s) => {
        const skin = (s.entrant.Skin ?? "").trim()
        const model = (s.entrant.Model ?? "").trim()
        return skin && model ? `${model}/${skin}` : undefined
      })
      if (dupes.size === 0) continue

      for (const [key, ss] of dupes) {
        const who = ss.map((s) => s.entrant.Name || s.key)
        emit(
          "ERROR",
          "entry.duplicate-skin",
          `${humanList(who)} are all using the ${key.split("/").slice(1).join("/")} skin in ${label}, and duplicate skins are turned off.`,
          location,
          { skin: key, entrants: who },
        )
      }
    }
  },
}

function allowsDuplicateSkins(ctx: CheckContext, round: number | undefined): boolean {
  const evs = events(ctx.championship)
  if (round != null) return evs[round - 1]?.RaceSetup?.AllowDuplicateSkinChoices === true
  if (evs.length === 0) return ctx.profile.baseline.raceSetup?.AllowDuplicateSkinChoices === true
  return evs.every((ev) => ev.RaceSetup?.AllowDuplicateSkinChoices === true)
}

export const duplicateRaceNumbers: Check = {
  id: "entry.duplicate-race-number",
  section: "6.1",
  run(ctx, emit) {
    // ACSM has no race number field, so this only runs for a league that has
    // told us how its skin names encode one. Without that the check would find
    // a "duplicate" in every entry list.
    const pattern = ctx.profile.entryList.raceNumberFromSkin
    if (!pattern) return
    let re: RegExp
    try {
      re = new RegExp(pattern)
    } catch {
      emit(
        "WARN",
        "entry.race-number-pattern",
        `The league profile's race number pattern isn't a valid expression, so I skipped the duplicate number check.`,
        { path: "entryList.raceNumberFromSkin" },
        { pattern },
      )
      return
    }

    for (const { list, label, location } of allLists(ctx)) {
      const dupes = duplicates(claimedSlots(list), (s) => raceNumber(s, re))
      if (dupes.size === 0) continue
      const numbers = [...dupes.keys()].sort()
      emit(
        "WARN",
        "entry.duplicate-race-number",
        `${cap(label)} has two or more cars sharing race ${pluralize(numbers.length, "number")} ${humanList(numbers)}.`,
        location,
        {
          numbers,
          entrants: Object.fromEntries(
            [...dupes].map(([n, ss]) => [n, ss.map((s) => s.entrant.Name || s.key)]),
          ),
        },
      )
    }
  },
}

/** Applies the league's skin-naming convention. Undefined when it doesn't match. */
function raceNumber(s: Slot, re: RegExp): string | undefined {
  const skin = (s.entrant.Skin ?? "").trim()
  if (!skin) return undefined
  const m = re.exec(skin)
  // Prefer the capture group; fall back to the whole match for a bare pattern.
  const raw = m?.[1] ?? m?.[0]
  return raw ? String(Number(raw)) : undefined
}

export const entryListLengthVaries: Check = {
  id: "entry.length-varies",
  section: "6.1",
  run(ctx, emit) {
    const evs = events(ctx.championship)
    if (evs.length < 2) return
    const sizes = evs.map((ev, i) => ({ round: i + 1, label: eventLabel(ev, i + 1), n: slots(ev.EntryList).length }))
    const distinct = new Set(sizes.map((s) => s.n))
    if (distinct.size <= 1) return

    const detail = sizes.map((s) => `${s.label} has ${s.n}`).join(", ")
    emit(
      "WARN",
      "entry.length-varies",
      `The events don't all have the same number of entry list slots: ${detail}.`,
      { path: "Events[].EntryList" },
      { sizes },
    )
  },
}

export const signUpsExceedSlots: Check = {
  id: "signup.exceeds-slots",
  section: "6.1",
  run(ctx, emit) {
    const accepted = acceptedSignUps(ctx.championship)
    if (accepted.length === 0) return

    for (const { list, label, location } of allLists(ctx)) {
      const total = slots(list).length
      if (total === 0) continue
      const free = slots(list).filter((s) => isUnclaimed(s.entrant)).length
      const claimed = total - free
      if (accepted.length <= total) continue
      emit(
        "WARN",
        "signup.exceeds-slots",
        `${accepted.length} sign-ups have been accepted but ${label} only has ${total} ${pluralize(total, "slot")} (${claimed} already taken).`,
        location,
        { accepted: accepted.length, total, claimed },
      )
    }
  },
}

/**
 * Under a locked race entry list, an accepted sign-up with no slot is someone
 * who literally cannot join the race (plan §4.4).
 */
export const acceptedSignUpWithoutSlot: Check = {
  id: "signup.no-slot",
  section: "6.1",
  run(ctx, emit) {
    const accepted = acceptedSignUps(ctx.championship)
    if (accepted.length === 0) return

    events(ctx.championship).forEach((ev, i) => {
      const locked = ev.RaceSetup?.EntryListType === 1
      if (!locked) return
      const guids = new Set(
        slots(ev.EntryList).map((s) => normGuid(s.entrant.GUID)).filter(Boolean),
      )
      const stranded = accepted.filter((r) => {
        const g = normGuid(r.GUID)
        return g && !guids.has(g)
      })
      if (stranded.length === 0) return

      const label = eventLabel(ev, i + 1)
      const who = stranded.map((r) => r.Name || r.GUID || "someone")
      emit(
        "WARN",
        "signup.no-slot",
        `${humanList(who)} ${pluralize(who.length, "was", "were")} accepted but ${pluralize(who.length, "has", "have")} no slot in ${label}, so ${pluralize(who.length, "they can't", "they can't")} join the race.`,
        { round: i + 1, event: label, path: `Events[${i}].EntryList` },
        { guids: stranded.map((r) => r.GUID) },
      )
    })
  },
}

/**
 * Unclaimed slots in a multi-model class must carry the `any_car_model`
 * sentinel, or a sign-up can't resolve into them (plan §4.4).
 */
export const unclaimedSlotNotSentinel: Check = {
  id: "entry.unclaimed-not-sentinel",
  section: "6.1",
  run(ctx, emit) {
    const multi = classes(ctx.championship).some(isMultiModel)
    if (!multi) return

    for (const { list, label, location } of allLists(ctx)) {
      const wrong = slots(list).filter(
        (s) => isUnclaimed(s.entrant) && !isAnyCarModel(s.entrant) && (s.entrant.Model ?? "").trim(),
      )
      if (wrong.length === 0) continue
      const models = [...new Set(wrong.map((s) => s.entrant.Model!.trim()))]
      emit(
        "WARN",
        "entry.unclaimed-not-sentinel",
        `${cap(label)} has ${wrong.length} empty ${pluralize(wrong.length, "slot")} pinned to ${humanList(models)} instead of ${ANY_CAR_MODEL}, so sign-ups in other cars can't take ${pluralize(wrong.length, "it", "them")}.`,
        location,
        { slots: wrong.map((s) => s.key), models },
      )
    }
  },
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export const entryChecks: readonly Check[] = [
  duplicatePitBox,
  spectatorPitBoxCollision,
  maxClientsExceedsPits,
  pitBoxBeyondTrackCapacity,
  modelNotInClass,
  raceSetupCarsMismatch,
  eventListDiffersFromClass,
  duplicateSkins,
  duplicateRaceNumbers,
  entryListLengthVaries,
  signUpsExceedSlots,
  acceptedSignUpWithoutSlot,
  unclaimedSlotNotSentinel,
]

// Re-exported for the emit signature's benefit; keeps imports honest.
export type { Emit }
