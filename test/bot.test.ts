/**
 * The nightly gridmom report, and the boundary that keeps it read-only.
 *
 * Nothing here needs a Discord token or a gateway: `nightly` deals in reports,
 * `nightlyMessages` deals in strings, and `RecordingTransport` is the whole of
 * the double. If a test in this file ever needs a network, the layering has
 * gone wrong.
 */

import { readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import { StaticAcsmReader, type AcsmReader } from "../src/acsm/client.js"
import type { Championship, ChampionshipSummary } from "../src/acsm/types.js"
import { nightlyMessages, reportMessages } from "../src/bot/message.js"
import { findingsAtOrAbove, isFinished, nightly } from "../src/bot/nightly.js"
import { MESSAGE_LIMIT, RecordingTransport } from "../src/bot/transport.js"
import { exitCodeFor, parseArgs } from "../src/cli/bot.js"
import { Severity, type Finding } from "../src/gridmom/finding.js"
import { formatDiscord } from "../src/gridmom/report.js"
import { validateProfile } from "../src/profile/load.js"
import {
  NOW,
  championship,
  driver,
  entryList,
  pitTable,
  raceEvent,
  suzukaPits,
  testProfile,
} from "./support/build.js"

const opts = () => ({ profile: testProfile(), pits: pitTable([suzukaPits]), now: NOW })

/** A championship with duplicate pit boxes — plan §6's example mess. */
const messy = (over: Partial<Championship> = {}): Championship =>
  championship({
    ID: "11111111-1111-1111-1111-111111111111",
    Name: "August 2026",
    Events: [
      raceEvent({
        EntryList: entryList([
          { ...driver("a"), PitBox: 3 },
          { ...driver("b"), PitBox: 3 },
        ]),
      }),
    ],
    ...over,
  })

/** Marks every round as run, which is what `isFinished` reads. */
const raced = (c: Championship): Championship => ({
  ...c,
  Events: (c.Events ?? []).map((ev) => ({ ...ev, StartedTime: "2026-08-05T19:00:00-07:00" })),
})

describe("which championships are worth reporting on", () => {
  it("skips one whose every round has been raced", async () => {
    const reader = new StaticAcsmReader([raced(messy())])
    const report = await nightly(reader, opts())

    expect(report.entries.map((e) => e.kind)).toEqual(["finished"])
    expect(report.checked).toBe(0)
    // The point of skipping: nothing gets said about a season nobody can fix.
    expect(nightlyMessages(report)).toEqual([])
  })

  it("includes it under --all, so the skip is a default and not a blind spot", async () => {
    const reader = new StaticAcsmReader([raced(messy())])
    const report = await nightly(reader, { ...opts(), includeFinished: true })

    expect(report.checked).toBe(1)
    expect(nightlyMessages(report).join("\n")).toContain("duplicate pit box at 3")
  })

  it("still reports one with a round left to run", async () => {
    const half = raced(messy())
    const events = half.Events ?? []
    // Round 1 raced, round 2 ahead. Everything about round 2 is still fixable.
    half.Events = [...events, raceEvent({ EntryList: entryList([{ ...driver("c"), PitBox: 0 }]) })]

    const report = await nightly(new StaticAcsmReader([half]), opts())
    expect(report.entries.map((e) => e.kind)).toEqual(["checked"])
  })

  it("does not excuse a championship with no events at all", () => {
    // `[].every()` is true, so the naive test would call an empty championship
    // finished — quietly hiding the case most likely to be a mistake someone
    // made ten minutes ago.
    expect(isFinished(championship({ Events: [] }))).toBe(false)
  })
})

describe("a championship that can't be read", () => {
  /** Fails on one id and answers normally for the rest. */
  const readerFailingOn = (badId: string, healthy: Championship[]): AcsmReader => {
    const inner = new StaticAcsmReader(healthy)
    return {
      listChampionships: async (): Promise<ChampionshipSummary[]> => [
        { ID: badId, Name: "Gone" },
        ...(await inner.listChampionships()),
      ],
      exportChampionship: async (id: string) => {
        if (id === badId) throw new Error("404 Not Found from /championship/export")
        return inner.exportChampionship(id)
      },
      exportChampionshipRaw: (id: string) => inner.exportChampionshipRaw(id),
      standings: () => inner.standings(),
      healthcheck: () => inner.healthcheck(),
      listContent: () => inner.listContent(),
    }
  }

  it("never aborts the rest of the walk", async () => {
    const report = await nightly(readerFailingOn("missing", [messy()]), opts())

    expect(report.failed).toBe(1)
    expect(report.checked).toBe(1)
    expect(nightlyMessages(report).join("\n")).toContain("duplicate pit box at 3")
  })

  it("says so in the channel rather than only in the exit code", async () => {
    const report = await nightly(readerFailingOn("missing", []), opts())
    const posted = nightlyMessages(report)

    expect(posted).toHaveLength(1)
    expect(posted[0]).toContain("I couldn't read this one")
    expect(posted[0]).toContain("404 Not Found")
  })

  it("counts a list entry with no id as a failure, not as nothing", async () => {
    const inner = new StaticAcsmReader([])
    const reader: AcsmReader = {
      listChampionships: async () => [{ Name: "Nameless" }],
      exportChampionship: (id: string) => inner.exportChampionship(id),
      exportChampionshipRaw: (id: string) => inner.exportChampionshipRaw(id),
      standings: () => inner.standings(),
      healthcheck: () => inner.healthcheck(),
      listContent: () => inner.listContent(),
    }
    const report = await nightly(reader, opts())
    expect(report.failed).toBe(1)
  })

  it("outranks a clean night in the exit code", async () => {
    const report = await nightly(readerFailingOn("missing", [championship()]), opts())
    const counts = findingsAtOrAbove(report)

    // The clean championship contributes nothing, so without the failure this
    // would be 0 — which is cron for "all good".
    expect(counts.ERROR).toBe(0)
    expect(exitCodeFor(counts, report.failed)).toBe(2)
  })
})

describe("exit codes", () => {
  it("rank errors over warnings over silence", () => {
    expect(exitCodeFor({ ERROR: 0, WARN: 0, INFO: 9 }, 0)).toBe(0)
    expect(exitCodeFor({ ERROR: 0, WARN: 1, INFO: 0 }, 0)).toBe(1)
    expect(exitCodeFor({ ERROR: 1, WARN: 5, INFO: 0 }, 0)).toBe(2)
  })

  it("ignore INFO, which is what --min WARN already hid from the channel", () => {
    expect(exitCodeFor({ ERROR: 0, WARN: 0, INFO: 40 }, 0)).toBe(0)
  })
})

describe("messages Discord will accept", () => {
  const finding = (i: number, size: number): Finding => ({
    code: `test.finding-${i}`,
    severity: Severity.WARN,
    message: `Finding ${i}: ${"x".repeat(size)}.`,
  })

  const report = (findings: Finding[]) => ({
    findings,
    counts: { ERROR: 0, WARN: findings.length, INFO: 0 },
    ok: true,
  })

  it("splits a long report rather than posting nothing", () => {
    const findings = Array.from({ length: 40 }, (_, i) => finding(i, 120))

    // Without splitting this is one message well over the limit, which Discord
    // rejects outright — so the championship with the most wrong with it is the
    // one whose report goes missing.
    expect(formatDiscord(report(findings), { subject: "August 2026" }).length).toBeGreaterThan(
      MESSAGE_LIMIT,
    )

    const messages = reportMessages("August 2026", report(findings))
    expect(messages.length).toBeGreaterThan(1)
    for (const m of messages) expect(m.length).toBeLessThanOrEqual(MESSAGE_LIMIT)
  })

  it("splits between findings, never inside one", () => {
    const findings = Array.from({ length: 40 }, (_, i) => finding(i, 120))
    const joined = reportMessages("August 2026", report(findings)).join("\n")

    for (const f of findings) expect(joined).toContain(f.message)
  })

  it("names the championship again on a continuation", () => {
    // Discord hides the author on consecutive messages, so an unheaded second
    // message reads as a report about a championship it never names.
    const messages = reportMessages(
      "August 2026",
      report(Array.from({ length: 40 }, (_, i) => finding(i, 120))),
    )
    expect(messages[0]).toContain("**gridmom — August 2026**")
    expect(messages[1]).toContain("**gridmom — August 2026 (continued)**")
  })

  it("truncates a single finding too long to post, rather than dropping it", () => {
    const messages = reportMessages("August 2026", report([finding(0, MESSAGE_LIMIT * 2)]))

    expect(messages).toHaveLength(1)
    expect(messages[0]!.length).toBeLessThanOrEqual(MESSAGE_LIMIT)
    expect(messages[0]).toContain("Finding 0:")
    expect(messages[0]!.endsWith("…")).toBe(true)
  })

  it("says nothing at all about a clean championship", () => {
    expect(reportMessages("August 2026", report([]))).toEqual([])
  })

  it("hides INFO by default, so the channel stays worth reading", () => {
    const info: Finding = { code: "x", severity: Severity.INFO, message: "Differs from baseline." }
    expect(reportMessages("August 2026", report([info]))).toEqual([])
    expect(
      reportMessages("August 2026", report([info]), { minSeverity: Severity.INFO }),
    ).toHaveLength(1)
  })
})

describe("gridmom's voice with a subject", () => {
  it("heads the prose rather than folding the name into the sentence", () => {
    const out = formatDiscord(
      {
        findings: [
          { code: "a", severity: Severity.ERROR, message: "Suzuka has duplicate pit boxes." },
          { code: "b", severity: Severity.ERROR, message: "Nobody set the lap count." },
        ],
        counts: { ERROR: 2, WARN: 0, INFO: 0 },
        ok: false,
      },
      { subject: "August 2026" },
    )
    expect(out).toBe(
      "**gridmom — August 2026**\nSuzuka has duplicate pit boxes. Also Nobody set the lap count.",
    )
  })

  it("leaves the CLI's output exactly as it was", () => {
    // The subject is opt-in: `gridmom check --format discord` names the
    // championship on the command line, so the prose stands alone there.
    const out = formatDiscord({
      findings: [{ code: "a", severity: Severity.ERROR, message: "Nobody set the lap count." }],
      counts: { ERROR: 1, WARN: 0, INFO: 0 },
      ok: false,
    })
    expect(out).toBe("**gridmom:** Nobody set the lap count.")
  })

  it("does not repeat the subject when there is nothing to say", () => {
    const out = formatDiscord(
      { findings: [], counts: { ERROR: 0, WARN: 0, INFO: 0 }, ok: true },
      { subject: "August 2026" },
    )
    expect(out).toBe("**gridmom — August 2026**\nNothing to report.")
  })
})

describe("the transport boundary", () => {
  it("records what it was asked to post, which is what --dry-run shows", async () => {
    const transport = new RecordingTransport()
    await transport.post({ channelId: "123", content: "hello" })
    await transport.close()

    expect(transport.posted).toEqual([{ channelId: "123", content: "hello" }])
  })
})

describe("the bot cannot write to ACSM", () => {
  const botDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "bot")

  /**
   * The modules a write needs. `session.ts` is the cookie jar, `write.ts` the
   * import safety rules, and the two `apply` modules the things that POST.
   *
   * Checked structurally because plan §7's "no ACSM credentials, ever" is
   * otherwise a promise kept by everyone remembering it — and the bot is the
   * component most likely to grow a "just this once" convenience, since it is
   * the one already holding a poll result someone wants applied.
   */
  const writePath = [
    "acsm/session.js",
    "acsm/write.js",
    "finalize/apply.js",
    "reorder/apply.js",
    "web/",
  ]

  it("imports nothing from the write path", () => {
    const offences: string[] = []
    for (const file of readdirSync(botDir)) {
      if (!file.endsWith(".ts")) continue
      const source = readFileSync(join(botDir, file), "utf8")
      for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
        const specifier = match[1]!
        if (writePath.some((w) => specifier.includes(w)))
          offences.push(`${file} imports ${specifier}`)
      }
    }
    expect(offences).toEqual([])
  })

  it("checks a directory that actually has modules in it", () => {
    // Otherwise the test above passes by finding nothing to look at.
    expect(readdirSync(botDir).filter((f) => f.endsWith(".ts")).length).toBeGreaterThan(0)
  })
})

