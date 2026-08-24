import { describe, expect, it } from "vitest"

import { AcsmAuthError, AcsmSession, AcsmWriteError, CookieJar } from "../src/acsm/session.js"
import { parseForm } from "../src/acsm/form.js"
import {
  IMPORT_HOUSEKEEPING,
  diff,
  formatChanges,
} from "../src/acsm/diff.js"
import {
  assertNoResults,
  championshipIdFromRedirect,
  importChampionship,
  isSafeToImport,
  regenerateIds,
  startedRounds,
} from "../src/acsm/write.js"
import { entrant, fakeEventForm, fakeLoginPage } from "./support/acsm-html.js"
import { championship, raceEvent } from "./support/build.js"

// ---------------------------------------------------------------------------
// A scripted fetch, so session behaviour is tested without a container.
// ---------------------------------------------------------------------------

interface Call {
  url: string
  init: RequestInit
}

function scriptedFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Call[] = []
  const fn: typeof globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : String(input)
    calls.push({ url, init })
    return handler(url, init)
  }
  return { fn, calls }
}

const sessionCookie = "_acsm_data=MTIzNDU2; Path=/; HttpOnly"

describe("cookie jar", () => {
  it("keeps the two cookies ACSM cares about", () => {
    const jar = new CookieJar()
    jar.storeFromResponse({
      headers: new Headers([
        ["set-cookie", sessionCookie],
        ["set-cookie", "current-server=0; Path=/"],
      ]),
    })
    expect(jar.get("_acsm_data")).toBe("MTIzNDU2")
    expect(jar.header()).toContain("current-server=0")
  })

  it("treats an empty value as a delete", () => {
    const jar = new CookieJar()
    jar.set("_acsm_data", "x")
    jar.storeFromResponse({ headers: new Headers([["set-cookie", "_acsm_data=; Max-Age=0"]]) })
    expect(jar.get("_acsm_data")).toBeUndefined()
  })

  it("has no header at all when empty", () => {
    expect(new CookieJar().header()).toBeUndefined()
  })
})

describe("login", () => {
  const session = (handler: (url: string, init: RequestInit) => Response) => {
    const { fn, calls } = scriptedFetch(handler)
    return { s: new AcsmSession({ baseUrl: "https://acsm.example", fetch: fn }), calls }
  }

  it("posts the three fields with no CSRF token", async () => {
    const { s, calls } = session(() =>
      new Response("", { status: 302, headers: { "set-cookie": sessionCookie, location: "/" } }),
    )
    await s.login({ username: "admin", password: "hunter2" })

    const body = calls[0]!.init.body as URLSearchParams
    expect(calls[0]!.url).toBe("https://acsm.example/login")
    expect([...body.keys()].sort()).toEqual(["Password", "RememberMe", "Username"])
    expect(s.isLoggedIn).toBe(true)
  })

  it("sends the current-server cookie from the first request", async () => {
    const { s, calls } = session(() =>
      new Response("", { status: 302, headers: { "set-cookie": sessionCookie, location: "/" } }),
    )
    await s.login({ username: "admin", password: "x" })
    expect(new Headers(calls[0]!.init.headers).get("Cookie")).toContain("current-server=0")
  })

  it("treats a re-rendered login page as a failure, not a success", async () => {
    // ACSM answers a bad password with 200 and the login form again.
    const { s } = session(() => new Response(fakeLoginPage(), { status: 200 }))
    await expect(s.login({ username: "admin", password: "wrong" })).rejects.toThrow(AcsmAuthError)
  })

  it("says so when the account must change its password first", async () => {
    const { s } = session(() =>
      new Response("", {
        status: 302,
        headers: { "set-cookie": sessionCookie, location: "/accounts/new-password" },
      }),
    )
    await expect(s.login({ username: "admin", password: "servermanager" })).rejects.toThrow(
      /must set a new password/,
    )
  })

  it("clears the jar on logout even if the request fails", async () => {
    const { s } = session((url) => {
      if (url.endsWith("/login")) {
        return new Response("", { status: 302, headers: { "set-cookie": sessionCookie, location: "/" } })
      }
      return new Response("", { status: 500 })
    })
    await s.login({ username: "admin", password: "x" })
    await s.logout()
    expect(s.isLoggedIn).toBe(false)
  })
})

