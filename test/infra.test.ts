import { describe, expect, it } from "vitest"

import { asMessage, HttpAcsmReader, AcsmError, StaticAcsmReader } from "../src/acsm/client.js"
import { RateLimiter } from "../src/acsm/rate-limit.js"
import { InMemoryPitTable } from "../src/pits/table.js"
import { validateProfile } from "../src/profile/load.js"
import { isZeroTime, session, sessionKeysUsed, slots } from "../src/acsm/view.js"
import { main, parseArgs } from "../src/cli/gridmom.js"
import { loadPits, reportUsageError, runCli, UsageError } from "../src/cli/args.js"
import { championship } from "./support/build.js"

describe("rate limiter", () => {
  it("lets the first burst through and then waits", async () => {
    let clock = 0
    const sleeps: number[] = []
    const limiter = new RateLimiter({
      limit: 5,
      windowMs: 20_000,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms)
        clock += ms
      },
    })

    for (let i = 0; i < 5; i++) await limiter.acquire()
    expect(sleeps).toHaveLength(0)

    await limiter.acquire()
    expect(sleeps).toEqual([20_000])
  })

  it("refuses a limit of zero rather than spinning on it", () => {
    // Not "block everything" — a hang. The wait loop reads #timestamps[0] to
    // decide how long to sleep, and with nothing ever admitted that is
    // undefined, so the sleep is NaN and the loop spins as fast as the event
    // loop allows. A limiter is exactly the thing nobody watches while it
    // works.
    expect(() => new RateLimiter({ limit: 0 })).toThrow(RangeError)
    expect(() => new RateLimiter({ limit: -1 })).toThrow(/at least 1/)
    expect(() => new RateLimiter({ limit: 1.5 })).toThrow(/whole number/)
    expect(() => new RateLimiter({ windowMs: 0 })).toThrow(/positive number/)
    // The way to actually turn limiting off is an option on the caller, and
    // the error says so rather than leaving someone to guess.
    expect(() => new RateLimiter({ limit: 0 })).toThrow(/rateLimit: false/)
  })

  it("keeps the window sliding rather than resetting in blocks", async () => {
    let clock = 0
    const limiter = new RateLimiter({
      limit: 2,
      windowMs: 1000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
    })
    await limiter.acquire()
    clock += 600
    await limiter.acquire()
    await limiter.acquire()
    // The first slot expires 1000ms after it was taken, i.e. 400ms from now.
    expect(clock).toBe(1000)
  })
})

const A = "11111111-2222-3333-4444-555555555555"

