import { describe, expect, it } from "vitest"

import type { ReplaySummary } from "../src/spectator/acreplay.js"
import { replayMessage } from "../src/spectator/announce.js"

const summary = (
  seconds: number,
  cars: number,
  over: Partial<ReplaySummary> = {},
): ReplaySummary => ({
  track: "interlagos_1975",
  trackConfig: "",
  session: "Practice",
  frames: 1,
  durationMs: seconds * 1000,
  cars: Array.from({ length: cars }, (_, i) => ({
    carId: i,
    model: "m",
    driver: "d",
    samples: 1,
    ownWheels: true,
  })),
  ...over,
})

describe("replayMessage", () => {
  it.each<[string, ReplaySummary, string | undefined]>([
    [
      "a practice session",
      summary(7080, 7),
      "Replay of Practice at interlagos_1975, 1 h 58 min with 7 cars: https://x/r.acreplay",
    ],
    [
      "a race on a layout",
      summary(1800, 1, { session: "Race", track: "ks_silverstone", trackConfig: "gp" }),
      "Replay of Race at ks_silverstone (gp), 30 min with 1 car: https://x/r.acreplay",
    ],
    ["a recorder restart, too short to be a session", summary(90, 7), undefined],
    ["an empty server", summary(7200, 0), undefined],
  ])("%s", (_, s, message) => {
    expect(replayMessage(s, "https://x/r.acreplay")).toBe(message)
  })
})