describe("single origin", () => {
  // The jar has no host scoping, so every request carries the session cookie.
  // That is only safe if the session can't be pointed at another host.
  const session = () => {
    const { fn, calls } = scriptedFetch((url) =>
      url.endsWith("/login")
        ? new Response("", { status: 302, headers: { "set-cookie": sessionCookie, location: "/" } })
        : new Response("{}", { status: 200 }),
    )
    const s = new AcsmSession({ baseUrl: "https://acsm.example", fetch: fn })
    return { s, calls, ready: s.login({ username: "admin", password: "x" }) }
  }

  it("resolves a path against the base URL", () => {
    const { s } = session()
    expect(s.url("/championship/abc")).toBe("https://acsm.example/championship/abc")
  })

  it("accepts an absolute URL on its own origin", () => {
    const { s } = session()
    expect(s.url("https://acsm.example/championship/abc")).toBe(
      "https://acsm.example/championship/abc",
    )
  })

  it("refuses an absolute URL on another origin", () => {
    const { s } = session()
    expect(() => s.url("https://ac.batlracing.com/championship/abc")).toThrow(
      /Refusing to request https:\/\/ac\.batlracing\.com/,
    )
  })

  it("refuses a different scheme or port on the same host", () => {
    const { s } = session()
    expect(() => s.url("http://acsm.example/x")).toThrow(/Refusing to request/)
    expect(() => s.url("https://acsm.example:8772/x")).toThrow(/Refusing to request/)
  })

  it("follows a same-origin redirect, carrying the cookie", async () => {
    const { fn, calls } = scriptedFetch((url) => {
      if (url.endsWith("/login")) {
        return new Response("", { status: 302, headers: { "set-cookie": sessionCookie, location: "/" } })
      }
      if (url.endsWith("/old")) {
        return new Response("", { status: 302, headers: { location: "/new" } })
      }
      return new Response('{"ok":true}', { status: 200 })
    })
    const s = new AcsmSession({ baseUrl: "https://acsm.example", fetch: fn })
    await s.login({ username: "admin", password: "x" })

    await expect(s.getJson("/old")).resolves.toEqual({ ok: true })
    expect(calls.map((c) => c.url)).toEqual([
      "https://acsm.example/login",
      "https://acsm.example/old",
      "https://acsm.example/new",
    ])
    expect(new Headers(calls[2]!.init.headers).get("Cookie")).toContain("_acsm_data")
  })

  it("refuses to follow a redirect off the origin", async () => {
    const { fn, calls } = scriptedFetch((url) => {
      if (url.endsWith("/login")) {
        return new Response("", { status: 302, headers: { "set-cookie": sessionCookie, location: "/" } })
      }
      return new Response("", { status: 302, headers: { location: "https://evil.example/steal" } })
    })
    const s = new AcsmSession({ baseUrl: "https://acsm.example", fetch: fn })
    await s.login({ username: "admin", password: "x" })

    await expect(s.getText("/championship/abc")).rejects.toThrow(/Refusing to request/)
    // The off-origin request was never made.
    expect(calls.map((c) => c.url)).not.toContain("https://evil.example/steal")
  })

  it("gives up rather than looping forever", async () => {
    const { fn, calls } = scriptedFetch((url) =>
      url.endsWith("/login")
        ? new Response("", { status: 302, headers: { "set-cookie": sessionCookie, location: "/" } })
        : new Response("", { status: 302, headers: { location: "/loop" } }),
    )
    const s = new AcsmSession({ baseUrl: "https://acsm.example", fetch: fn })
    await s.login({ username: "admin", password: "x" })

    await expect(s.getText("/loop")).rejects.toThrow()
    expect(calls.length).toBeLessThan(10)
  })

  it("leaves an explicit manual redirect alone for the caller to read", async () => {
    const { s, calls, ready } = session()
    await ready
    // login() asked for the raw 302 and read Location off it.
    expect(calls).toHaveLength(1)
    expect(s.isLoggedIn).toBe(true)
  })
})

