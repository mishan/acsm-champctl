import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { JournalWriter, type JournalRecord } from "../src/spectator/journal.js"
import type { CarState } from "../src/spectator/protocol.js"
import { writeJournalReplay } from "../src/spectator/replay.js"

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "replay-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const state = (carId: number, timestamp: number): CarState => ({
  carId,
  seq: 0,
  timestamp,
  ping: 0,
  pos: [0, 0, 0],
  rot: [0, 0, 0],
  vel: [0, 0, 0],
  steer: 0,
  rpm: 3000,
  gear: 3,
  statusFlags: 0,
})

async function journal(records: JournalRecord[]): Promise<string> {
  const w = new JournalWriter(join(dir, "s.ndjson.gz"))
  for (const r of records) w.write(r)
  await w.close()
  return w.path
}

/** The recorder is car 0. */
const session: JournalRecord = {
  t: "session",
  at: 0,
  serverName: "test",
  track: "imola",
  trackConfig: "",
  name: "Race",
  type: 3,
  recorderCarId: 0,
}

describe("writeJournalReplay", () => {
  it("leaves the recorder's own car out of the replay", async () => {
    const path = await journal([
      session,
      ...[0, 1].flatMap((id) =>
        [0, 100].map((at): JournalRecord => ({ t: "pos", at, car: state(id, at) })),
      ),
    ])
    const summary = await writeJournalReplay(path, join(dir, "s.acreplay"), { intervalMs: 50 })
    expect(summary.cars.map((c) => c.carId)).toEqual([1])
  })

  it.each([
    ["nobody but the recorder moving", undefined, /s\.ndjson\.gz recorded no cars moving/],
    [
      "a clip outside the session",
      { fromMs: 40 * 60_000, toMs: 41 * 60_000 },
      /s\.ndjson\.gz has no car recorded in that stretch: check --from and --to/,
    ],
  ])("names the journal when there's %s", async (_, window, message) => {
    const path = await journal([session, { t: "pos", at: 0, car: state(window ? 1 : 0, 0) }])
    await expect(
      writeJournalReplay(path, join(dir, "s.acreplay"), window ? { window } : {}),
    ).rejects.toThrow(message)
  })
})