describe("HTTP reader", () => {
  const reader = (fetchImpl: typeof globalThis.fetch) =>
    new HttpAcsmReader({ baseUrl: "https://acsm.example/", fetch: fetchImpl, rateLimit: false })

  it("sends no credentials, ever", async () => {
    let seen: RequestInit | undefined
    const r = reader(async (_url, init) => {
      seen = init
      return new Response("[]", { status: 200 })
    })
    await r.listChampionships()
    const headers = new Headers(seen?.headers)
    expect(headers.has("authorization")).toBe(false)
    expect(headers.has("cookie")).toBe(false)
    expect(seen?.credentials).toBeUndefined()
  })

  it("explains an HTML response as Public Access being off", async () => {
    const r = reader(async () => new Response("<html>login</html>", { status: 200 }))
    await expect(r.exportChampionship("x")).rejects.toThrow(/Public Access/)
  })

  it("reports a non-2xx with its status", async () => {
    const r = reader(async () => new Response("nope", { status: 503, statusText: "Unavailable" }))
    await expect(r.healthcheck()).rejects.toBeInstanceOf(AcsmError)
  })

  it("unwraps a list that arrives inside an envelope", async () => {
    const r = reader(async () => new Response(JSON.stringify({ championships: [{ ID: "a" }] })))
    await expect(r.listChampionships()).resolves.toEqual([{ ID: "a" }])
  })

  /**
   * The shape 2.4.15 actually answers with, measured against the harness.
   *
   * Lowercase keys, and champctl reads `ID`/`Name` everywhere because that is
   * what the export and the scrape fallback use. The array was cast straight
   * through, so nothing failed: the clone list in the web UI came back empty,
   * `gridmom list` printed `?` for every row, and `champctl-archive` said
   * "Championship list entry had no ID field" about every championship on the
   * server. A build that has this endpoint is a build where the archive
   * silently records nothing.
   */
  it("reads a list entry whose keys are lowercase", async () => {
    const r = reader(
      async () =>
        new Response(
          JSON.stringify({
            championships: [{ name: "August 2026", id: A, progress: 0 }],
          }),
        ),
    )
    await expect(r.listChampionships()).resolves.toEqual([
      { ID: A, Name: "August 2026", id: A, name: "August 2026", progress: 0 },
    ])
  })

  /**
   * Both spellings present, and the capitalised one useless.
   *
   * Reading `raw.ID ?? raw.id` prefers whichever key *exists*, so a build that
   * answers with `"ID": null` beside a real `"id"` — or with the capitalised
   * key holding a number — loses the id it did send. That is the empty clone
   * list and the archive recording nothing all over again, one level down.
   */
  it("prefers the spelling that holds a string, not the one that exists", async () => {
    const r = reader(
      async () => new Response(JSON.stringify([{ ID: null, id: A, Name: 7, name: "August 2026" }])),
    )
    await expect(r.listChampionships()).resolves.toMatchObject({
      0: { ID: A, Name: "August 2026" },
    })
  })

  /**
   * A row that is not an object at all, which `Array.isArray` does not catch.
   * The archive's contract is that one bad championship never stops the rest,
   * and reading `.ID` off a string used to be how the whole run ended.
   */
  it("does not choke on a list entry that is not an object", async () => {
    const r = reader(async () => new Response(JSON.stringify([null, "nope", { ID: A }])))
    await expect(r.listChampionships()).resolves.toEqual([{}, {}, { ID: A }])
  })

  /**
   * `/api/championships/list.json` does not exist on 2.4.5, nor on
   * ac.batlracing.com — measured, 404 even as admin. The listing page is then
   * the only way to enumerate championships, so the fallback is a normal path
   * rather than a rescue.
   */
  it("falls back to the listing page when the endpoint is a 404", async () => {
    const r = reader(async (url) =>
      String(url).includes("list.json")
        ? new Response("not found", { status: 404 })
        : new Response(`<a href="/championship/${A}">x</a>`, { status: 200 }),
    )
    // With the name the listing carried: the scrape is the only path any real
    // ACSM takes, so a nameless summary here is a UUID on someone's screen.
    await expect(r.listChampionships()).resolves.toEqual([{ ID: A, Name: "x" }])
  })

  /**
   * The failure the fallback must not swallow. With Public Access off the
   * endpoint answers with login HTML, which #getJson reports usefully — and
   * scraping instead reads *another* login page, finds no championships, and
   * hands back an empty list. The archive would then exit 0 having archived
   * nothing: the exact outcome it exists to prevent, reported as success.
   */
  it("does not scrape past a Public Access failure", async () => {
    const r = reader(async () => new Response("<html>login</html>", { status: 200 }))
    await expect(r.listChampionships()).rejects.toThrow(/Public Access/)
  })

  it("treats a corrupt cache entry as a miss rather than failing forever", async () => {
    // One bad write must not leave the CLI permanently broken for that URL.
    let fetches = 0
    const stored = new Map<string, string>([["https://acsm.example/healthcheck.json", "{trunca"]])
    const r = new HttpAcsmReader({
      baseUrl: "https://acsm.example",
      rateLimit: false,
      fetch: async () => {
        fetches++
        return new Response(JSON.stringify({ ok: true }))
      },
      cache: {
        async get(key) {
          return stored.get(key)
        },
        async set(key, value) {
          stored.set(key, value)
        },
      },
    })

    await expect(r.healthcheck()).resolves.toEqual({ ok: true })
    expect(fetches).toBe(1)
    // ...and the good response replaced the corrupt entry.
    expect(stored.get("https://acsm.example/healthcheck.json")).toBe('{"ok":true}')
  })

  it("serves a valid cache entry without hitting the network", async () => {
    let fetches = 0
    const r = new HttpAcsmReader({
      baseUrl: "https://acsm.example",
      rateLimit: false,
      fetch: async () => {
        fetches++
        return new Response("{}")
      },
      cache: {
        async get() {
          return '{"ok":true}'
        },
        async set() {
          /* no-op */
        },
      },
    })
    await expect(r.healthcheck()).resolves.toEqual({ ok: true })
    expect(fetches).toBe(0)
  })

  it("hits the export endpoint that works logged out", async () => {
    let url = ""
    const r = reader(async (u) => {
      url = String(u)
      return new Response("{}")
    })
    await r.exportChampionship("abc def")
    expect(url).toBe("https://acsm.example/championship/abc%20def/export")
  })
})

