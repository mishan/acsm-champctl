import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  formatFrom,
  parseArgs as parseFinalizeArgs,
  renderPlan,
  UsageError as FinalizeUsageError,
} from "../src/cli/finalize.js"
import {
  main as monthMain,
  parseArgs as parseMonthArgs,
  renderResult,
  UsageError as MonthUsageError,
} from "../src/cli/month.js"
import { confirm, UsageError } from "../src/cli/args.js"
import { clientRootFor, parseArgs as parseServeArgs } from "../src/cli/serve.js"
import type { RaceFormat } from "../src/finalize/format.js"
import type { FinalizePlan } from "../src/finalize/plan.js"
import type { EmitResult } from "../src/emit/month.js"

/** Captures stderr so a CLI's own error text can be asserted. */
let captured = ""
const stderr = (): string => captured

beforeEach(() => {
  captured = ""
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    captured += String(chunk)
    return true
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

const current: RaceFormat = {
  length: { kind: "minutes", minutes: 40 },
  reversedGridPositions: 5,
  mandatoryPit: true,
  extraLap: true,
}

describe("champctl-finalize arguments", () => {
  it("takes a championship id and a 1-based round", () => {
    const args = parseFinalizeArgs(["abc-123", "2", "--laps", "18"])
    expect(args).toMatchObject({ championshipId: "abc-123", round: 2, laps: 18 })
  })

  it("previews by default; writing takes an explicit flag", () => {
    // The destructive option should be the one you type, not the one you
    // forget to turn off.
    expect(parseFinalizeArgs(["abc", "1"]).push).toBe(false)
    expect(parseFinalizeArgs(["abc", "1", "--push"]).push).toBe(true)
  })

  it("refuses --laps and --minutes together", () => {
    // Two ways to say the same thing; setting both leaves the export
    // ambiguous about which applies.
    expect(() => parseFinalizeArgs(["abc", "1", "--laps", "18", "--minutes", "40"])).toThrow(
      FinalizeUsageError,
    )
  })

  it("refuses a round that isn't a whole number from 1", () => {
    for (const bad of ["0", "-1", "1.5", "two"]) {
      expect(() => parseFinalizeArgs(["abc", bad]), bad).toThrow(/Round must be/)
    }
  })

  it("rejects extra positionals and unknown options", () => {
    expect(() => parseFinalizeArgs(["abc", "1", "extra"])).toThrow(FinalizeUsageError)
    expect(() => parseFinalizeArgs(["abc", "1", "--dry"])).toThrow(/Unknown option/)
    expect(() => parseFinalizeArgs(["abc", "1", "--laps"])).toThrow(/needs a value/)
  })

  it("reads --quali as a date and a time", () => {
    expect(parseFinalizeArgs(["a", "1", "--quali", "2026-09-09", "20:00"]).quali).toEqual({
      date: "2026-09-09",
      time: "20:00",
    })
  })

  it("has separate flags for setting and clearing a boolean", () => {
    // --no-pit has to mean "off", not "unspecified", or there's no way to
    // clear a mandatory stop from the command line.
    expect(parseFinalizeArgs(["a", "1", "--pit"]).pit).toBe(true)
    expect(parseFinalizeArgs(["a", "1", "--no-pit"]).pit).toBe(false)
    expect(parseFinalizeArgs(["a", "1"]).pit).toBeUndefined()
  })

  it("refuses a value that is obviously the next flag", () => {
    // --quali takes two values and called next() twice with no lookahead, so
    // `--quali 2026-09-09 --push` read "--push" as the time and dropped the
    // flag: the write never happened and nothing said why.
    expect(() => parseFinalizeArgs(["a", "1", "--quali", "2026-09-09", "--push"])).toThrow(
      /looks like another option/,
    )
    expect(() => parseFinalizeArgs(["a", "1", "--profile", "--push"])).toThrow(
      /looks like another option/,
    )
    // A negative number is a value, not a flag, and still reaches the check
    // that has something useful to say about it.
    expect(() => parseFinalizeArgs(["a", "1", "--reversed", "-1"])).toThrow(/whole number/)
  })

  it("refuses an empty numeric value rather than reading it as zero", () => {
    // `Number("")` is 0, so `--laps "$LAPS"` with an unset variable asked for
    // a zero-lap race. formFieldsFor posts Race.Laps: "0" and Race.Time: "0" —
    // a race with no end condition — and nothing downstream catches it:
    // gridmom has no lap check so the plan isn't blocked, and it isn't a noop
    // either, so --push sends it.
    for (const empty of ["", " ", "\t"]) {
      expect(() => parseFinalizeArgs(["a", "1", "--laps", empty]), JSON.stringify(empty)).toThrow(
        /value was empty/,
      )
    }
  })

  it("refuses a race length of zero, and a fractional one", () => {
    expect(() => parseFinalizeArgs(["a", "1", "--laps", "0"])).toThrow(/whole number of 1 or more/)
    expect(() => parseFinalizeArgs(["a", "1", "--minutes", "0"])).toThrow(/whole number/)
    for (const bad of ["1.5", "0x10", "1e3", "nope", "Infinity"]) {
      expect(() => parseFinalizeArgs(["a", "1", "--laps", bad]), bad).toThrow(/whole number/)
    }
  })

  it("allows zero reversed grid places, which means no reversed grid", () => {
    // The one numeric option where 0 is the ordinary answer rather than a
    // mistake, so it can't share a floor with --laps.
    expect(parseFinalizeArgs(["a", "1", "--reversed", "0"]).reversed).toBe(0)
    expect(parseFinalizeArgs(["a", "1", "--reversed", "5"]).reversed).toBe(5)
    expect(() => parseFinalizeArgs(["a", "1", "--reversed", "-1"])).toThrow(/whole number/)
    expect(() => parseFinalizeArgs(["a", "1", "--reversed", "1.7"])).toThrow(/whole number/)
  })
})

describe("confirming a destructive action", () => {
  const withTty = async (isTTY: boolean | undefined, fn: () => Promise<void>): Promise<void> => {
    const original = process.stdin.isTTY
    Object.defineProperty(process.stdin, "isTTY", { value: isTTY, configurable: true })
    try {
      await fn()
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: original, configurable: true })
    }
  }

  it("refuses to prompt when nothing is attached to stdin", async () => {
    // Not politeness. With stdin at EOF — cron, a closed fd, `< /dev/null` —
    // readline's question() never settles: the process hangs, then exits 13 on
    // Node's unsettled-top-level-await warning. run() never returns, so the
    // documented 0/1/2/3 contract is never reached and a nightly job looks
    // like an infrastructure failure rather than a missing --yes.
    await withTty(undefined, async () => {
      // One implementation now. This used to import the finalize and month
      // copies under separate aliases and assert against each, which is what
      // testing a duplicate looks like: two names for one behaviour, and no
      // test at all for the day they stopped agreeing.
      await expect(confirm("Push this?")).rejects.toThrow(UsageError)
      await expect(confirm("Push this?")).rejects.toThrow(/--yes/)
    })
  })

  it("is a usage error, so it lands on the documented exit code", async () => {
    // The point of throwing UsageError rather than anything else: main() maps
    // it to 3 and prints the usage block, instead of hanging.
    await withTty(undefined, async () => {
      await expect(confirm("Push this?")).rejects.toBeInstanceOf(UsageError)
    })
  })
})

