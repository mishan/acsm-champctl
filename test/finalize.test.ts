import { DateTime } from "luxon"
import { describe, expect, it } from "vitest"

import { AcsmSession } from "../src/acsm/session.js"
import type { ChampionshipEvent } from "../src/acsm/types.js"
import { applyFinalize, EntryListChangedError } from "../src/finalize/apply.js"
import {
  applyFormat,
  describeLength,
  formFieldsFor,
  readFormat,
  sameFormat,
  type RaceFormat,
} from "../src/finalize/format.js"
import {
  describeChanges,
  entryListFingerprint,
  FinalizeError,
  planFinalize,
} from "../src/finalize/plan.js"
import {
  currentQualiStart,
  practiceMinutesFor,
  qualiStartFrom,
  scheduledFromQuali,
  scheduleFormValues,
  ScheduleError,
} from "../src/finalize/schedule.js"
import {
  championship,
  driver,
  entryList,
  pitTable,
  raceEvent,
  suzukaPits,
  testProfile,
} from "./support/build.js"

const ZONE = "America/Los_Angeles"

const format = (over: Partial<RaceFormat> = {}): RaceFormat => ({
  length: { kind: "laps", laps: 18 },
  reversedGridPositions: 0,
  mandatoryPit: false,
  extraLap: false,
  ...over,
})

// ---------------------------------------------------------------------------
// Format
// ---------------------------------------------------------------------------

describe("reading a format off an event", () => {
  it("reads laps, reversed grid, pit window and extra lap", () => {
    const ev = raceEvent({
      RaceSetup: {
        RacePitWindowStart: 1,
        ReversedGridRacePositions: 5,
        RaceExtraLap: true,
        Sessions: { Race: { Name: "Race", Time: 0, Laps: 20, IsOpen: 1 } },
      },
    })
    expect(readFormat(ev)).toEqual({
      length: { kind: "laps", laps: 20 },
      reversedGridPositions: 5,
      mandatoryPit: true,
      extraLap: true,
    })
  })

  it("reads a timed race as minutes", () => {
    const ev = raceEvent({
      RaceSetup: { Sessions: { Race: { Name: "Race", Time: 40, Laps: 0, IsOpen: 1 } } },
    })
    expect(readFormat(ev).length).toEqual({ kind: "minutes", minutes: 40 })
  })

  it("prefers laps when both are set, as ACSM does", () => {
    // ACSM treats a non-zero lap count as the length and ignores Time, so
    // reporting 40 minutes here would describe a race that won't happen.
    const ev = raceEvent({
      RaceSetup: { Sessions: { Race: { Name: "Race", Time: 40, Laps: 18, IsOpen: 1 } } },
    })
    expect(readFormat(ev).length).toEqual({ kind: "laps", laps: 18 })
  })

  it("finds the race session under the upper-case key a real export uses", () => {
    // Live 1.7.9 exports key the map PRACTICE/QUALIFY/RACE; the fixtures use
    // the friendly spellings. Both have to work or the format reads as empty.
    const ev = raceEvent({
      RaceSetup: { Sessions: { RACE: { Name: "Race", Time: 0, Laps: 22, IsOpen: 1 } } },
    })
    expect(readFormat(ev).length).toEqual({ kind: "laps", laps: 22 })
  })

  it("reads a race with no length set as zero rather than throwing", () => {
    const ev = raceEvent({ RaceSetup: { Sessions: {} } })
    expect(readFormat(ev).length).toEqual({ kind: "minutes", minutes: 0 })
  })

  it("treats a missing pit window as no mandatory stop", () => {
    expect(readFormat(raceEvent({ RaceSetup: {} })).mandatoryPit).toBe(false)
  })
})