describe("the CLI", () => {
  it("refuses a token on the command line", () => {
    // It would be in shell history and in every ps listing on the box.
    expect(() => parseArgs(["report", "--token", "hunter2"])).toThrow(/CHAMPCTL_DISCORD_TOKEN/)
  })

  it("has no way to be given ACSM credentials", () => {
    expect(() => parseArgs(["report", "--username", "admin"])).toThrow(/Unknown option/)
    expect(() => parseArgs(["report", "--push"])).toThrow(/Unknown option/)
  })

  it("catches a stray positional rather than running against the default channel", () => {
    expect(() => parseArgs(["report", "1234567890123456789"])).toThrow(/takes no arguments/)
  })

  it("defaults to posting warnings and errors only", () => {
    expect(parseArgs(["report"]).min).toBeUndefined()
    expect(parseArgs(["report", "--min", "info"]).min).toBe("INFO")
  })
})

describe("the profile's Discord settings", () => {
  const withDiscord = (discord: unknown) =>
    validateProfile({
      id: "t",
      name: "T",
      schedule: {
        weekday: 3,
        qualiStart: "20:00",
        timezone: "America/Los_Angeles",
        practiceMinutes: 60,
        qualiMinutes: 20,
      },
      entryList: { targetSlots: 30 },
      discord,
    })

  it("accepts a snowflake", () => {
    expect(withDiscord({ adminChannelId: "1234567890123456789" }).discord?.adminChannelId).toBe(
      "1234567890123456789",
    )
  })

  it("rejects a channel name, which is what people paste instead", () => {
    expect(() => withDiscord({ adminChannelId: "#admin" })).toThrow(/17 to 20 digits/)
  })

  it("rejects a channel link", () => {
    expect(() =>
      withDiscord({ adminChannelId: "https://discord.com/channels/1/1234567890123456789" }),
    ).toThrow(/17 to 20 digits/)
  })

  it("is optional, because not every league runs a bot", () => {
    expect(withDiscord(undefined).discord).toBeUndefined()
  })
})

describe("the packaged profile", () => {
  it("does not ship BATL's channel id as a placeholder someone would post to", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
    const batl = JSON.parse(readFileSync(join(root, "profiles", "batl.json"), "utf8")) as {
      discord?: { adminChannelId?: string }
    }
    // A committed channel id is a channel every fork of this repo posts into.
    expect(batl.discord?.adminChannelId).toBeUndefined()
  })
})