describe("turning a thrown thing into a sentence", () => {
  it("calls an abort a timeout, which is what it was", () => {
    // `AbortError` is what a fetch timeout throws, and its own message —
    // "The operation was aborted" — reads like something champctl chose to do
    // rather than something that happened to it. The message ends up in
    // "Request to /championships failed: ...", where the difference is whether
    // a league admin goes looking at their own network or at champctl.
    const e = new Error("The operation was aborted")
    e.name = "AbortError"
    expect(asMessage(e)).toBe("timed out")
  })

  it("leaves every other error to say what it says", () => {
    expect(asMessage(new TypeError("fetch failed"))).toBe("fetch failed")
    expect(asMessage(new AcsmError("ACSM returned 503"))).toBe("ACSM returned 503")
  })

  it("stringifies whatever was thrown when it wasn't an Error", () => {
    expect(asMessage("boom")).toBe("boom")
    expect(asMessage(undefined)).toBe("undefined")
  })
})

describe("static reader", () => {
  it("serves exports already on disk", async () => {
    const r = new StaticAcsmReader([championship({ ID: "a", Name: "A" })])
    await expect(r.exportChampionship("a")).resolves.toMatchObject({ Name: "A" })
    await expect(r.exportChampionship("b")).rejects.toThrow(/No championship b/)
  })
})

describe("pit table precedence", () => {
  it("lets manual beat scan beat acsm", () => {
    const t = new InMemoryPitTable()
    t.add({ track: "spa", layout: "", pitboxes: 20, source: "acsm" })
    t.add({ track: "spa", layout: "", pitboxes: 24, source: "scan" })
    expect(t.get("spa")?.pitboxes).toBe(24)
    t.add({ track: "spa", layout: "", pitboxes: 26, source: "manual" })
    expect(t.get("spa")?.pitboxes).toBe(26)
    // A weaker source must not overwrite a stronger one.
    t.add({ track: "spa", layout: "", pitboxes: 2, source: "acsm" })
    expect(t.get("spa")?.pitboxes).toBe(26)
  })

  it("normalises whitespace at the lookup, so callers don't have to", () => {
    // The one place this rule lives. gridCap builds a human-facing label from
    // the same track and layout it looks up with, so if the lookup were
    // whitespace-sensitive the summary would name a track the table had never
    // found — and every caller would need its own trim to stay honest, which
    // is the sort of rule that drifts once it has two homes.
    const t = new InMemoryPitTable([
      { track: "spa", layout: "", pitboxes: 30, source: "manual" },
      { track: "brands_hatch", layout: "indy", pitboxes: 24, source: "manual" },
    ])
    expect(t.get(" spa ")?.pitboxes).toBe(30)
    expect(t.get("brands_hatch", " indy ")?.pitboxes).toBe(24)
    // And records are normalised on the way in, not only on the way out.
    const messy = new InMemoryPitTable([
      { track: " monza ", layout: " ", pitboxes: 26, source: "manual" },
    ])
    expect(messy.get("monza")?.pitboxes).toBe(26)
  })

  it("falls back from a layout to the whole track", () => {
    const t = new InMemoryPitTable([
      { track: "silverstone", layout: "", pitboxes: 24, source: "manual" },
    ])
    expect(t.get("silverstone", "international")?.pitboxes).toBe(24)
    expect(t.get("brands")).toBeUndefined()
  })
})