describe("building the desired format", () => {
  it("changes only what was asked for", () => {
    // --laps 18 means "make it 18 laps", not "and reset everything I didn't
    // mention".
    expect(formatFrom(current, { laps: 18 })).toEqual({
      length: { kind: "laps", laps: 18 },
      reversedGridPositions: 5,
      mandatoryPit: true,
      extraLap: true,
    })
  })

  it("switches a timed race to laps and back", () => {
    expect(formatFrom(current, { laps: 18 }).length).toEqual({ kind: "laps", laps: 18 })
    expect(formatFrom(current, { minutes: 20 }).length).toEqual({ kind: "minutes", minutes: 20 })
  })

  it("keeps the current length when neither was given", () => {
    expect(formatFrom(current, { reversed: 0 }).length).toEqual(current.length)
  })

  it("can clear a boolean, not just set it", () => {
    expect(formatFrom(current, { pit: false }).mandatoryPit).toBe(false)
    expect(formatFrom(current, { extraLap: false }).extraLap).toBe(false)
  })

  it("treats zero as a value rather than as absent", () => {
    // `?? current` would be right here but `|| current` would not: 0 reversed
    // positions means a single race, and is the most common setting there is.
    //
    // Only --reversed is pinned. This also used to assert that
    // `formatFrom(current, { laps: 0 })` produced a zero-lap race, which
    // parseArgs now refuses outright — a suite that asserts a state the parser
    // rejects is documenting a bug as a feature.
    expect(formatFrom(current, { reversed: 0 }).reversedGridPositions).toBe(0)
    expect(formatFrom(current, { reversed: 0 }).length).toEqual(current.length)
  })
})

