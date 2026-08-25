import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { HARNESS_TRACKS, writeSyntheticTracks } from "../scripts/harness/tracks.js"

describe("synthetic track content", () => {
  let dir = ""
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "champctl-tracks-"))
  })
  afterEach(async () => {
    // Guarded because `dir` is only a real path once `mkdtemp` has returned.
    // If it throws, vitest still runs this, and a recursive force-remove of
    // "" is not something to find out about the hard way — even resolving to
    // the working directory rather than the root, deleting the checkout is a
    // worse afternoon than the failure that caused it.
    if (!dir) return
    await rm(dir, { recursive: true, force: true })
    dir = ""
  })

  it("writes a track's ui_track.json where ACSM looks for it", async () => {
    await writeSyntheticTracks(dir, [{ track: "spa", pitboxes: 30 }])
    const raw = await readFile(join(dir, "spa", "ui", "ui_track.json"), "utf8")
    expect(JSON.parse(raw)).toMatchObject({ pitboxes: "30" })
  })

  it("puts a track with layouts one level deeper, as ACSM does", async () => {
    // The pit table is keyed by track *and* layout, so a fixture set with only
    // single-layout tracks would never exercise the difference.
    await writeSyntheticTracks(dir, [{ track: "brands_hatch", layout: "indy", pitboxes: 18 }])
    const raw = await readFile(join(dir, "brands_hatch", "ui", "indy", "ui_track.json"), "utf8")
    expect(JSON.parse(raw)).toMatchObject({ pitboxes: "18" })
  })

  /**
   * Kunos writes `pitboxes` quoted, so a fixture carrying a number would let a
   * parser that only handles numbers pass here and fail on real content. The
   * fixture has to be wrong in the same way the real thing is.
   */
  it("quotes pitboxes, because real ui_track.json files do", async () => {
    await writeSyntheticTracks(dir, [{ track: "monza", pitboxes: 28 }])
    const raw = await readFile(join(dir, "monza", "ui", "ui_track.json"), "utf8")
    expect(raw).toContain('"pitboxes": "28"')
    expect(JSON.parse(raw).pitboxes).toBe("28")
  })

  it("ships a set with both shapes and a binding grid cap", async () => {
    // Suzuka's 20 is below BATL's usual grid on purpose: it is the track that
    // makes MaxClients bind, and a fixture where nothing binds would never show
    // the cap being applied.
    expect(HARNESS_TRACKS.some((t) => t.layout)).toBe(true)
    expect(HARNESS_TRACKS.some((t) => !t.layout)).toBe(true)
    expect(Math.min(...HARNESS_TRACKS.map((t) => t.pitboxes))).toBeLessThan(24)

    const written = await writeSyntheticTracks(dir)
    expect(written).toHaveLength(HARNESS_TRACKS.length)
  })
})