describe("profile validation", () => {
  it("rejects a weekday outside 1..7", () => {
    expect(() =>
      validateProfile({
        id: "x",
        name: "X",
        schedule: {
          weekday: 8,
          qualiStart: "20:00",
          timezone: "UTC",
          practiceMinutes: 60,
          qualiMinutes: 20,
        },
        entryList: { targetSlots: 10 },
      }),
    ).toThrow(/weekday/)
  })

  /**
   * A preset is a button, and a button that can only ever produce a 400 is
   * worse than no button. The plan endpoint bounds laps, minutes and reversed
   * positions; profile validation used to bound only the low end, so
   * `laps: 1e30` started the service cleanly and failed at the moment someone
   * clicked it. Both now read the same constants — see MAX_LAPS in
   * finalize/format.ts.
   */
  it("rejects a preset the plan endpoint would refuse anyway", () => {
    const withPreset = (preset: unknown) => () =>
      validateProfile({
        id: "x",
        name: "X",
        schedule: {
          weekday: 3,
          qualiStart: "20:00",
          timezone: "UTC",
          practiceMinutes: 60,
          qualiMinutes: 20,
        },
        entryList: { targetSlots: 10 },
        formats: [{ name: "Silly", ...(preset as object) }],
      })

    const ok = {
      length: { kind: "laps", laps: 18 },
      reversedGridPositions: 5,
      mandatoryPit: true,
      extraLap: false,
    }
    expect(withPreset(ok)).not.toThrow()

    expect(withPreset({ ...ok, length: { kind: "laps", laps: 1e30 } })).toThrow(/between 1 and/)
    expect(withPreset({ ...ok, length: { kind: "minutes", minutes: 100_000 } })).toThrow(
      /between 1 and/,
    )
    expect(withPreset({ ...ok, reversedGridPositions: 1e30 })).toThrow(/between 0 and/)
    // The low end still holds.
    expect(withPreset({ ...ok, length: { kind: "laps", laps: 0 } })).toThrow(/between 1 and/)
  })

  it("rejects a timezone this system doesn't know", () => {
    // Luxon doesn't throw on an unknown zone — setZone returns an invalid
    // DateTime and every method on it answers politely, so a transposed letter
    // produced findings reading "Invalid DateTime", NaN weekday comparisons
    // that never matched, and a null used as a Map key. None of that looks
    // like a configuration mistake, which is why it's caught here.
    expect(() =>
      validateProfile({
        id: "x",
        name: "X",
        schedule: {
          weekday: 3,
          qualiStart: "20:00",
          timezone: "Amercia/Los_Angeles",
          practiceMinutes: 60,
          qualiMinutes: 20,
        },
        entryList: { targetSlots: 10 },
      }),
    ).toThrow(/not a timezone this system knows/)
  })

  it("rejects a quali time that matches the shape but isn't a time", () => {
    // "99:99" passes ^\d{2}:\d{2}$ and then reaches set({ hour: 99 }).
    for (const qualiStart of ["99:99", "24:00", "20:60"]) {
      expect(
        () =>
          validateProfile({
            id: "x",
            name: "X",
            schedule: {
              weekday: 3,
              qualiStart,
              timezone: "UTC",
              practiceMinutes: 60,
              qualiMinutes: 20,
            },
            entryList: { targetSlots: 10 },
          }),
        qualiStart,
      ).toThrow(/must be a real time/)
    }
  })

  it("rejects a malformed quali time", () => {
    expect(() =>
      validateProfile({
        id: "x",
        name: "X",
        schedule: {
          weekday: 3,
          qualiStart: "8pm",
          timezone: "UTC",
          practiceMinutes: 60,
          qualiMinutes: 20,
        },
        entryList: { targetSlots: 10 },
      }),
    ).toThrow(/qualiStart/)
  })
})

