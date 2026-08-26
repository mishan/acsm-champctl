/**
 * The live suite's login pacer, on a fake clock.
 *
 * Here rather than in `test/live/` on purpose: what this checks is arithmetic
 * over a window, and it should fail on a laptop with no harness. The live
 * suite cannot check it — a run that paces correctly and a run that does not
 * both pass whenever the manager happens not to be busy, which is exactly how
 * the version this replaces looked fine for as long as it did.
 */

import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { beforeEach, describe, expect, it } from "vitest"

import { paceLogin, paceStatePath } from "./live/login-pace.js"

describe("pacing logins against ACSM's limiter", () => {
  let statePath = ""

  beforeEach(async () => {
    statePath = join(await mkdtemp(join(tmpdir(), "champctl-pace-")), "window.json")
  })

  /** A pacer on a clock that only moves when a sleep says it does. */
  const pacer = () => {
    let clock = 1_000_000
    const slept: number[] = []
    return {
      slept,
      at: () => clock,
      advance: (ms: number) => {
        clock += ms
      },
      login: () =>
        paceLogin({
          statePath,
          now: () => clock,
          sleep: async (ms) => {
            slept.push(ms)
            clock += ms
          },
        }),
    }
  }

  it("lets a burst through and then waits out the window", async () => {
    const p = pacer()
    for (let i = 0; i < 4; i++) await p.login()
    expect(p.slept, "four is the budget, and none of them waits").toEqual([])

    await p.login()
    expect(p.slept).toEqual([20_250])
  })

  it("waits from the oldest login, not from now", async () => {
    const p = pacer()
    for (let i = 0; i < 4; i++) await p.login()
    p.advance(15_000)

    // The first slot expires 20s after it was taken, i.e. 5s from here — not
    // 20s. Deciding the wait from `now` rather than from the oldest stamp is
    // how a suite spends a minute proving it can count.
    await p.login()
    expect(p.slept).toEqual([5_250])
  })

  it("never lets a fifth login into any twenty-second window", async () => {
    // The invariant, over a staggered run rather than a burst. A burst is the
    // easy case — the whole window expires at once, so one wait clears it. A
    // staggered one frees a single slot at a time, which is where a pacer that
    // decides "how long" once and then stops re-checking goes over.
    const p = pacer()
    const taken: number[] = []
    for (let i = 0; i < 4; i++) {
      await p.login()
      taken.push(p.at())
      p.advance(1_000)
    }
    for (let i = 0; i < 8; i++) {
      await p.login()
      taken.push(p.at())
    }

    expect(taken).toHaveLength(12)
    for (const at of taken) {
      const inWindow = taken.filter((s) => s >= at && s < at + 20_000)
      expect(
        inWindow.length,
        `${inWindow.length} logins in the window opening at ${at}`,
      ).toBeLessThanOrEqual(4)
    }
  })

  it("forgets logins that have aged out", async () => {
    const p = pacer()
    for (let i = 0; i < 4; i++) await p.login()
    p.advance(20_001)
    await p.login()
    expect(p.slept).toEqual([])
  })

  /**
   * The point of keeping the window on disk: vitest gives each test file its
   * own module registry, so a counter in module scope resets between files and
   * every file starts believing it has the whole budget.
   */
  it("carries the window across processes, which is what module state could not", async () => {
    const first = pacer()
    for (let i = 0; i < 4; i++) await first.login()

    // A second pacer, sharing only the file — as a second vitest worker would.
    const second = pacer()
    await second.login()
    expect(second.slept, "the budget was already spent by someone else").toEqual([20_250])
  })

  it("starts over rather than throwing when the window file is unreadable", async () => {
    await writeFile(statePath, "{ not json", "utf8")
    const p = pacer()
    await expect(p.login()).resolves.toBeUndefined()
  })

  it("gives each manager its own window", () => {
    expect(paceStatePath("http://127.0.0.1:8772")).not.toBe(paceStatePath("http://127.0.0.1:8773"))
    expect(paceStatePath("http://127.0.0.1:8772")).toBe(paceStatePath("http://127.0.0.1:8772"))
  })
})
