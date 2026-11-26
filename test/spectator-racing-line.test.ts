import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { trackForJournal } from "../src/spectator/analysis.js"
import { JournalWriter } from "../src/spectator/journal.js"
import { fastLane, loop } from "./support/synthetic-track.js"

const LINE = "content/tracks/loop/gp/ai/fast_lane.ai"

let dir: string
let journal: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "racing-line-"))
  journal = join(dir, "s.ndjson.gz")
  const w = new JournalWriter(journal)
  w.write({
    t: "session",
    at: 0,
    serverName: "s",
    track: "loop",
    trackConfig: "gp",
    name: "Race",
    type: 3,
    recorderCarId: 0,
  })
  await w.close()
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function line(root: string, turn: "left" | "right"): Promise<void> {
  await mkdir(dirname(join(dir, root, LINE)), { recursive: true })
  await writeFile(join(dir, root, LINE), fastLane(loop(turn)))
}

describe("trackForJournal", () => {
  it.each([
    ["the mirror's, when only it has one", { mirror: "left" }, "left"],
    ["the hand copy's, when only it has one", { hand: "right" }, "right"],
    ["the mirror's over the hand copy's", { mirror: "left", hand: "right" }, "left"],
  ] as const)(
    "reads %s",
    async (_, has: { mirror?: "left" | "right"; hand?: "left" | "right" }, want) => {
      if (has.mirror) await line("mirror", has.mirror)
      if (has.hand) await line("hand", has.hand)
      const track = await trackForJournal(journal, {
        acRoot: join(dir, "hand"),
        acContent: join(dir, "mirror"),
      })
      expect(track.corners[0]?.direction).toBe(want)
    },
  )

  it("passes over a mirrored line it can't read", async () => {
    await line("hand", "right")
    await mkdir(dirname(join(dir, "mirror", LINE)), { recursive: true })
    await writeFile(join(dir, "mirror", LINE), "x")
    const track = await trackForJournal(journal, {
      acRoot: join(dir, "hand"),
      acContent: join(dir, "mirror"),
    })
    expect(track.corners[0]?.direction).toBe("right")
  })

  it("names both places when neither has one", async () => {
    await expect(
      trackForJournal(journal, { acRoot: join(dir, "hand"), acContent: join(dir, "mirror") }),
    ).rejects.toThrow(/no racing line for loop \(gp\) in .*mirror or .*hand/)
  })
})