describe("view helpers", () => {
  it("treats Go's zero time as unset", () => {
    expect(isZeroTime("0001-01-01T00:00:00Z")).toBe(true)
    expect(isZeroTime("0001-01-01T00:00:00-07:52")).toBe(true)
    expect(isZeroTime("")).toBe(true)
    expect(isZeroTime(undefined)).toBe(true)
    expect(isZeroTime("2026-09-02T19:00:00-07:00")).toBe(false)
  })

  it("finds a session however this ACSM version spells the key", () => {
    // SessionType's constants are "PRACTICE"/"QUALIFY"/"RACE"; exports have
    // also carried the friendly spellings. Sessions is a map, so the wrong key
    // isn't an error — the lookup just finds nothing and every format check
    // silently passes.
    const upper = {
      RaceSetup: {
        Sessions: { PRACTICE: { Time: 60 }, QUALIFY: { Time: 20 }, RACE: { Laps: 20 } },
      },
    }
    expect(session(upper, "Practice")?.Time).toBe(60)
    expect(session(upper, "Qualifying")?.Time).toBe(20)
    expect(session(upper, "Race")?.Laps).toBe(20)

    const friendly = {
      RaceSetup: {
        Sessions: { Practice: { Time: 60 }, Qualifying: { Time: 20 }, Race: { Laps: 20 } },
      },
    }
    expect(session(friendly, "Practice")?.Time).toBe(60)
    expect(session(friendly, "Qualifying")?.Time).toBe(20)
    expect(session(friendly, "Race")?.Laps).toBe(20)
  })

  it("prefers an exact key over an alias", () => {
    const both = { RaceSetup: { Sessions: { Race: { Laps: 20 }, RACE: { Laps: 99 } } } }
    expect(session(both, "Race")?.Laps).toBe(20)
  })

  it("returns undefined for a session that isn't there", () => {
    expect(session({ RaceSetup: { Sessions: { RACE: { Laps: 20 } } } }, "Booking")).toBeUndefined()
    expect(session({}, "Race")).toBeUndefined()
  })

  it("reports the literal session keys an export used", () => {
    expect(
      sessionKeysUsed({
        Events: [
          { RaceSetup: { Sessions: { PRACTICE: {}, RACE: {} } }, Sessions: { RACE: {} } },
          { RaceSetup: { Sessions: { QUALIFY: {} } } },
        ],
      }),
    ).toEqual(["PRACTICE", "QUALIFY", "RACE"])
  })

  it("orders entry list slots numerically, not lexically", () => {
    const ordered = slots({
      CAR_10: { Name: "ten" },
      CAR_2: { Name: "two" },
      CAR_1: { Name: "one" },
    })
    expect(ordered.map((s) => s.entrant.Name)).toEqual(["one", "two", "ten"])
  })
})

describe("CLI argument parsing", () => {
  it("reads a championship id", () => {
    const a = parseArgs(["check", "abc"])
    expect(a).toMatchObject({ command: "check", target: "abc", format: "text", profile: "batl" })
  })

  it("reads the discord flags a cron job would use", () => {
    const a = parseArgs(["check", "abc", "--format", "discord", "--min", "warn"])
    expect(a.format).toBe("discord")
    expect(a.min).toBe("WARN")
  })

  it("splits a suppression list", () => {
    expect(
      parseArgs(["check", "--file", "x.json", "--suppress", "format,entry.x"]).suppress,
    ).toEqual(["format", "entry.x"])
  })

  it("rejects an unknown option rather than ignoring it", () => {
    expect(() => parseArgs(["check", "--wat"])).toThrow(/Unknown option/)
  })

  it("rejects a bad format", () => {
    expect(() => parseArgs(["check", "x", "--format", "yaml"])).toThrow(/--format/)
  })
})

