/**
 * Standings, from ACSM if it will say and from the export if not.
 *
 * The tests that matter most here are the *refusals*. Four things about ACSM's
 * scoring have never been measured against a real manager, and each would
 * change every number in the table — so the fallback has to decline rather than
 * produce something plausible. A wrong standings table posted to a league is
 * the worst thing this half of the bot can do.
 */

import { describe, expect, it } from "vitest"

import type { Championship, ChampionshipEvent } from "../src/acsm/types.js"
import { standingsMessage } from "../src/bot/message.js"
import { MESSAGE_LIMIT } from "../src/bot/transport.js"
import {
  compareStandings,
  computeStandings,
  isUnscorable,
  parseStandings,
  ranked,
  type StandingsClass,
} from "../src/bot/standings.js"
import { championship, championshipClass, raceEvent } from "./support/build.js"

/** A raced round whose Race session carries a finishing order. */
const racedRound = (order: string[], over: Partial<ChampionshipEvent> = {}): ChampionshipEvent =>
  raceEvent({
    StartedTime: "2026-08-05T19:00:00-07:00",
    Sessions: {
      RACE: {
        Name: "Race",
        StartedTime: "2026-08-05T19:00:00-07:00",
        Results: { Result: order.map((name) => ({ DriverName: name })) },
      },
    },
    ...over,
  })

/** Points for the first three places and nothing else set. */
const placesOnly = (places = [25, 18, 15]) =>
  championshipClass({ Points: { Places: places, BestLap: 0, PolePosition: 0 } })

const scorable = (over: Partial<Championship> = {}): Championship =>
  championship({
    Classes: [placesOnly()],
    Events: [racedRound(["ada", "bo", "cy"])],
    IgnoreXWorstEvents: 0,
    ...over,
  })

const rowsOf = (v: StandingsClass[] | { scorable: false; reason: string }) => {
  if (isUnscorable(v)) throw new Error(`expected scorable, got: ${v.reason}`)
  return v[0]!.rows
}

describe("scoring from the export", () => {
  it("awards points down the finishing order", () => {
    expect(rowsOf(computeStandings(scorable()))).toEqual([
      { position: 1, driver: "ada", points: 25 },
      { position: 2, driver: "bo", points: 18 },
      { position: 3, driver: "cy", points: 15 },
    ])
  })

  it("adds up across rounds", () => {
    const c = scorable({
      Events: [racedRound(["ada", "bo"]), racedRound(["bo", "ada"])],
    })
    expect(rowsOf(computeStandings(c))).toEqual([
      { position: 1, driver: "ada", points: 43 },
      { position: 1, driver: "bo", points: 43 },
    ])
  })

  it("promotes everyone behind a disqualification", () => {
    // ACSM's Result[] is the order as classified, so dropping a DSQ is what
    // moves the next driver into the points they were actually awarded.
    // Scoring the DSQ zero and leaving everyone in place would give bo 18.
    const c = scorable({
      Events: [
        raceEvent({
          StartedTime: "2026-08-05T19:00:00-07:00",
          Sessions: {
            RACE: {
              Results: {
                Result: [
                  { DriverName: "ada", Disqualified: true },
                  { DriverName: "bo" },
                  { DriverName: "cy" },
                ],
              },
            },
          },
        }),
      ],
    })
    expect(rowsOf(computeStandings(c))).toEqual([
      { position: 1, driver: "bo", points: 25 },
      { position: 2, driver: "cy", points: 18 },
    ])
  })

  it("scores nothing for a place the points table doesn't reach", () => {
    const c = scorable({
      Classes: [placesOnly([25, 18])],
      Events: [racedRound(["ada", "bo", "cy"])],
    })
    expect(rowsOf(computeStandings(c)).find((r) => r.driver === "cy")?.points).toBe(0)
  })
})

