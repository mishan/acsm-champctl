import { describe, expect, it } from "vitest"

import { assertDisposable, isDisposableHost } from "../src/acsm/disposable.js"
import type { Championship } from "../src/acsm/types.js"
import { AcsmAuthError, AcsmSession, CookieJar } from "../src/acsm/session.js"
import { parseForm } from "../src/acsm/form.js"
import {
  IMPORT_HOUSEKEEPING,
  diff,
  formatChanges,
} from "../src/acsm/diff.js"
import {
  assertNoResults,
  detectImportMechanism,
  championshipIdFromRedirect,
  importChampionship,
  isSafeToImport,
  regenerateIds,
  startedRounds,
} from "../src/acsm/write.js"
import { entrant, fakeEventForm, fakeImportPage, fakeLoginPage } from "./support/acsm-html.js"
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
    await expect(s.login({ username: "admin", password: "wrong" })).rejects.toThrow(
      /re-rendered the login page/,
    )
  })

  it("judges success by the redirect, not by the session cookie's name", async () => {
    // 2.4.5 names its session cookie _acsm_data; older builds don't. Looking
    // for that name reported a perfectly good login as a failure.
    const { s } = session(() =>
      new Response("", {
        status: 302,
        headers: { "set-cookie": "some_other_session=abc; Path=/", location: "/" },
      }),
    )
    await s.login({ username: "admin", password: "correct" })
    expect(s.isLoggedIn).toBe(true)
    expect(s.username).toBe("admin")
  })

  it("complains when a redirect arrives with no session cookie at all", async () => {
    const { s } = session(() => new Response("", { status: 302, headers: { location: "/" } }))
    await expect(s.login({ username: "admin", password: "x" })).rejects.toThrow(
      /set no session cookie/,
    )
  })

  it("still throws AcsmAuthError, so callers can distinguish auth from transport", async () => {
    const { s } = session(() => new Response(fakeLoginPage(), { status: 200 }))
    await expect(s.login({ username: "admin", password: "wrong" })).rejects.toBeInstanceOf(
      AcsmAuthError,
    )
  })

  it("names a carriage return in the password, the classic CRLF .env", async () => {
    const { s } = session(() => new Response(fakeLoginPage(), { status: 200 }))
    await expect(s.login({ username: "admin", password: "hunter2\r" })).rejects.toThrow(
      /Windows line endings|line break/,
    )
  })

  it("names surrounding quotes", async () => {
    const { s } = session(() => new Response(fakeLoginPage(), { status: 200 }))
    await expect(s.login({ username: "admin", password: '"hunter2"' })).rejects.toThrow(
      /wrapped in quotes/,
    )
  })

  it("says nothing extra about a clean password", async () => {
    const { s } = session(() => new Response(fakeLoginPage(), { status: 200 }))
    await expect(s.login({ username: "admin", password: "hunter2" })).rejects.toThrow(
      /^Login as admin failed: ACSM re-rendered the login page[^.]*$/,
    )
  })

  it("reports a server error distinctly from a bad password", async () => {
    const { s } = session(() => new Response("boom", { status: 500 }))
    await expect(s.login({ username: "admin", password: "x" })).rejects.toThrow(/server error/)
  })

  it("refuses a 3xx that isn't ACSM's redirect to /", async () => {
    // An auth proxy, a TLS redirect or a captive portal will happily 302 with
    // a cookie. Treating any redirect as success hands the caller a session
    // that isn't one.
    for (const location of [
      "https://sso.example/authorize?next=/",
      "/some/other/page",
      "https://acsm.example/login",
    ]) {
      const { s } = session(() =>
        new Response("", { status: 302, headers: { "set-cookie": sessionCookie, location } }),
      )
      await expect(s.login({ username: "admin", password: "x" })).rejects.toThrow(
        /redirected to .* rather than "\/"/,
      )
      expect(s.isLoggedIn).toBe(false)
    }
  })

  it("does not accept a 304 as a successful login", async () => {
    // 304 Not Modified is a cache-validation response, not a redirect. A cache
    // or reverse proxy can emit one carrying the Location and Set-Cookie of
    // the response it stands in for — so a `status >= 300 && < 400` test made
    // it indistinguishable from ACSM's own 302-to-/, and handed back a session
    // that was never authenticated.
    const { s } = session(() =>
      new Response("", {
        status: 304,
        headers: { "set-cookie": sessionCookie, location: "/" },
      }),
    )
    await expect(s.login({ username: "admin", password: "x" })).rejects.toThrow(/304/)
    expect(s.isLoggedIn).toBe(false)
  })

  it("does not accept 305 or 306 either", async () => {
    for (const status of [305, 306]) {
      const { s } = session(() =>
        new Response("", { status, headers: { "set-cookie": sessionCookie, location: "/" } }),
      )
      await expect(s.login({ username: "admin", password: "x" })).rejects.toBeInstanceOf(
        AcsmAuthError,
      )
      expect(s.isLoggedIn).toBe(false)
    }
  })

  it("accepts each status that really is a redirect to /", async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const { s } = session(() =>
        new Response("", { status, headers: { "set-cookie": sessionCookie, location: "/" } }),
      )
      await s.login({ username: "admin", password: "x" })
      expect(s.isLoggedIn, `status ${status}`).toBe(true)
    }
  })

  it("accepts the root redirect written out in full", async () => {
    // A build with server_manager_base_URL configured may send an absolute
    // Location rather than a bare "/".
    const { s } = session(() =>
      new Response("", {
        status: 302,
        headers: { "set-cookie": sessionCookie, location: "https://acsm.example/" },
      }),
    )
    await s.login({ username: "admin", password: "x" })
    expect(s.isLoggedIn).toBe(true)
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
    // The session cannot write until that is dealt with, so it must not look
    // logged in to a caller that catches the error and carries on.
    expect(s.isLoggedIn).toBe(false)
    expect(s.username).toBeUndefined()
  })

  it("is not logged in after the no-session-cookie failure either", async () => {
    const { s } = session(() => new Response("", { status: 302, headers: { location: "/" } }))
    await expect(s.login({ username: "admin", password: "x" })).rejects.toThrow(
      /set no session cookie/,
    )
    expect(s.isLoggedIn).toBe(false)
  })

  it("clears a previous identity when a later login fails", async () => {
    // Otherwise isLoggedIn stays true from the earlier attempt and a caller
    // goes on to write with a session that is no longer valid.
    let ok = true
    const { s } = session(() =>
      ok
        ? new Response("", { status: 302, headers: { "set-cookie": sessionCookie, location: "/" } })
        : new Response(fakeLoginPage(), { status: 200 }),
    )
    await s.login({ username: "admin", password: "right" })
    expect(s.isLoggedIn).toBe(true)

    ok = false
    await expect(s.login({ username: "admin", password: "wrong" })).rejects.toThrow()
    expect(s.isLoggedIn).toBe(false)
    expect(s.username).toBeUndefined()
    // ...and the old session cookie is gone, not left to be sent again.
    expect(s.jar.get("_acsm_data")).toBeUndefined()
    expect(s.jar.get("current-server")).toBe("0")
  })

  it("keeps the configured server index across a re-login", async () => {
    const { fn } = scriptedFetch(() =>
      new Response("", { status: 302, headers: { "set-cookie": sessionCookie, location: "/" } }),
    )
    const s = new AcsmSession({ baseUrl: "https://acsm.example", fetch: fn, serverIndex: 2 })
    await s.login({ username: "admin", password: "x" })
    await s.login({ username: "admin", password: "x" })
    expect(s.jar.get("current-server")).toBe("2")
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

describe("disposable host guard", () => {
  it("accepts loopback in every spelling", () => {
    for (const h of ["localhost", "127.0.0.1", "127.1.2.3", "::1", "0.0.0.0"]) {
      expect(isDisposableHost(h), h).toBe(true)
    }
  })

  it("accepts private ranges, so the harness can bind to a LAN address", () => {
    for (const h of ["192.168.1.50", "10.0.0.7", "172.16.4.2", "172.31.255.254", "169.254.1.1"]) {
      expect(isDisposableHost(h), h).toBe(true)
    }
  })

  it("rejects public addresses that merely look private", () => {
    // 172.15 and 172.32 are outside 172.16/12, and both are easy to fat-finger.
    for (const h of ["172.15.0.1", "172.32.0.1", "8.8.8.8", "192.169.1.1"]) {
      expect(isDisposableHost(h), h).toBe(false)
    }
  })

  it("rejects a league's actual manager", () => {
    expect(isDisposableHost("ac.batlracing.com")).toBe(false)
  })

  it("accepts the whole of fe80::/10, not just fe80", () => {
    // The prefix is ten bits, so the first hextet runs fe80..febf. Matching
    // only "fe80:" turned away a legitimate link-local harness address.
    for (const h of ["fe80::1", "fe90::1", "fea0::1", "febf::1", "[fe80::1]"]) {
      expect(isDisposableHost(h), h).toBe(true)
    }
  })

  it("rejects IPv6 just outside the local prefixes", () => {
    // fec0::/10 was site-local and is deprecated but routable-looking; fe00
    // and fb00 sit below the fc00::/7 and fe80::/10 boundaries; 2001: is
    // ordinary global unicast.
    for (const h of ["fec0::1", "fe00::1", "fb00::1", "2001:db8::1"]) {
      expect(isDisposableHost(h), h).toBe(false)
    }
  })

  it("does not mistake a global IPv6 address for a single-label hostname", () => {
    // No IPv6 address contains a dot, and the last rule here accepts any
    // dot-free host as a local single-label name. Every global address used to
    // fall through to it — a public ACSM on IPv6 passed the guard outright.
    expect(isDisposableHost("2606:4700:4700::1111")).toBe(false)
    expect(() =>
      assertDisposable("http://[2606:4700:4700::1111]:8772", "recon", {}),
    ).toThrow(/CHAMPCTL_I_KNOW_THIS_ISNT_LOCAL=yes/)
  })

  it("reads IPv4-mapped addresses as their IPv4 form", () => {
    expect(isDisposableHost("::ffff:192.168.1.5")).toBe(true)
    expect(isDisposableHost("::ffff:8.8.8.8")).toBe(false)
  })

  it("treats ranges nobody allow-listed as not disposable", () => {
    // The address rules are an allow-list of ipaddr.js range names, so a range
    // that was never considered fails closed rather than open. These are the
    // ones a deny-list would have missed.
    for (const h of [
      "255.255.255.255", // broadcast
      "224.0.0.1", // multicast
      "240.0.0.1", // reserved
      "192.0.2.1", // TEST-NET-1
      "2002:c0a8:0101::1", // 6to4 — encodes 192.168.1.1, but is not local
      "2001:0::1", // teredo
      "ff02::1", // v6 multicast
    ]) {
      expect(isDisposableHost(h), h).toBe(false)
    }
  })

  it("rejects malformed addresses rather than reading them as hostnames", () => {
    // These don't parse as addresses and have dots, so they fall to the name
    // rules and are rejected there. The failure mode that matters is a typo
    // being waved through.
    for (const h of ["999.1.1.1", "10.0.0.1.2", "not:an:address"]) {
      expect(isDisposableHost(h), h).toBe(false)
    }
  })

  it("resolves inet_aton shorthand the way a browser would", () => {
    // 10.0.0 is 10.0.0.0 and 2130706433 is 127.0.0.1 — curl and every browser
    // agree, so a URL written that way really does reach a local address and
    // the guard should say so. 8.8.8 is 8.8.0.8, which does not.
    expect(isDisposableHost("10.0.0")).toBe(true)
    expect(isDisposableHost("2130706433")).toBe(true)
    expect(isDisposableHost("8.8.8")).toBe(false)
  })

  it("accepts unique-local addresses across fc00::/7", () => {
    for (const h of ["fc00::1", "fcff::1", "fd12:3456::1", "fdff::1"]) {
      expect(isDisposableHost(h), h).toBe(true)
    }
  })

  it("accepts container and mDNS names", () => {
    for (const h of ["acsm", "champctl-acsm", "mishas-mac.local", "db.internal"]) {
      expect(isDisposableHost(h), h).toBe(true)
    }
  })

  it("throws for a public host, naming the override", () => {
    expect(() => assertDisposable("https://ac.batlracing.com", "recon", {})).toThrow(
      /CHAMPCTL_I_KNOW_THIS_ISNT_LOCAL=yes/,
    )
  })

  it("lets the override through", () => {
    expect(() =>
      assertDisposable("https://ac.batlracing.com", "recon", {
        CHAMPCTL_I_KNOW_THIS_ISNT_LOCAL: "yes",
      }),
    ).not.toThrow()
  })

  it("does not accept a truthy-but-wrong override value", () => {
    expect(() =>
      assertDisposable("https://ac.batlracing.com", "recon", {
        CHAMPCTL_I_KNOW_THIS_ISNT_LOCAL: "true",
      }),
    ).toThrow()
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

  it("does not chase the Location on a 304", async () => {
    // Same reasoning as the login case: 304 is not a redirect, so there is
    // nothing to follow. Following it would turn a cache hit into a request
    // nobody asked for.
    const { fn, calls } = scriptedFetch((url) =>
      url.endsWith("/login")
        ? new Response("", { status: 302, headers: { "set-cookie": sessionCookie, location: "/" } })
        : new Response("", { status: 304, headers: { location: "/somewhere-else" } }),
    )
    const s = new AcsmSession({ baseUrl: "https://acsm.example", fetch: fn })
    await s.login({ username: "admin", password: "x" })

    await expect(s.getText("/cached")).rejects.toThrow()
    expect(calls.map((c) => c.url)).not.toContain("https://acsm.example/somewhere-else")
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
    // Three entrants, not two: dropping one value from a two-entrant list
    // leaves a count of 1, which the shape check deliberately reads as
    // form-level metadata rather than a truncated array.
    const fields = parseForm(
      fakeEventForm({ entrants: [entrant("a"), entrant("b"), entrant("c")] }),
    ).fields
    const i = fields.findIndex((f) => f.name === "EntryList.GUID")
    fields.splice(i, 1)

    await expect(s.postForm("/championship/abc/event/submit", fields)).rejects.toThrow(
      /entry list arrays don't line up/,
    )
    // Nothing was sent — the login is the only call.
    expect(calls).toHaveLength(1)
  })
})

describe("import mechanism detection", () => {
  const on = (importHtml: string) => {
    const posts: { url: string; init: RequestInit }[] = []
    const { fn } = scriptedFetch((url, init) => {
      if (url.endsWith("/login")) {
        return new Response("", { status: 302, headers: { "set-cookie": sessionCookie, location: "/" } })
      }
      if (init.method === "POST") {
        posts.push({ url, init })
        return new Response("", {
          status: 302,
          headers: { location: "/championship/11111111-2222-3333-4444-555555555555" },
        })
      }
      return new Response(importHtml, { status: 200 })
    })
    const s = new AcsmSession({ baseUrl: "https://acsm.example", fetch: fn })
    return { s, posts, ready: s.login({ username: "admin", password: "x" }) }
  }

  it("finds the textarea 1.7.9 renders, ignoring the navbar search form", async () => {
    const { s, ready } = on(fakeImportPage("textarea", "import"))
    await ready
    await expect(detectImportMechanism(s)).resolves.toEqual({ kind: "textarea", field: "import" })
  })

  it("finds the file input 2.4.5 renders", async () => {
    const { s, ready } = on(fakeImportPage("file", "championshipFile"))
    await ready
    await expect(detectImportMechanism(s)).resolves.toEqual({
      kind: "file",
      field: "championshipFile",
    })
  })

  it("posts urlencoded JSON when the form is a textarea", async () => {
    const { s, posts, ready } = on(fakeImportPage("textarea", "import"))
    await ready
    const result = await importChampionship(s, championship())

    expect(result.mechanism).toEqual({ kind: "textarea", field: "import" })
    const body = posts[0]!.init.body as URLSearchParams
    expect(body).toBeInstanceOf(URLSearchParams)
    expect(JSON.parse(body.get("import")!).Name).toBe("Test Championship")
  })

  it("posts multipart when the form is a file input", async () => {
    const { s, posts, ready } = on(fakeImportPage("file", "championshipFile"))
    await ready
    const result = await importChampionship(s, championship())

    expect(result.mechanism).toEqual({ kind: "file", field: "championshipFile" })
    const body = posts[0]!.init.body as FormData
    expect(body).toBeInstanceOf(FormData)
    expect(body.get("championshipFile")).toBeInstanceOf(Blob)
  })

  it("explains a rejected import, which ACSM reports as a 200", async () => {
    // No redirect means ACSM added an error flash and re-rendered the page.
    const { fn } = scriptedFetch((url, init) =>
      url.endsWith("/login")
        ? new Response("", { status: 302, headers: { "set-cookie": sessionCookie, location: "/" } })
        : init.method === "POST"
          ? new Response(fakeImportPage("textarea"), { status: 200 })
          : new Response(fakeImportPage("textarea"), { status: 200 }),
    )
    const s = new AcsmSession({ baseUrl: "https://acsm.example", fetch: fn })
    await s.login({ username: "admin", password: "x" })

    await expect(importChampionship(s, championship())).rejects.toThrow(
      /didn't accept the championship.*form field import/s,
    )
  })

  it("says what it found when the form has neither control", async () => {
    const { s, ready } = on(
      `<html><body><form method="post" action="/championship/import">
         <input type="text" name="somethingElse" value="">
       </form></body></html>`,
    )
    await ready
    await expect(detectImportMechanism(s)).rejects.toThrow(/neither a file input nor a textarea/)
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

  const IMPORTED_ID = "99999999-8888-7777-6666-555555555555"
  const EXISTING_ID = "11111111-2222-3333-4444-555555555555"

  /**
   * A session where the import itself always succeeds, so the only thing that
   * can refuse is the target check.
   *
   * `target` is what GET /championship/{id}/export answers with, since that is
   * how the guard now looks at the server — through the session, not a reader.
   * GETs of the import page must still serve HTML; that is how
   * detectImportMechanism finds where to put the JSON.
   */
  const importSession = async (target?: Championship | Response) => {
    const { fn } = scriptedFetch((url, init) => {
      if (url.endsWith("/login")) {
        return new Response("", {
          status: 302,
          headers: { "set-cookie": sessionCookie, location: "/" },
        })
      }
      if (init.method === "POST") {
        return new Response("", {
          status: 302,
          headers: { location: `/championship/${IMPORTED_ID}` },
        })
      }
      if (url.includes("/export")) {
        if (target instanceof Response) return target
        if (target) return new Response(JSON.stringify(target), { status: 200 })
        return new Response("not found", { status: 404, statusText: "Not Found" })
      }
      return new Response(fakeImportPage("textarea"), { status: 200 })
    })
    const s = new AcsmSession({ baseUrl: "https://acsm.example", fetch: fn })
    await s.login({ username: "admin", password: "x" })
    return s
  }

  it("checks the target through the session, not a reader", async () => {
    // A reader could be a StaticAcsmReader, point at another host, or serve
    // HttpAcsmReader's response cache — and a stale results-free copy would
    // authorise overwriting a championship that has since been raced. The
    // session is the server being written to and doesn't cache.
    const s = await importSession(
      championship({
        ID: EXISTING_ID,
        Events: [raceEvent({ StartedTime: "2026-07-01T19:00:00-07:00" })],
      }),
    )
    await expect(
      importChampionship(s, championship({ ID: EXISTING_ID }), { freshIds: false }),
    ).rejects.toThrow(/has results for round 1/)
  })

  it("treats a 404 from the export as 'that ID is free'", async () => {
    const s = await importSession()
    await expect(
      importChampionship(s, championship({ ID: EXISTING_ID }), { freshIds: false }),
    ).resolves.toMatchObject({ championshipId: IMPORTED_ID })
  })

  it("refuses rather than guessing when the target can't be read", async () => {
    // A 500 or a timeout must not read as "nothing there" — the next thing
    // that happens is an import that overwrites a live championship.
    const s = await importSession(new Response("boom", { status: 500 }))
    await expect(
      importChampionship(s, championship({ ID: EXISTING_ID }), { freshIds: false }),
    ).rejects.toThrow(/Couldn't read championship/)
  })

  it("needs no extra plumbing when generating fresh IDs, since nothing can collide", async () => {
    const s = await importSession(
      championship({ Events: [raceEvent({ StartedTime: "2026-07-01T19:00:00-07:00" })] }),
    )
    // Fresh IDs, so the target is never consulted at all.
    await expect(
      importChampionship(s, championship({ ID: EXISTING_ID })),
    ).resolves.toMatchObject({ championshipId: IMPORTED_ID })
  })

  it("refuses to overwrite a target that has results, even with allowOverwrite", async () => {
    const live = championship({
      ID: EXISTING_ID,
      Events: [
        raceEvent({ StartedTime: "2026-07-01T19:00:00-07:00" }),
        raceEvent({ Scheduled: "2026-09-09T19:00:00-07:00" }),
      ],
    })
    for (const allowOverwrite of [false, true]) {
      const s = await importSession(live)
      await expect(
        importChampionship(s, championship({ ID: EXISTING_ID }), {
          freshIds: false,
          allowOverwrite,
        }),
      ).rejects.toThrow(/has results for round 1/)
    }
  })

  it("refuses an existing results-free target unless allowOverwrite is set", async () => {
    const s = await importSession(championship({ ID: EXISTING_ID }))
    await expect(
      importChampionship(s, championship({ ID: EXISTING_ID }), { freshIds: false }),
    ).rejects.toThrow(/already exists on this server/)
  })

  it("allows overwriting a results-free target when asked", async () => {
    const s = await importSession(championship({ ID: EXISTING_ID }))
    await expect(
      importChampionship(s, championship({ ID: EXISTING_ID }), {
        freshIds: false,
        allowOverwrite: true,
      }),
    ).resolves.toMatchObject({ championshipId: IMPORTED_ID })
  })

  it("matches the target ID case-insensitively", async () => {
    // ACSM writes UUIDs lower-case, but the ID may have been typed or pasted.
    // A case difference is not a mismatch, and treating it as one would look
    // like a server fault.
    const s = await importSession(championship({ ID: EXISTING_ID.toUpperCase() }))
    await expect(
      importChampionship(s, championship({ ID: EXISTING_ID }), { freshIds: false }),
    ).rejects.toThrow(/already exists on this server/)
  })

  describe("a 200 that isn't the championship we asked for", () => {
    // getJson casts; it does not validate. Each of these parses fine and has
    // no events, so startedRounds() calls it results-free — which is the one
    // answer that lets allowOverwrite proceed. The guard has to reject them
    // before that, or "fail closed" isn't true.
    const notOurChampionship: [string, string, RegExp][] = [
      ["JSON null", "null", /JSON null/],
      ["an empty object", "{}", /no ID field/],
      ["an array", "[]", /JSON array/],
      ["a bare string", '"nope"', /bare JSON string/],
      ["an error envelope", '{"error":"nope"}', /no ID field/],
      ["a non-string ID", '{"ID":42}', /ID that is a number/],
      [
        "a different championship",
        '{"ID":"deadbeef-0000-0000-0000-000000000000"}',
        /different championship \(deadbeef/,
      ],
    ]

    for (const [what, body, expected] of notOurChampionship) {
      it(`refuses when the export is ${what}, even with allowOverwrite`, async () => {
        const s = await importSession(new Response(body, { status: 200 }))
        await expect(
          importChampionship(s, championship({ ID: EXISTING_ID }), {
            freshIds: false,
            allowOverwrite: true,
          }),
        ).rejects.toThrow(expected)
      })
    }
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

  it("forgives a zero value that came back absent, which is Go's omitempty", () => {
    // Sending Sessions:{} / ExportSecondRaceToACSR:false and getting nothing
    // back means the value survived; Go just didn't serialise it.
    const before = { Sessions: {}, ExportSecondRaceToACSR: false, Tags: [], Note: "" }
    expect(diff(before, {}, { omitEmpty: true })).toEqual([])
    // ...and without the flag they're all reported.
    expect(diff(before, {}).length).toBe(4)
  })

  it("still reports a non-zero value that came back absent", () => {
    // This is how the missing Description field showed up: sent a real string,
    // got nothing, because 1.7.9's struct has no such field.
    const changes = diff({ Description: "A real description" }, {}, { omitEmpty: true })
    expect(changes).toEqual([
      { path: "Description", kind: "removed", before: "A real description" },
    ])
  })

  it("compares timestamps as instants, not text", () => {
    // Go trims trailing zeros off fractional seconds.
    const before = { Created: "2026-08-24T23:17:58.140Z" }
    const after = { Created: "2026-08-24T23:17:58.14Z" }
    expect(diff(before, after, { timestampsAsInstants: true })).toEqual([])
    expect(diff(before, after)).toHaveLength(1)
  })

  it("does not treat different instants as equal", () => {
    const changes = diff(
      { Created: "2026-08-24T23:17:58Z" },
      { Created: "2026-08-24T23:17:59Z" },
      { timestampsAsInstants: true },
    )
    expect(changes).toHaveLength(1)
  })

  it("leaves non-timestamp strings alone", () => {
    const changes = diff({ Name: "a" }, { Name: "b" }, { timestampsAsInstants: true })
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