describe("CLI usage errors", () => {
  /** Captures stderr for the duration of a call. */
  async function stderrOf(fn: () => Promise<number>): Promise<{ code: number; err: string }> {
    const original = process.stderr.write.bind(process.stderr)
    let err = ""
    process.stderr.write = ((chunk: string | Uint8Array) => {
      err += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)
      return true
    }) as typeof process.stderr.write
    try {
      return { code: await fn(), err }
    } finally {
      process.stderr.write = original
    }
  }

  it("prints usage for a bad option", async () => {
    const { code, err } = await stderrOf(() => main(["check", "--wat"]))
    expect(code).toBe(3)
    expect(err).toContain("Unknown option --wat")
    expect(err).toContain("Usage:")
  })

  it("prints usage for an unknown command", async () => {
    const { code, err } = await stderrOf(() => main(["frobnicate"]))
    expect(code).toBe(3)
    expect(err).toContain("Unknown command frobnicate")
    expect(err).toContain("Usage:")
  })

  it("prints usage when check has no target", async () => {
    const { code, err } = await stderrOf(() =>
      main(["check", "--profile", "./test/support/profile-no-url.json"]),
    )
    expect(code).toBe(3)
    expect(err).toContain("championship id or --file")
    expect(err).toContain("Usage:")
  })

  it("prints usage when there is no base URL, not a bare failure", async () => {
    // This one is raised well after argument parsing, which is why it used to
    // surface as "gridmom couldn't run" with no hint about --base-url.
    const { code, err } = await stderrOf(() =>
      main(["list", "--profile", "./test/support/profile-no-url.json"]),
    )
    expect(code).toBe(3)
    expect(err).toContain("No ACSM base URL")
    expect(err).toContain("--base-url")
    expect(err).toContain("Usage:")
  })

  it("recognises a UsageError raised anywhere, not just its own", async () => {
    // The reason UsageError lives in one module rather than one per CLI. Four
    // classes with the same name are four *different* classes, so
    // `e instanceof UsageError` is false for one raised by any of the others —
    // and the first shared helper to throw one would have its usage block
    // silently skipped by every CLI but the one that declared it. Nothing
    // depended on that yet, which is why it was worth fixing before four
    // entry points existed rather than after.
    const usage = "Usage:\n  pretend-cli <thing>\n"
    const thrower = async (): Promise<number> => {
      throw new UsageError("raised by a shared helper")
    }

    const { err } = await stderrOf(async () => {
      await runCli({ name: "pretend-cli", usage, main: thrower }, [])
      return 0
    })

    expect(err).toContain("raised by a shared helper")
    expect(err).toContain("Usage:")
    // Not the "couldn't run" fallback, which is what an unrecognised class gets.
    expect(err).not.toContain("couldn't run")
  })

  it("names the tool when something other than a usage mistake escapes", async () => {
    const boom = async (): Promise<number> => {
      throw new Error("ACSM said no")
    }
    const { err } = await stderrOf(async () => {
      await runCli({ name: "pretend-cli", usage: "Usage:\n", main: boom }, [])
      return 0
    })
    expect(err).toBe("pretend-cli couldn't run: ACSM said no\n")
  })

  it("reportUsageError puts the message above the usage block", async () => {
    const { code, err } = await stderrOf(async () =>
      reportUsageError(new UsageError("bad flag"), "Usage:\n  thing\n"),
    )
    expect(code).toBe(3)
    expect(err).toBe("bad flag\n\nUsage:\n  thing\n")
  })
})

describe("shared CLI pit-table loading", () => {
  it("falls back to an empty table when the default file is absent", async () => {
    // The default is league data and gitignored, so "not there yet" is normal
    // and the grid checks are meant to degrade to a warning rather than fail.
    const table = await loadPits(undefined)
    expect(table).toBeDefined()
  })

  it("reports an explicit --pits that will not load", async () => {
    // An explicit path is a claim that the file exists; swallowing that would
    // silently run the checks against no pit data at all.
    await expect(loadPits("./test/support/definitely-not-here.json")).rejects.toThrow()
  })
})