describe("mapping a format onto form fields", () => {
  it("zeroes the other half of the length", () => {
    // Switching a timed race to laps has to clear the minutes, or ACSM keeps
    // both and the export no longer says which applies.
    expect(formFieldsFor(format({ length: { kind: "laps", laps: 18 } }))).toMatchObject({
      "Race.Laps": "18",
      "Race.Time": "0",
    })
    expect(formFieldsFor(format({ length: { kind: "minutes", minutes: 40 } }))).toMatchObject({
      "Race.Laps": "0",
      "Race.Time": "40",
    })
  })

  it("writes mandatoryPit as the pit window opening lap", () => {
    expect(formFieldsFor(format({ mandatoryPit: true }))["RacePitWindowStart"]).toBe("1")
    expect(formFieldsFor(format({ mandatoryPit: false }))["RacePitWindowStart"]).toBe("0")
  })

  it("writes RaceExtraLap as a value, not by adding and removing the key", () => {
    // The recon capture shows RaceExtraLap present exactly once while the seed
    // championship has it false — so presence does not mean checked, and
    // browser checkbox semantics would have silently inverted the setting.
    expect(formFieldsFor(format({ extraLap: false }))["RaceExtraLap"]).toBe("0")
    expect(formFieldsFor(format({ extraLap: true }))["RaceExtraLap"]).toBe("1")
  })
})

describe("applying a format to an event", () => {
  it("does not mutate the event it was given", () => {
    const ev = raceEvent({
      RaceSetup: { Sessions: { Race: { Name: "Race", Time: 0, Laps: 20, IsOpen: 1 } } },
    })
    const before = JSON.stringify(ev)
    applyFormat(ev, format({ length: { kind: "laps", laps: 18 } }))
    expect(JSON.stringify(ev)).toBe(before)
  })

  it("writes back under the key the export actually uses", () => {
    // Adding a "Race" beside an existing "RACE" would leave two race sessions,
    // and readFormat would then answer from whichever came first.
    const ev = raceEvent({
      RaceSetup: { Sessions: { RACE: { Name: "Race", Time: 0, Laps: 20, IsOpen: 1 } } },
    })
    const after = applyFormat(ev, format({ length: { kind: "laps", laps: 18 } }))
    expect(Object.keys(after.RaceSetup?.Sessions ?? {})).toEqual(["RACE"])
    expect(after.RaceSetup?.Sessions?.["RACE"]?.Laps).toBe(18)
  })

  it("round-trips through readFormat", () => {
    const ev = raceEvent({
      RaceSetup: { Sessions: { Race: { Name: "Race", Time: 0, Laps: 1, IsOpen: 1 } } },
    })
    const wanted = format({
      length: { kind: "minutes", minutes: 40 },
      reversedGridPositions: 5,
      mandatoryPit: true,
      extraLap: true,
    })
    expect(sameFormat(readFormat(applyFormat(ev, wanted)), wanted)).toBe(true)
  })
})

describe("the diff a person reads", () => {
  it("names only what changed", () => {
    const changes = describeChanges(
      format({ length: { kind: "minutes", minutes: 40 }, mandatoryPit: true }),
      format({ length: { kind: "laps", laps: 18 }, mandatoryPit: true }),
    )
    expect(changes).toEqual([
      { label: "Race length", before: "40 minutes", after: "18 laps" },
    ])
  })

  it("is empty when nothing changed", () => {
    expect(describeChanges(format(), format())).toEqual([])
  })

  it("says what a reversed grid means rather than printing a number", () => {
    const changes = describeChanges(format(), format({ reversedGridPositions: 5 }))
    expect(changes[0]).toEqual({
      label: "Reversed grid",
      before: "off (single race)",
      after: "top 5 reversed",
    })
  })

  it("gets singular and plural right", () => {
    expect(describeLength({ kind: "laps", laps: 1 })).toBe("1 lap")
    expect(describeLength({ kind: "laps", laps: 18 })).toBe("18 laps")
    expect(describeLength({ kind: "minutes", minutes: 1 })).toBe("1 minute")
  })
})

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