describe("what the export cannot be scored for", () => {
  const reasonFor = (c: Championship): string => {
    const out = computeStandings(c)
    if (!isUnscorable(out)) throw new Error("expected a refusal")
    return out.reason
  }

  it("refuses a championship running more than one class", () => {
    // Every class was scored off the *overall* finishing order, so both classes
    // came back holding the same rows and the GT4 driver who finished third on
    // the road took third-place points in the GT3 table too. Filtering the
    // class's entrants fixes half of that and guesses at the other half.
    const c = scorable({
      Classes: [
        championshipClass({ Name: "GT3", Points: { Places: [25, 18, 15] } }),
        championshipClass({ Name: "GT4", Points: { Places: [25, 18, 15] } }),
      ],
      Events: [racedRound(["gt3-ada", "gt3-bo", "gt4-cy"])],
    })
    expect(reasonFor(c)).toMatch(/runs 2 classes/)
  })

  it("refuses a championship that drops its worst rounds", () => {
    // Something is dropped; which rounds, and whether per driver or per
    // championship, is written down nowhere.
    expect(reasonFor(scorable({ IgnoreXWorstEvents: 1 }))).toMatch(/drops its 1 worst round/)
  })

  it("refuses one with penalty points configured", () => {
    const c = scorable({
      Classes: [championshipClass({ Points: { Places: [25], CollisionWithDriver: -5 } })],
    })
    expect(reasonFor(c)).toMatch(/CollisionWithDriver/)
  })

  it("refuses a reversed-grid round, which is BATL's own 2x20", () => {
    const c = scorable({
      Events: [racedRound(["ada"], { RaceSetup: { ReversedGridRacePositions: 5 } })],
    })
    expect(reasonFor(c)).toMatch(/second race/)
  })

  it("says so when nothing has been raced yet", () => {
    expect(reasonFor(scorable({ Events: [raceEvent()] }))).toMatch(/No round has been raced/)
  })

  it("names what champctl would need, so the refusal is a to-do and not a shrug", () => {
    expect(reasonFor(scorable({ IgnoreXWorstEvents: 2 }))).toMatch(/never measured/)
  })
})

describe("parsing whatever standings.json answers with", () => {
  it("reads a class-wrapped shape", () => {
    const parsed = parseStandings({
      Classes: [{ Name: "RSS", Standings: [{ DriverName: "ada", Points: 43 }] }],
    })
    expect(parsed).toEqual([{ name: "RSS", rows: [{ position: 1, driver: "ada", points: 43 }] }])
  })

  it("reads lowercase keys, because the listing endpoint already taught us that", () => {
    // 2.4.15 answers /api/championships/list.json in lowercase where the export
    // uses ID and Name, and champctl read only the capitalised spelling — every
    // entry silently lost its id. Assuming one casing for a response nobody has
    // measured would be repeating that on purpose.
    const parsed = parseStandings({
      classes: [{ name: "RSS", standings: [{ driver: { name: "ada" }, points: 43 }] }],
    })
    expect(parsed?.[0]?.rows[0]).toEqual({ position: 1, driver: "ada", points: 43 })
  })

  it("reads a flat array with no class layer", () => {
    const parsed = parseStandings([{ DriverName: "ada", Points: 43 }])
    expect(parsed?.[0]?.rows).toHaveLength(1)
  })

  it("returns undefined rather than guessing at a shape it doesn't know", () => {
    // Undefined means "I don't recognise this", which is the honest answer for
    // a response whose shape has never been measured. A hopeful dig through an
    // unfamiliar object posts a made-up table.
    expect(
      parseStandings({ Classes: [{ Name: "RSS", Standings: [{ who: "ada", pts: 43 }] }] }),
    ).toBeUndefined()
    expect(parseStandings("nope")).toBeUndefined()
    expect(parseStandings(null)).toBeUndefined()
    expect(parseStandings({ unrelated: true })).toBeUndefined()
  })

  it("refuses the whole response when one row is unreadable", () => {
    // Half a standings table is worse than none: it looks complete.
    const parsed = parseStandings({
      Classes: [{ Name: "RSS", Standings: [{ DriverName: "ada", Points: 43 }, { junk: true }] }],
    })
    expect(parsed).toBeUndefined()
  })
})

describe("ranking", () => {
  it("gives equal points the same position, and skips the next", () => {
    // Two drivers on 40 are both second and the next is fourth. Numbering them
    // 2 and 3 invents a gap the season doesn't have.
    expect(
      ranked([
        { position: 0, driver: "a", points: 50 },
        { position: 0, driver: "b", points: 40 },
        { position: 0, driver: "c", points: 40 },
        { position: 0, driver: "d", points: 10 },
      ]).map((r) => r.position),
    ).toEqual([1, 2, 2, 4])
  })
})

