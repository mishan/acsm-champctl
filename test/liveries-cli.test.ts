import { zipSync } from "fflate"
import { describe, expect, it } from "vitest"

import { UsageError, parseArgs, renderPlan } from "../src/cli/liveries.js"
import type { Entrant } from "../src/acsm/types.js"
import { readLiveryPack } from "../src/liveries/pack.js"
import { planLiveries } from "../src/liveries/plan.js"
import { championship, championshipClass, entryList, raceEvent } from "./support/build.js"

const CAR = "rss_formula_hybrid_2021"
const bytes = (s: string) => new TextEncoder().encode(s)
const skin = () => zipSync({ "livery.dds": bytes("x"), "ui_skin.json": bytes("{}") })

const person = (over: Partial<Entrant>): Partial<Entrant> => ({ Model: CAR, Skin: "", ...over })

describe("champctl-liveries arguments", () => {
  it("takes a championship id and a pack", () => {
    expect(parseArgs(["abc", "--zip", "pack.zip"])).toMatchObject({
      championshipId: "abc",
      zip: "pack.zip",
      push: false,
    })
  })

  it("defaults to a preview", () => {
    // The destructive option is the one you have to type, not the one you
    // forget to turn off.
    expect(parseArgs(["abc", "--zip", "p.zip"]).push).toBe(false)
    expect(parseArgs(["abc", "--zip", "p.zip", "--push"]).push).toBe(true)
  })

  it("reads a restart round", () => {
    expect(parseArgs(["abc", "--zip", "p.zip", "--restart", "2"]).restart).toBe(2)
  })

  it("refuses a restart round that is not a round number", () => {
    for (const bad of ["0", "-1", "two", "1.5", ""]) {
      expect(() => parseArgs(["abc", "--zip", "p.zip", "--restart", bad]), bad).toThrowError(
        UsageError,
      )
    }
  })

  it("refuses an option value that is obviously another option", () => {
    // `--zip --push` would otherwise read "--push" as a filename and silently
    // drop the flag, so the write never happens and nothing says why.
    expect(() => parseArgs(["abc", "--zip", "--push"])).toThrowError(/looks like another option/)
  })

  it("refuses an unknown option", () => {
    expect(() => parseArgs(["abc", "--zip", "p.zip", "--force"])).toThrowError(
      /Unknown option --force/,
    )
  })

  it("refuses a second positional, which is usually a forgotten --zip", () => {
    expect(() => parseArgs(["abc", "pack.zip"])).toThrowError(/The pack goes after --zip/)
  })

  it("prints usage on --help without needing anything else", () => {
    expect(parseArgs(["--help"])).toMatchObject({ help: true })
  })
})

describe("rendering a livery plan", () => {
  const champ = (entrants: Partial<Entrant>[], events = [raceEvent({ EntryList: {} })]) =>
    championship({
      Name: "September 2026",
      Classes: [championshipClass({ Entrants: entryList(entrants) })],
      Events: events,
    })

  const packOf = (...drivers: string[]) =>
    readLiveryPack(zipSync(Object.fromEntries(drivers.map((d) => [`${CAR}/${d}.zip`, skin()]))))

  it("shows the skin each driver moves from and to", () => {
    const plan = planLiveries(
      champ([person({ Name: "Misha", Skin: "misha_old" })]),
      "champ-1",
      packOf("Misha"),
    )
    const out = renderPlan(plan)
    expect(out).toContain("September 2026 — liveries")
    expect(out).toContain("misha_old → Misha")
  })

  it("says (no skin) rather than printing nothing", () => {
    const plan = planLiveries(champ([person({ Name: "Misha" })]), "champ-1", packOf("Misha"))
    expect(renderPlan(plan)).toContain("(no skin) → Misha")
  })

  it("lists the drivers who are already assigned separately", () => {
    const plan = planLiveries(
      champ([person({ Name: "Misha", Skin: "Misha" }), person({ Name: "postaL" })]),
      "champ-1",
      packOf("Misha", "postaL"),
    )
    const out = renderPlan(plan)
    expect(out).toContain("Already assigned, nothing to do: Misha")
    expect(out).toContain("(no skin) → postaL")
  })

  it("warns loudly about a round the change would not reach", () => {
    // The failure this exists to prevent: the write lands in the database and
    // the race still runs the old livery.
    const uuid = "11111111-1111-1111-1111-111111111111"
    const plan = planLiveries(
      champ(
        [person({ Name: "Misha", InternalUUID: uuid })],
        [
          raceEvent({
            EntryList: entryList([person({ Name: "Misha", InternalUUID: uuid })]),
          }),
        ],
      ),
      "champ-1",
      packOf("Misha"),
    )
    expect(renderPlan(plan)).toContain("Rounds 1 keep their own entry-list skins")
  })

  it("says nothing about unreachable rounds when there are none", () => {
    const plan = planLiveries(champ([person({ Name: "Misha" })]), "champ-1", packOf("Misha"))
    expect(renderPlan(plan)).not.toContain("keep their own entry-list skins")
  })

  it("mentions rounds that have already been raced, and that it is cosmetic", () => {
    const plan = planLiveries(
      champ(
        [person({ Name: "Misha" })],
        [raceEvent({ EntryList: {}, StartedTime: "2026-09-02T20:00:00Z" })],
      ),
      "champ-1",
      packOf("Misha"),
    )
    expect(renderPlan(plan)).toContain("Rounds 1 have already been raced")
  })

  it("names the practice restart when one was asked for", () => {
    const plan = planLiveries(champ([person({ Name: "Misha" })]), "champ-1", packOf("Misha"))
    expect(renderPlan(plan, 2)).toContain("restart round 2's looping practice server")
    expect(renderPlan(plan)).not.toContain("looping practice server")
  })

  it("says so when there is nothing to change", () => {
    const plan = planLiveries(
      champ([person({ Name: "Misha", Skin: "Misha" })]),
      "champ-1",
      packOf("Misha"),
    )
    expect(renderPlan(plan)).toContain("every livery in the pack is already assigned")
  })
})