describe("schedule maths", () => {
  it("derives practice start by subtracting the practice length", () => {
    const quali = qualiStartFrom("2026-09-02", "20:00", ZONE)
    expect(scheduledFromQuali(quali, 60).toFormat("yyyy-MM-dd HH:mm")).toBe("2026-09-02 19:00")
  })

  it("keeps the wall clock across the November DST boundary", () => {
    // The whole reason the maths is done in the zone. A league races at 8pm
    // local all season; the offset changes underneath it.
    const before = qualiStartFrom("2026-10-28", "20:00", ZONE)
    const after = qualiStartFrom("2026-11-04", "20:00", ZONE)
    expect(before.offset).not.toBe(after.offset)
    for (const q of [before, after]) {
      expect(scheduledFromQuali(q, 60).toFormat("HH:mm")).toBe("19:00")
    }
  })

  it("refuses a wall-clock time that does not exist", () => {
    // Spring forward: 02:30 never happens, and Luxon silently moves it to
    // 03:30 — scheduling a race an hour from where someone put it.
    expect(() => qualiStartFrom("2026-03-08", "02:30", ZONE)).toThrow(ScheduleError)
    expect(() => qualiStartFrom("2026-03-08", "02:30", ZONE)).toThrow(/does not exist/)
  })

  it("refuses a wall-clock time that happens twice", () => {
    // Fall back: 01:30 happens in both PDT and PST, and Luxon picks the first.
    expect(() => qualiStartFrom("2026-11-01", "01:30", ZONE)).toThrow(/happens twice/)
  })

  it("accepts ordinary times either side of a transition", () => {
    for (const [d, t] of [
      ["2026-03-08", "20:00"],
      ["2026-11-01", "03:30"],
      ["2026-11-01", "20:00"],
    ] as const) {
      expect(() => qualiStartFrom(d, t, ZONE), `${d} ${t}`).not.toThrow()
    }
  })

  it("prefers the event's own practice length over the league default", () => {
    // An event with a 30 minute practice would otherwise be scheduled from the
    // league's 60 and start half an hour early.
    const ev = raceEvent({
      RaceSetup: { Sessions: { Practice: { Name: "Practice", Time: 30, Laps: 0, IsOpen: 1 } } },
    })
    expect(practiceMinutesFor(ev, 60)).toBe(30)
    expect(practiceMinutesFor(raceEvent({ RaceSetup: { Sessions: {} } }), 60)).toBe(60)
  })

  it("reads the current quali start back out of Scheduled", () => {
    const ev = raceEvent({ Scheduled: "2026-09-02T19:00:00-07:00" })
    expect(currentQualiStart(ev, ZONE, 60)?.toFormat("HH:mm")).toBe("20:00")
  })

  it("treats Go's zero time as unscheduled", () => {
    // Otherwise the diff claims the race moved by two thousand years.
    const ev = raceEvent({ Scheduled: "0001-01-01T00:00:00Z" })
    expect(currentQualiStart(ev, ZONE, 60)).toBeUndefined()
  })

  it("sends the IANA zone rather than an offset", () => {
    // An offset is only correct until the clocks change; the name always is.
    const values = scheduleFormValues(
      DateTime.fromISO("2026-09-02T19:00", { zone: ZONE }),
      ZONE,
      "",
    )
    expect(values).toEqual({
      "event-schedule-date": "2026-09-02",
      "event-schedule-time": "19:00",
      "event-schedule-timezone": ZONE,
      "event-schedule-recurrence": "",
    })
  })
})

// ---------------------------------------------------------------------------
// Plan and apply, against a scripted ACSM
// ---------------------------------------------------------------------------

const EVENT_ID = "event-1"
const CHAMP_ID = "11111111-2222-3333-4444-555555555555"