describe("the cross-check between the two sources", () => {
  const acsm: StandingsClass[] = [
    { name: "RSS", rows: [{ position: 1, driver: "ada", points: 43 }] },
  ]

  it("says nothing when they agree", () => {
    expect(compareStandings(acsm, acsm)).toEqual([])
  })

  it("names the driver and both numbers when they don't", () => {
    const mine: StandingsClass[] = [
      { name: "RSS", rows: [{ position: 1, driver: "ada", points: 40 }] },
    ]
    expect(compareStandings(acsm, mine)).toEqual([
      "ada: ACSM says 43 points, champctl worked out 40",
    ])
  })

  it("notices a driver champctl missed entirely", () => {
    expect(compareStandings(acsm, [{ name: "RSS", rows: [] }])).toEqual([
      "ada is in ACSM's standings and not in champctl's",
    ])
  })
})

describe("the standings message", () => {
  const big = (n: number): StandingsClass => ({
    name: "RSS Formula Hybrid",
    rows: Array.from({ length: n }, (_, i) => ({
      position: i + 1,
      driver: `driver-with-a-long-name-${i}`,
      points: 100 - i,
    })),
  })

  it("says where the numbers came from when champctl worked them out", () => {
    const [msg] = standingsMessage("August 2026", { source: "export", classes: [big(3)] })
    expect(msg).toContain("Worked out from the championship export")
  })

  it("says nothing extra when ACSM did the sums", () => {
    const [msg] = standingsMessage("August 2026", { source: "endpoint", classes: [big(3)] })
    expect(msg).not.toContain("Worked out from")
  })

  it("splits a long table rather than posting nothing", () => {
    const messages = standingsMessage("August 2026", { source: "endpoint", classes: [big(60)] })
    expect(messages.length).toBeGreaterThan(1)
    for (const m of messages) expect(m.length).toBeLessThanOrEqual(2000)
  })

  it("keeps every driver across the split", () => {
    const cls = big(60)
    const joined = standingsMessage("August 2026", {
      source: "endpoint",
      classes: [cls],
    }).join("\n")
    for (const row of cls.rows) expect(joined).toContain(row.driver)
  })

  it("does not call a second class's first table a continuation", () => {
    // The count was global across classes, so the first table of the second
    // class was headed "(continued)" — GT4's points reading as more of GT3's,
    // which is what the repeated heading exists to prevent.
    const one = (name: string): StandingsClass => ({
      name,
      rows: [{ position: 1, driver: "ada", points: 25 }],
    })
    const messages = standingsMessage("August 2026", {
      source: "endpoint",
      classes: [one("GT3"), one("GT4")],
    })

    expect(messages).toHaveLength(2)
    expect(messages[1]).toContain("**August 2026 — GT4**")
    expect(messages[1]).not.toContain("(continued)")
  })

  it("measures the message it will send rather than estimating it", () => {
    // The estimate allowed twenty characters for the fences and the heading
    // where a continuation needs twenty-one, so a table landing exactly on the
    // boundary posted 2001 characters — refused outright, losing the table.
    //
    // Swept rather than pinned to one row count: the arithmetic only lands on
    // the boundary for particular widths, and a single magic fixture would stop
    // testing this the moment a line's width changed.
    const over: string[] = []
    for (let subject = 1; subject <= 40; subject++) {
      for (let n = 130; n <= 145; n++) {
        const cls: StandingsClass = {
          name: "C",
          rows: Array.from({ length: n }, () => ({
            position: 1,
            driver: "d".repeat(12),
            points: 100,
          })),
        }
        const messages = standingsMessage("s".repeat(subject), {
          source: "endpoint",
          classes: [cls],
        })
        for (const m of messages) {
          if (m.length > MESSAGE_LIMIT) over.push(`subject ${subject}, ${n} rows: ${m.length}`)
        }
      }
    }
    expect(over).toEqual([])
  })

  it("lines the points up under each other whatever the names are", () => {
    // The name column was a hardcoded pad of 20 sitting next to a points width
    // measured off the rows, so a single name past the pad pushed that row's
    // points out of line with every other row in the table.
    const cls: StandingsClass = {
      name: "RSS",
      rows: [
        { position: 1, driver: "ada", points: 43 },
        { position: 2, driver: "a-driver-with-a-longer-name", points: 30 },
      ],
    }
    const [msg] = standingsMessage("August 2026", { source: "endpoint", classes: [cls] })
    const rows = msg!.split("\n").filter((l) => /^\s*\d+\. /.test(l))

    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((l) => l.length)).size).toBe(1)
  })

  it("posts nothing for a class nobody has scored in", () => {
    expect(standingsMessage("August 2026", { source: "endpoint", classes: [] })).toEqual([])
    expect(
      standingsMessage("August 2026", { source: "endpoint", classes: [{ name: "RSS", rows: [] }] }),
    ).toEqual([])
  })
})