describe("rendering a plan", () => {
  const plan = (over: Partial<FinalizePlan> = {}): FinalizePlan =>
    ({
      championshipId: "abc-123",
      eventId: "ev-1",
      round: 2,
      current,
      desired: current,
      changes: [{ label: "Race length", before: "40 minutes", after: "18 laps" }],
      formChanges: [{ name: "Race.Laps", before: "0", after: "18" }],
      gridmom: { findings: [], counts: { ERROR: 0, WARN: 0, INFO: 0 }, ok: true },
      blocked: false,
      noop: false,
      entryListFingerprint: "x",
      form: {
        action: "",
        method: "POST",
        enctype: "",
        fields: [],
        fileFields: [],
        textAreaFields: [],
      },
      ...over,
    }) as FinalizePlan

  it("shows the human diff and the fields that will be posted", () => {
    const out = renderPlan(plan())
    expect(out).toContain("Race length: 40 minutes → 18 laps")
    expect(out).toContain("Race.Laps: 0 → 18")
  })

  it("says plainly when there is nothing to do", () => {
    expect(renderPlan(plan({ changes: [], formChanges: [], noop: true }))).toContain(
      "already matches",
    )
  })

  it("mentions the second request when the schedule moves", () => {
    const out = renderPlan(
      plan({
        schedule: {
          from: "2026-09-02 20:00 PDT",
          to: "2026-09-09 20:00 PDT",
          values: {
            "event-schedule-date": "2026-09-09",
            "event-schedule-time": "19:00",
            "event-schedule-timezone": "America/Los_Angeles",
            "event-schedule-recurrence": "",
          },
        },
      }),
    )
    expect(out).toContain("Quali:")
    expect(out).toContain("separate POST to the schedule endpoint")
  })

  it("prints gridmom findings with their severity", () => {
    const out = renderPlan(
      plan({
        gridmom: {
          findings: [
            { code: "entry.duplicate-pit-box", severity: "ERROR", message: "Duplicates at 3." },
          ],
          counts: { ERROR: 1, WARN: 0, INFO: 0 },
          ok: false,
        },
      } as Partial<FinalizePlan>),
    )
    expect(out).toContain("[ERROR] Duplicates at 3.")
  })
})