function eventFormHtml(entrants: { name: string; guid: string; pit: number }[], over: Record<string, string> = {}): string {
  const base: Record<string, string> = {
    Track: "suzuka",
    "Race.Laps": "20",
    "Race.Time": "0",
    RacePitWindowStart: "0",
    ReversedGridRacePositions: "0",
    RaceExtraLap: "0",
    MaxClients: "18",
    ...over,
  }
  const scalars = Object.entries(base)
    .map(([k, v]) => `<input name="${k}" value="${v}">`)
    .join("")
  const list = entrants
    .map(
      (e) =>
        `<input name="EntryList.EntrantID" value="${e.pit}">` +
        `<input name="EntryList.Name" value="${e.name}">` +
        `<input name="EntryList.GUID" value="${e.guid}">` +
        `<input name="EntryList.Car" value="rss_formula_hybrid_2021">` +
        `<input name="EntryList.Skin" value="${e.name.toLowerCase()}_01">` +
        `<input name="EntryList.Team" value="">` +
        `<input name="EntryList.Ballast" value="0">` +
        `<input name="EntryList.Restrictor" value="0">` +
        `<input name="EntryList.FixedSetup" value="">` +
        `<input name="EntryList.InternalUUID" value="uuid-${e.pit}">`,
    )
    .join("")
  return `<html><body>
    <form action="/search" method="GET"><input name="q" value=""></form>
    <form action="/championship/${CHAMP_ID}/event/submit" method="POST">
      ${scalars}${list}
      <input name="EntryList.NumEntrants" value="${entrants.length}">
    </form>
  </body></html>`
}

const scheduleFormHtml = (recurrence = ""): string =>
  `<html><body>
    <form action="/search" method="GET"><input name="q" value=""></form>
    <form action="/championship/${CHAMP_ID}/event/${EVENT_ID}/schedule" method="POST">
      <input name="event-schedule-date" value="2026-09-02">
      <input name="event-schedule-time" value="19:00">
      <input name="event-schedule-timezone" value="${ZONE}">
      <input name="event-schedule-recurrence" value="${recurrence}">
    </form>
  </body></html>`

const TWO = [
  { name: "Ada", guid: "76561198000000001", pit: 0 },
  { name: "Grace", guid: "76561198000000002", pit: 1 },
]

interface HarnessOptions {
  /** Event HTML per GET, in order; the last is reused. */
  eventPages?: string[]
  scheduleHtml?: string
  submitStatus?: number
}

async function harness(options: HarnessOptions = {}) {
  const posts: { url: string; body: URLSearchParams }[] = []
  let eventGets = 0
  const pages = options.eventPages ?? [eventFormHtml(TWO)]

  const fetchImpl: typeof globalThis.fetch = async (input, init = {}) => {
    const url = String(input)
    if (url.endsWith("/login")) {
      return new Response("", {
        status: 302,
        headers: { "set-cookie": "_acsm_data=x; Path=/", location: "/" },
      })
    }
    if (init.method === "POST") {
      posts.push({ url, body: init.body as URLSearchParams })
      return new Response("", { status: options.submitStatus ?? 302, headers: { location: "/" } })
    }
    if (url.includes("/schedule")) {
      return new Response(options.scheduleHtml ?? scheduleFormHtml(), { status: 200 })
    }
    const page = pages[Math.min(eventGets, pages.length - 1)] as string
    eventGets++
    return new Response(page, { status: 200 })
  }

  const session = new AcsmSession({ baseUrl: "https://acsm.example", fetch: fetchImpl })
  await session.login({ username: "admin", password: "x" })
  return { session, posts, eventGets: () => eventGets }
}

const champ = (over: Partial<ChampionshipEvent> = {}) =>
  championship({
    ID: CHAMP_ID,
    Events: [
      raceEvent({
        ID: EVENT_ID,
        Scheduled: "2026-09-02T19:00:00-07:00",
        EntryList: entryList([driver("Ada"), driver("Grace")]),
        RaceSetup: { Sessions: { Race: { Name: "Race", Time: 0, Laps: 20, IsOpen: 1 } } },
        ...over,
      }),
    ],
  })