describe("fetching pages", () => {
  const loggedIn = (handler: (url: string, init: RequestInit) => Response) => {
    const { fn, calls } = scriptedFetch((url, init) => {
      if (url.endsWith("/login")) {
        return new Response("", { status: 302, headers: { "set-cookie": sessionCookie, location: "/" } })
      }
      return handler(url, init)
    })
    const s = new AcsmSession({ baseUrl: "https://acsm.example", fetch: fn })
    return { s, calls, ready: s.login({ username: "admin", password: "x" }) }
  }

  it("detects a silently expired session", async () => {
    const { s, ready } = loggedIn(() => new Response(fakeLoginPage(), { status: 200 }))
    await ready
    await expect(s.getText("/championship/abc")).rejects.toThrow(/Session expired/)
  })

  it("parses a form off a page", async () => {
    const html = fakeEventForm({ entrants: [entrant("alice")] })
    const { s, ready } = loggedIn(() => new Response(html, { status: 200 }))
    await ready
    const form = await s.getForm("/championship/abc/event/e1/edit")
    expect(form.method).toBe("POST")
    expect(form.fields.some((f) => f.name === "EntryList.Name")).toBe(true)
  })
})

describe("postForm refuses to scramble an entry list", () => {
  const loggedIn = () => {
    const { fn, calls } = scriptedFetch((url) =>
      url.endsWith("/login")
        ? new Response("", { status: 302, headers: { "set-cookie": sessionCookie, location: "/" } })
        : new Response("", { status: 302, headers: { location: "/championship/abc" } }),
    )
    const s = new AcsmSession({ baseUrl: "https://acsm.example", fetch: fn })
    return { s, calls, ready: s.login({ username: "admin", password: "x" }) }
  }

  it("sends a well-formed payload", async () => {
    const { s, calls, ready } = loggedIn()
    await ready
    const fields = parseForm(fakeEventForm({ entrants: [entrant("a"), entrant("b")] })).fields
    await s.postForm("/championship/abc/event/submit", fields)
    const body = calls[1]!.init.body as URLSearchParams
    expect(body.getAll("EntryList.Name")).toEqual(["a", "b"])
  })

  it("blocks a ragged payload before it reaches ACSM", async () => {
    const { s, calls, ready } = loggedIn()
    await ready
    const fields = parseForm(fakeEventForm({ entrants: [entrant("a"), entrant("b")] })).fields
    const i = fields.findIndex((f) => f.name === "EntryList.GUID")
    fields.splice(i, 1)

    await expect(s.postForm("/championship/abc/event/submit", fields)).rejects.toThrow(
      /entry list arrays don't line up/,
    )
    // Nothing was sent — the login is the only call.
    expect(calls).toHaveLength(1)
  })
})

describe("import safety rules", () => {
  it("refuses a championship that already has results", () => {
    const c = championship({
      Events: [
        raceEvent({ StartedTime: "2026-07-01T19:00:00-07:00" }),
        raceEvent({ Scheduled: "2026-09-09T19:00:00-07:00" }),
      ],
    })
    expect(() => assertNoResults(c)).toThrow(/already has results/)
    expect(isSafeToImport(c)).toBe(false)
    expect(startedRounds(c)).toEqual([1])
  })

  it("allows a championship that hasn't run", () => {
    expect(isSafeToImport(championship())).toBe(true)
  })

  it("catches results recorded on a session rather than the event", () => {
    const c = championship({
      Events: [raceEvent({ Sessions: { Race: { StartedTime: "2026-07-01T19:05:00-07:00" } } })],
    })
    expect(isSafeToImport(c)).toBe(false)
  })

  it("refuses an ID that already exists on the server", async () => {
    const { fn } = scriptedFetch((url) =>
      url.endsWith("/login")
        ? new Response("", { status: 302, headers: { "set-cookie": sessionCookie, location: "/" } })
        : new Response("", { status: 302, headers: { location: "/championship/x" } }),
    )
    const s = new AcsmSession({ baseUrl: "https://acsm.example", fetch: fn })
    await s.login({ username: "admin", password: "x" })

    const reader = {
      listChampionships: async () => [{ ID: "keep-me" }],
      exportChampionship: async () => ({}),
      standings: async () => ({}),
      healthcheck: async () => ({}),
    }
    await expect(
      importChampionship(s, championship({ ID: "keep-me" }), { freshIds: false, reader }),
    ).rejects.toThrow(AcsmWriteError)
  })
})