describe("champctl-month arguments", () => {
  it("needs a command", () => {
    expect(parseMonthArgs([]).command).toBe("")
    expect(parseMonthArgs(["build"]).command).toBe("build")
    expect(parseMonthArgs(["clone", "abc-123"]).source).toBe("abc-123")
  })

  it("writes nothing without --out or --import", () => {
    // This command creates championships, so the default has to be inert.
    const args = parseMonthArgs(["build", "--spec", "s.json", "--template", "t.json"])
    expect(args.doImport).toBe(false)
    expect(args.out).toBeUndefined()
  })

  it("takes --import explicitly", () => {
    expect(parseMonthArgs(["build", "--import"]).doImport).toBe(true)
  })

  it("splits a track list", () => {
    expect(parseMonthArgs(["build", "--tracks", "spa, suzuka ,monza"]).tracks).toEqual([
      "spa",
      "suzuka",
      "monza",
    ])
  })

  it("rejects extra positionals and unknown options", () => {
    expect(() => parseMonthArgs(["clone", "a", "b"])).toThrow(MonthUsageError)
    expect(() => parseMonthArgs(["build", "--nope"])).toThrow(/Unknown option/)
    expect(() => parseMonthArgs(["build", "--spec"])).toThrow(/needs a value/)
  })

  it("refuses a positional after build", async () => {
    // parseArgs allows one positional so `clone <id>` works, which left
    // `build <id> --spec ...` running against the spec while silently
    // ignoring the id someone clearly meant something by.
    const code = await monthMain(["build", "abc-123", "--spec", "s.json", "--template", "t.json"])
    expect(code).toBe(3)
    expect(stderr()).toMatch(/build takes no positional argument.*"abc-123"/s)
    expect(stderr()).toMatch(/clone abc-123/)
  })

  it("treats a bad date as a usage mistake, not a refusal", async () => {
    // A ScheduleError is something the person typed. Grouped with EmitError it
    // exited 3 with no usage block; grouped with FinalizeError in the other CLI
    // it exited 2, which is the code for "gridmom blocked this" — a refusal to
    // act on a correct request rather than a request that needs retyping.
    const dir = await mkdtemp(join(tmpdir(), "champctl-cli-"))
    try {
      const specPath = join(dir, "spec.json")
      const templatePath = join(dir, "template.json")
      await writeFile(
        specPath,
        JSON.stringify({ name: "M", cars: ["a"], rounds: [{ track: "spa" }] }),
        "utf8",
      )
      await writeFile(templatePath, JSON.stringify({ Name: "t", Events: [] }), "utf8")

      captured = ""
      const code = await monthMain([
        "build",
        "--spec",
        specPath,
        "--template",
        templatePath,
        "--start",
        "not-a-date",
      ])
      expect(code).toBe(3)
      expect(stderr()).toMatch(/not a usable start date/)
      expect(stderr()).toContain("Usage:")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("says what is wrong with a spec rather than dying on it", async () => {
    // readJson<MonthSpec> is a cast, not a check: parsing proves the bytes were
    // JSON and nothing more. `{}` reached emitMonth's `spec.rounds.length` and
    // came out as "Cannot read properties of undefined (reading 'length')",
    // which reads as champctl breaking rather than as a bad file. The
    // --template path already failed properly, so this only levels them up.
    const dir = await mkdtemp(join(tmpdir(), "champctl-cli-"))
    try {
      const specPath = join(dir, "spec.json")
      const templatePath = join(dir, "template.json")
      await writeFile(templatePath, JSON.stringify({ Name: "t", Events: [] }), "utf8")

      for (const [body, expected] of [
        ["{}", /has no `name`/],
        ['"nope"', /is not a JSON object/],
        ['{"name":"M"}', /has no `cars` array/],
        ['{"name":"M","cars":["a"]}', /has no `rounds` array/],
        ['{"name":"M","cars":["a"],"rounds":["spa"]}', /round 1 that is not an object/],
      ] as const) {
        captured = ""
        await writeFile(specPath, body, "utf8")
        const code = await monthMain(["build", "--spec", specPath, "--template", templatePath])
        expect(code, body).toBe(3)
        expect(stderr(), body).toMatch(expected)
        // Never the raw TypeError this used to produce.
        expect(stderr(), body).not.toMatch(/Cannot read properties/)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("rendering a month", () => {
  const result: EmitResult = {
    championship: {
      Name: "September 2026",
      Events: [{ RaceSetup: { Track: "spa" } }, { RaceSetup: { Track: "suzuka" } }],
    },
    grid: {
      maxClients: 24,
      bindingTrack: "suzuka",
      unknownTracks: [],
      summary: "Capped at 24 by suzuka.",
    },
    schedule: [
      { round: 1, qualiStart: "2026-09-02T20:00:00-07:00", scheduled: "", overridden: false },
      {
        round: 2,
        qualiStart: "2026-09-16T20:00:00-07:00",
        scheduled: "",
        overridden: true,
        note: "clashes with the 24h",
      },
    ],
    derived: ["Created and Updated stamped from now, not inherited"],
  } as EmitResult

  it("lists the rounds with their tracks and quali times", () => {
    const out = renderResult(result)
    expect(out).toContain("1. spa")
    expect(out).toContain("2026-09-02 20:00")
  })

  it("marks a moved round and says why", () => {
    expect(renderResult(result)).toContain("(moved: clashes with the 24h)")
  })

  it("names the track that binds the grid cap", () => {
    expect(renderResult(result)).toContain("Capped at 24 by suzuka.")
  })

  it("says what was derived rather than inherited", () => {
    expect(renderResult(result)).toContain("Created and Updated stamped")
  })
})

// ---------------------------------------------------------------------------
// champctl-serve's arguments
// ---------------------------------------------------------------------------

describe("parsing champctl-serve's arguments", () => {
  it("reads the options it documents", () => {
    const args = parseServeArgs([
      "--port",
      "8080",
      "--host",
      "0.0.0.0",
      "--profile",
      "batl",
      "--no-cache",
      "--trust-proxy",
    ])
    expect(args.port).toBe(8080)
    expect(args.host).toBe("0.0.0.0")
    expect(args.profile).toBe("batl")
    expect(args.cache).toBe(false)
    expect(args.trustProxy).toBe(true)
  })

  it("binds loopback unless told otherwise", () => {
    // champctl proxies whatever ACSM credentials it is handed, so reaching the
    // network has to be a decision someone makes rather than one they inherit.
    expect(parseServeArgs([]).host).toBe("127.0.0.1")
    expect(parseServeArgs([]).insecureCookies).toBe(false)
  })

  it("refuses a value that is obviously the next option", () => {
    // `--host --port 3000` would otherwise set the host to "--port" and then
    // fail on "3000" with "Unknown option 3000" — a complaint about the wrong
    // argument entirely, for a mistake made two arguments earlier.
    expect(() => parseServeArgs(["--host", "--port", "3000"])).toThrow(UsageError)
    expect(() => parseServeArgs(["--host", "--port", "3000"])).toThrow(/looks like another option/)
  })

  it("still says which option was left empty at the end of the line", () => {
    expect(() => parseServeArgs(["--profile"])).toThrow(/--profile needs a value/)
  })

  it("lets a negative number through to the check that can explain it", () => {
    // Not a flag. The port check has something specific to say about -1, and
    // "looks like another option" is not it.
    expect(() => parseServeArgs(["--port", "-1"])).toThrow(/port/i)
    expect(() => parseServeArgs(["--port", "-1"])).not.toThrow(/looks like another option/)
  })

  it("names an unknown option rather than guessing", () => {
    expect(() => parseServeArgs(["--reverse-proxy"])).toThrow(/Unknown option --reverse-proxy/)
  })

  it("calls a stray word an argument, not an option", () => {
    // champctl-serve takes no positional arguments, so "Unknown option batl"
    // sends the reader looking for a flag they never typed. The likeliest
    // mistake is the one worth naming.
    expect(() => parseServeArgs(["batl"])).toThrow(/takes no arguments/)
    expect(() => parseServeArgs(["batl"])).toThrow(/--profile batl/)
    expect(() => parseServeArgs(["batl"])).not.toThrow(/Unknown option/)
  })

  describe("$PORT", () => {
    const PORT = process.env["PORT"]
    afterEach(() => {
      if (PORT === undefined) delete process.env["PORT"]
      else process.env["PORT"] = PORT
    })

    it("is used when no --port was given", () => {
      process.env["PORT"] = "8080"
      expect(parseServeArgs([]).port).toBe(8080)
    })

    it("loses to an explicit --port", () => {
      process.env["PORT"] = "8080"
      expect(parseServeArgs(["--port", "9090"]).port).toBe(9090)
    })

    it("is rejected when it isn't a port", () => {
      process.env["PORT"] = "nonsense"
      expect(() => parseServeArgs([])).toThrow(/PORT needs a port number/)
    })

    it("does not stop --help from printing", () => {
      // The one command that has to work when everything else is
      // misconfigured. Reading the environment before knowing whether help was
      // asked for meant a broken $PORT refused to explain the flag that would
      // have overridden it.
      process.env["PORT"] = "nonsense"
      expect(() => parseServeArgs(["--help"])).not.toThrow()
      expect(parseServeArgs(["--help"]).help).toBe(true)
    })
  })
})

describe("finding the built client", () => {
  it("takes an explicit --client relative to the working directory", () => {
    // What a path someone typed means.
    expect(clientRootFor("build/ui")).toBe(resolve(process.cwd(), "build/ui"))
  })

  it("finds dist/client when running from a checkout", () => {
    // This suite runs from `src/`, where `../client` resolves to `src/client`
    // and does not exist. That is the `npm run serve` case, and resolving only
    // the nearest candidate made the documented "the API and, if built, the
    // client" quietly mean API-only however many times you had built.
    //
    // Skipped rather than failed when nothing is built: this asserts the
    // lookup, not that CI happens to have run `vite build` first.
    const built = resolve(process.cwd(), "dist/client")
    if (!existsSync(built)) return
    expect(clientRootFor(undefined)).toBe(built)
  })

  it("names dist/client when there is nothing built to serve", () => {
    // Whatever it returns goes into `registerClient`'s warning, so it has to
    // be a path `npm run build` will actually create. The weak version of this
    // test asserted only that the path ended in "client", which `src/client`
    // does — the exact wrong answer it was meant to rule out.
    //
    // This suite runs from `src/`, so the assertion is about the fallback.
    const root = clientRootFor(undefined)
    expect(root).toBe(resolve(process.cwd(), "dist/client"))
  })
})