describe("planning a finalize", () => {
  it("reports the change without writing anything", async () => {
    const { session, posts } = await harness()
    const plan = await planFinalize(session, {
      championship: champ(),
      championshipId: CHAMP_ID,
      eventId: EVENT_ID,
      format: format({ length: { kind: "laps", laps: 18 } }),
      profile: testProfile(),
      pits: pitTable([suzukaPits]),
    })

    expect(posts).toHaveLength(0)
    expect(plan.round).toBe(1)
    expect(plan.changes).toEqual([
      { label: "Race length", before: "20 laps", after: "18 laps" },
    ])
    expect(plan.formChanges).toEqual([{ name: "Race.Laps", before: "20", after: "18" }])
    expect(plan.noop).toBe(false)
  })

  it("is a noop when the event already matches", async () => {
    const { session } = await harness()
    const plan = await planFinalize(session, {
      championship: champ(),
      championshipId: CHAMP_ID,
      eventId: EVENT_ID,
      format: format({ length: { kind: "laps", laps: 20 } }),
      profile: testProfile(),
      pits: pitTable([suzukaPits]),
    })
    expect(plan.noop).toBe(true)
    expect(plan.changes).toEqual([])
  })

  it("checks the championship as it would be, not as it is", async () => {
    // A duplicate pit box introduced by this change has to show up now, and a
    // problem this change fixes has to stop showing up.
    const { session } = await harness()
    const plan = await planFinalize(session, {
      championship: champ(),
      championshipId: CHAMP_ID,
      eventId: EVENT_ID,
      format: format({ length: { kind: "minutes", minutes: 0 } }),
      profile: testProfile(),
      pits: pitTable([suzukaPits]),
    })
    // A zero-length race is what gridmom's format check exists to catch.
    expect(plan.gridmom.findings.some((f) => f.code.startsWith("format."))).toBe(true)
  })

  it("refuses an event id the championship doesn't have", async () => {
    const { session } = await harness()
    await expect(
      planFinalize(session, {
        championship: champ(),
        championshipId: CHAMP_ID,
        eventId: "not-an-event",
        format: format(),
        profile: testProfile(),
      pits: pitTable([suzukaPits]),
      }),
    ).rejects.toThrow(FinalizeError)
  })

  it("says so when the page has no event form, rather than posting blind", async () => {
    const { session } = await harness({ eventPages: ["<html><body>Login</body></html>"] })
    await expect(
      planFinalize(session, {
        championship: champ(),
        championshipId: CHAMP_ID,
        eventId: EVENT_ID,
        format: format(),
        profile: testProfile(),
      pits: pitTable([suzukaPits]),
      }),
    ).rejects.toThrow(/no form posting to/)
  })

  it("plans a schedule save only when the quali time actually moves", async () => {
    const { session } = await harness()
    const unchanged = await planFinalize(session, {
      championship: champ(),
      championshipId: CHAMP_ID,
      eventId: EVENT_ID,
      format: format({ length: { kind: "laps", laps: 20 } }),
      qualiStart: { date: "2026-09-02", time: "20:00" },
      profile: testProfile(),
      pits: pitTable([suzukaPits]),
    })
    expect(unchanged.schedule).toBeUndefined()
    expect(unchanged.noop).toBe(true)

    const moved = await planFinalize(session, {
      championship: champ(),
      championshipId: CHAMP_ID,
      eventId: EVENT_ID,
      format: format({ length: { kind: "laps", laps: 20 } }),
      qualiStart: { date: "2026-09-02", time: "21:00" },
      profile: testProfile(),
      pits: pitTable([suzukaPits]),
    })
    expect(moved.schedule?.values["event-schedule-time"]).toBe("20:00") // practice start
    expect(moved.noop).toBe(false)
  })
})