describe("regenerateIds", () => {
  it("rewrites every UUID so an import creates rather than overwrites", () => {
    const before = championship({ ID: "11111111-2222-3333-4444-555555555555" })
    const after = regenerateIds(before)
    expect(after.ID).not.toBe(before.ID)
    expect(after.ID).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("remaps consistently so internal references survive", () => {
    const id = "11111111-2222-3333-4444-555555555555"
    const out = regenerateIds({ a: id, nested: { b: id }, other: "not-a-uuid" })
    expect(out.a).toBe(out.nested.b)
    expect(out.a).not.toBe(id)
    expect(out.other).toBe("not-a-uuid")
  })

  it("leaves the nil UUID alone", () => {
    const nil = "00000000-0000-0000-0000-000000000000"
    expect(regenerateIds({ x: nil }).x).toBe(nil)
  })
})

describe("redirect parsing", () => {
  it("pulls the championship id out of the Location header", () => {
    const res = new Response("", {
      status: 302,
      headers: { location: "/championship/11111111-2222-3333-4444-555555555555" },
    })
    expect(championshipIdFromRedirect(res)).toBe("11111111-2222-3333-4444-555555555555")
  })

  it("returns undefined when there's no redirect", () => {
    expect(championshipIdFromRedirect(new Response("", { status: 200 }))).toBeUndefined()
  })
})

describe("diff", () => {
  it("reports a changed scalar with both values", () => {
    expect(diff({ a: 1 }, { a: 2 })).toEqual([{ path: "a", kind: "changed", before: 1, after: 2 }])
  })

  it("walks nested objects and arrays", () => {
    const changes = diff({ Events: [{ Laps: 20 }] }, { Events: [{ Laps: 22 }] })
    expect(changes[0]!.path).toBe("Events[0].Laps")
  })

  it("distinguishes added from removed", () => {
    expect(diff({}, { a: 1 })[0]).toMatchObject({ kind: "added", after: 1 })
    expect(diff({ a: 1 }, {})[0]).toMatchObject({ kind: "removed", before: 1 })
  })

  it("ignores ACSM's import housekeeping", () => {
    const before = { Version: 0, Updated: "then", ScheduledServerID: "", Name: "x" }
    const after = { Version: 2, Updated: "now", ScheduledServerID: "srv", Name: "x" }
    expect(diff(before, after, { ignore: IMPORT_HOUSEKEEPING })).toEqual([])
  })

  it("does NOT ignore PracticeEntryListType", () => {
    // ACSM silently rewrote 2 to 1 on import. Allowlisting a silent value
    // change is how the same mechanism quietly changes a race later.
    const changes = diff(
      { PracticeEntryListType: 2 },
      { PracticeEntryListType: 1 },
      { ignore: IMPORT_HOUSEKEEPING },
    )
    expect(changes).toHaveLength(1)
  })

  it("supports index wildcards", () => {
    const changes = diff(
      { Events: [{ ID: "a" }, { ID: "b" }] },
      { Events: [{ ID: "x" }, { ID: "y" }] },
      { ignore: ["Events[*].ID"] },
    )
    expect(changes).toEqual([])
  })

  it("formats changes as old → new", () => {
    expect(formatChanges(diff({ Laps: 20 }, { Laps: 22 }))).toBe("~ Laps: 20 → 22")
    expect(formatChanges([])).toBe("No differences.")
  })
})