describe("the entry list fingerprint", () => {
  it("ignores everything that isn't an entrant field", () => {
    const a = entryListFingerprint([
      { name: "Race.Laps", value: "18" },
      { name: "EntryList.Name", value: "Ada" },
    ])
    const b = entryListFingerprint([
      { name: "Race.Laps", value: "22" },
      { name: "EntryList.Name", value: "Ada" },
    ])
    expect(a).toBe(b)
  })

  it("notices a changed entrant", () => {
    const a = entryListFingerprint([{ name: "EntryList.Name", value: "Ada" }])
    const b = entryListFingerprint([{ name: "EntryList.Name", value: "Grace" }])
    expect(a).not.toBe(b)
  })

  it("notices two entrants swapping places", () => {
    // ACSM reads these as parallel positional arrays, so order is identity.
    const a = entryListFingerprint([
      { name: "EntryList.Name", value: "Ada" },
      { name: "EntryList.Name", value: "Grace" },
    ])
    const b = entryListFingerprint([
      { name: "EntryList.Name", value: "Grace" },
      { name: "EntryList.Name", value: "Ada" },
    ])
    expect(a).not.toBe(b)
  })

  it("notices an added entrant", () => {
    const a = entryListFingerprint([{ name: "EntryList.Name", value: "Ada" }])
    const b = entryListFingerprint([
      { name: "EntryList.Name", value: "Ada" },
      { name: "EntryList.Name", value: "Grace" },
    ])
    expect(a).not.toBe(b)
  })
})

describe("applying a finalize", () => {
  const planFor = async (
    h: Awaited<ReturnType<typeof harness>>,
    over: Partial<Parameters<typeof planFinalize>[1]> = {},
  ) =>
    planFinalize(h.session, {
      championship: champ(),
      championshipId: CHAMP_ID,
      eventId: EVENT_ID,
      format: format({ length: { kind: "laps", laps: 18 } }),
      profile: testProfile(),
      pits: pitTable([suzukaPits]),
      ...over,
    })

  it("posts the event form with only the planned fields changed", async () => {
    const h = await harness()
    const plan = await planFor(h)
    const result = await applyFinalize(h.session, plan)

    expect(result.eventSaved).toBe(true)
    expect(h.posts).toHaveLength(1)
    const body = h.posts[0]!.body
    expect(body.get("Race.Laps")).toBe("18")
    // Untouched fields are echoed back as the form rendered them.
    expect(body.get("Track")).toBe("suzuka")
    expect(body.getAll("EntryList.Name")).toEqual(["Ada", "Grace"])
  })

  it("re-fetches the form before writing", async () => {
    const h = await harness()
    const plan = await planFor(h)
    const before = h.eventGets()
    await applyFinalize(h.session, plan)
    expect(h.eventGets()).toBe(before + 1)
  })

  it("refuses when someone was added to the entry list in the meantime", async () => {
    // The sharp edge from plan §5.3: the event form is a full-list replace, so
    // saving now would silently delete the new entrant.
    const h = await harness({
      eventPages: [
        eventFormHtml(TWO),
        eventFormHtml([...TWO, { name: "Linus", guid: "76561198000000003", pit: 2 }]),
      ],
    })
    const plan = await planFor(h)
    await expect(applyFinalize(h.session, plan)).rejects.toBeInstanceOf(EntryListChangedError)
    expect(h.posts).toHaveLength(0)
  })

  it("refuses when an entrant's details changed, not just the count", async () => {
    const h = await harness({
      eventPages: [
        eventFormHtml(TWO),
        eventFormHtml([TWO[0]!, { name: "Grace", guid: "76561198000000009", pit: 1 }]),
      ],
    })
    const plan = await planFor(h)
    await expect(applyFinalize(h.session, plan)).rejects.toBeInstanceOf(EntryListChangedError)
    expect(h.posts).toHaveLength(0)
  })

  it("goes ahead when only non-entrant fields moved", async () => {
    // Someone changing the track in ACSM is not a reason to refuse; the guard
    // is about the entry list, which is the thing a full-list replace destroys.
    const h = await harness({
      eventPages: [eventFormHtml(TWO), eventFormHtml(TWO, { Track: "spa" })],
    })
    const plan = await planFor(h)
    const result = await applyFinalize(h.session, plan)
    expect(result.eventSaved).toBe(true)
    // And the fresh value is echoed rather than reverted to what we first read.
    expect(h.posts[0]!.body.get("Track")).toBe("spa")
  })

  it("does nothing at all for a noop plan", async () => {
    const h = await harness()
    const plan = await planFor(h, { format: format({ length: { kind: "laps", laps: 20 } }) })
    const result = await applyFinalize(h.session, plan)
    expect(result).toEqual({ eventSaved: false, scheduleSaved: false, formChanges: [] })
    expect(h.posts).toHaveLength(0)
  })

  it("refuses to save a plan gridmom blocks", async () => {
    const h = await harness()
    const plan = await planFor(h)
    const blocked = {
      ...plan,
      blocked: true,
      gridmom: {
        ...plan.gridmom,
        counts: { ...plan.gridmom.counts, ERROR: 1 },
        findings: [
          {
            code: "entry.duplicate-pit-box",
            severity: "ERROR" as const,
            message: "Suzuka has duplicate pit boxes at 3.",
          },
        ],
      },
    }
    await expect(applyFinalize(h.session, blocked)).rejects.toThrow(/duplicate pit boxes/)
    expect(h.posts).toHaveLength(0)
  })

  it("needs warnings acknowledged before it writes", async () => {
    const h = await harness()
    const plan = await planFor(h)
    const warned = {
      ...plan,
      gridmom: {
        ...plan.gridmom,
        counts: { ...plan.gridmom.counts, WARN: 1 },
        findings: [
          { code: "champ.x", severity: "WARN" as const, message: "Something looks off." },
        ],
      },
    }
    await expect(applyFinalize(h.session, warned)).rejects.toThrow(/acknowledgement/)
    await expect(
      applyFinalize(h.session, warned, { acknowledgeWarnings: true }),
    ).resolves.toMatchObject({ eventSaved: true })
  })

  it("saves the schedule as a second request", async () => {
    // The event submit form does not carry Scheduled (plan §5.2).
    const h = await harness()
    const plan = await planFor(h, { qualiStart: { date: "2026-09-09", time: "20:00" } })
    const result = await applyFinalize(h.session, plan)

    expect(result).toMatchObject({ eventSaved: true, scheduleSaved: true })
    expect(h.posts).toHaveLength(2)
    const schedule = h.posts[1]!
    expect(schedule.url).toContain("/schedule")
    expect(schedule.body.get("event-schedule-date")).toBe("2026-09-09")
    expect(schedule.body.get("event-schedule-time")).toBe("19:00")
  })

  it("keeps an existing recurrence rather than blanking it", async () => {
    // champctl doesn't model recurrence, so it has no business cancelling a
    // repeat someone set up in ACSM.
    const h = await harness({ scheduleHtml: scheduleFormHtml("weekly") })
    const plan = await planFor(h, { qualiStart: { date: "2026-09-09", time: "20:00" } })
    await applyFinalize(h.session, plan)
    expect(h.posts[1]!.body.get("event-schedule-recurrence")).toBe("weekly")
  })

  it("treats a 200 from the event save as a rejection", async () => {
    // ACSM re-renders with a flash rather than using a status code, so the
    // redirect is the only success signal.
    const h = await harness({ submitStatus: 200 })
    const plan = await planFor(h)
    await expect(applyFinalize(h.session, plan)).rejects.toThrow(/didn't accept the event save/)
  })
})
