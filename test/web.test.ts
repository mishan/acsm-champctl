/**
 * The web API, driven end to end over a scripted ACSM.
 *
 * Nothing here mocks champctl's own code. The server is built with the real
 * session store, the real plan store, the real `AcsmSession` and the real
 * finalize engine; only `fetch` is a script. That is what lets a test say
 * "nothing was written" and mean it — `posts` is every POST that left the
 * process *except* the login, so a refusal that leaks a write fails here
 * rather than on a Wednesday. Login is excluded because every test starts with
 * one and counting it would make the interesting number 1 instead of 0. Reads
 * are not recorded at all; this is about writes.
 *
 * The tests that matter most are the ones asserting a refusal, because a
 * refusal that silently stopped refusing looks exactly like everything working.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { FastifyInstance } from "fastify"
import { afterEach, describe, expect, it } from "vitest"

import { StaticAcsmReader } from "../src/acsm/client.js"
import { IMPORT_PATH } from "../src/acsm/paths.js"
import { AcsmSession } from "../src/acsm/session.js"
import type { Championship } from "../src/acsm/types.js"
import type { FinalizePlan } from "../src/finalize/plan.js"
import { ContentCache } from "../src/web/content-cache.js"
import { PlanStore } from "../src/web/plans.js"
import type { HeldChampionship } from "../src/web/routes.js"
import type { NewChampionshipResponse, NewChampionshipPlanResponse } from "../src/web/wire.js"
import { buildServer } from "../src/web/server.js"
import { SessionStore } from "../src/web/sessions.js"
import { LoginThrottle } from "../src/web/throttle.js"
import {
  eventFormHtml,
  fakeImportPage,
  scheduleFormHtml,
  type FormEntrant,
} from "./support/acsm-html.js"
import {
  championship,
  driver,
  entryList,
  NOW,
  pitTable,
  raceEvent,
  suzukaPits,
  testProfile,
} from "./support/build.js"

const CHAMP_ID = "11111111-2222-3333-4444-555555555555"
/** What ACSM redirects to after an import; the only source of the new id. */
const IMPORTED_ID = "99999999-8888-7777-6666-555555555555"
const EVENT_ID = "event-1"
const BASE_URL = "https://acsm.example"

const TWO: FormEntrant[] = [
  { name: "Ada", guid: "76561198000000001", pit: 0 },
  { name: "Grace", guid: "76561198000000002", pit: 1 },
]

const champ = (over: Partial<Championship> = {}): Championship =>
  championship({
    ID: CHAMP_ID,
    Name: "Test Championship",
    Events: [
      raceEvent({
        ID: EVENT_ID,
        Scheduled: "2026-09-02T19:00:00-07:00",
        EntryList: entryList([driver("Ada"), driver("Grace")]),
        RaceSetup: { Sessions: { RACE: { Name: "Race", Time: 0, Laps: 20, IsOpen: 1 } } },
      }),
    ],
    ...over,
  })

interface HarnessOptions {
  championship?: Championship
  /** Event HTML per GET, in order; the last is reused. */
  eventPages?: string[]
  /** Fail the login POST, as ACSM does for a bad password: 200 and the form. */
  badLogin?: boolean
  /** Fail the login POST the way an unwell ACSM does, rather than a wrong password. */
  loginOutage?: "5xx" | "transport"
  sessions?: SessionStore
  plans?: PlanStore<FinalizePlan>
  /** How ACSM answers the import POST. Default: the redirect a real one sends. */
  importOutcome?: "no-redirect"
  newChampionships?: PlanStore<HeldChampionship>
  /** Installed cars and tracks. Default: whatever the static reader has, i.e. none. */
  content?: ContentCache
  throttle?: LoginThrottle
  /**
   * Held open until the test resolves it, so two requests can be in the write
   * at once. Without something like this a "concurrent" test is two sequential
   * awaits that would pass against the racy version too.
   */
  postGate?: Promise<void>
}

interface Harness {
  app: FastifyInstance
  posts: { url: string; body: string }[]
  cookie: () => string
  login: (username?: string, password?: string) => Promise<string>
}

const open: FastifyInstance[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map((a) => a.close()))
})

function harness(options: HarnessOptions = {}): Harness {
  const posts: { url: string; body: string }[] = []
  const pages = options.eventPages ?? [eventFormHtml(CHAMP_ID, TWO)]
  let eventGets = 0
  let stored = ""

  const fetchImpl: typeof globalThis.fetch = async (input, init = {}) => {
    const url = String(input)
    if (url.endsWith("/login")) {
      // A wrong password is ACSM re-rendering the login page with a 200, not a
      // 401. Getting that wrong is how a failed login used to look like a
      // working one.
      if (options.badLogin) return new Response("<form action='/login'>", { status: 200 })
      if (options.loginOutage === "5xx") {
        return new Response("nope", { status: 502, statusText: "Bad Gateway" })
      }
      if (options.loginOutage === "transport") throw new TypeError("fetch failed")
      return new Response("", {
        status: 302,
        headers: { "set-cookie": "_acsm_data=x; Path=/", location: "/" },
      })
    }
    if (init.method === "POST") {
      posts.push({ url, body: String(init.body) })
      if (options.postGate) await options.postGate
      // An import redirects to the championship it made, and that redirect is
      // the only thing that tells champctl the id. Anything else redirects to
      // "/", as ACSM does for an event save.
      if (url.endsWith(IMPORT_PATH)) {
        if (options.importOutcome === "no-redirect") {
          return new Response("<html>ok</html>", { status: 200 })
        }
        return new Response("", {
          status: 302,
          headers: { location: `/championship/${IMPORTED_ID}` },
        })
      }
      return new Response("", { status: 302, headers: { location: "/" } })
    }
    if (url.endsWith(IMPORT_PATH)) {
      // 1.7.9 renders a textarea here and 2.4.x a file input; either drives
      // the same path, and `detectImportMechanism` is what tells them apart.
      return new Response(fakeImportPage("textarea"), { status: 200 })
    }
    // The schedule form is rendered on the *championship* page, not at its own
    // action — that route is POST-only and a GET of it is a 405 on 2.4.x. This
    // double served it from the action URL, so these tests passed against a
    // shape no real manager would answer.
    if (url.includes(`/championship/${CHAMP_ID}`) && !url.includes("/event/")) {
      return new Response(scheduleFormHtml(CHAMP_ID, EVENT_ID), { status: 200 })
    }
    const page = pages[Math.min(eventGets, pages.length - 1)] as string
    eventGets++
    return new Response(page, { status: 200 })
  }

  const app = buildServer({
    profile: testProfile(),
    baseUrl: BASE_URL,
    reader: new StaticAcsmReader([options.championship ?? champ()]),
    pits: pitTable([suzukaPits]),
    // A real session over a scripted socket: the cookie jar, the redirect
    // rules and the entry-list arity check are all the production ones.
    createSession: (baseUrl) => new AcsmSession({ baseUrl, fetch: fetchImpl, rateLimit: false }),
    ...(options.sessions ? { sessions: options.sessions } : {}),
    ...(options.plans ? { plans: options.plans } : {}),
    ...(options.newChampionships ? { newChampionships: options.newChampionships } : {}),
    ...(options.content ? { content: options.content } : {}),
    ...(options.throttle ? { throttle: options.throttle } : {}),
    // Off so the Set-Cookie assertions below are about SameSite and HttpOnly
    // rather than about a flag every test would have to opt out of anyway.
    secureCookies: false,
    now: () => NOW,
    logger: false,
  })
  open.push(app)

  const login = async (username = "admin", password = "x"): Promise<string> => {
    const res = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username, password },
    })
    stored = firstCookie(res.headers["set-cookie"])
    return stored
  }

  return { app, posts, cookie: () => stored, login }
}

function firstCookie(header: string | string[] | number | undefined): string {
  const line = Array.isArray(header) ? header[0] : header
  return String(line ?? "").split(";")[0] ?? ""
}

/** The plan endpoint, already logged in. Return type inferred from inject. */
function preview(h: Harness, body: Record<string, unknown> = { laps: 18 }, round = 1) {
  return h.app.inject({
    method: "POST",
    url: `/api/championships/${CHAMP_ID}/rounds/${round}/plan`,
    headers: { cookie: h.cookie() },
    payload: body,
  })
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/**
 * Everything the API serves, and whether it is reachable logged out.
 *
 * Maintained by hand, which is the weakness of this test and worth stating: a
 * route added without a line here is simply not covered. What it does catch is
 * the failure that matters — a route that was protected becoming public — and
 * `config.public` being opt-*out* means the default for anything forgotten is
 * still "requires a session".
 */
const ROUTES: { method: "GET" | "POST"; url: string; public: boolean }[] = [
  { method: "GET", url: "/api/config", public: true },
  { method: "GET", url: "/api/session", public: true },
  { method: "POST", url: "/api/login", public: true },
  { method: "POST", url: "/api/logout", public: true },
  { method: "GET", url: "/api/championships", public: false },
  { method: "GET", url: `/api/championships/${CHAMP_ID}`, public: false },
  { method: "POST", url: `/api/championships/${CHAMP_ID}/rounds/1/plan`, public: false },
  { method: "POST", url: "/api/plans/whatever/apply", public: false },
]

describe("authentication", () => {
  it.each(ROUTES.filter((r) => !r.public))("$method $url needs a session", async (route) => {
    const h = harness()
    const res = await h.app.inject({ method: route.method, url: route.url, payload: {} })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe("not-authenticated")
  })

  it.each(ROUTES.filter((r) => r.public))("$method $url does not", async (route) => {
    const h = harness()
    const res = await h.app.inject({
      method: route.method,
      url: route.url,
      payload: { username: "admin", password: "x" },
    })
    expect(res.statusCode).not.toBe(401)
  })

  it("reports a cold page load as logged out rather than as an error", async () => {
    // 200 with authenticated:false, not 401. Nobody being logged in yet is the
    // ordinary state of a first visit, and reporting it as a failure puts an
    // error in the console and the logs on every single one.
    const h = harness()
    const res = await h.app.inject({ method: "GET", url: "/api/session" })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ authenticated: false })
  })

  it("hands back a cookie script can't read and a cross-site POST can't ride", async () => {
    const h = harness()
    const res = await h.app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "admin", password: "x" },
    })
    expect(res.statusCode).toBe(200)
    const setCookie = String(res.headers["set-cookie"])
    expect(setCookie).toContain("HttpOnly")
    expect(setCookie).toContain("SameSite=Lax")
    // The ACSM cookie stays server-side; the browser gets an opaque handle.
    expect(setCookie).not.toContain("_acsm_data")
    expect(res.json().username).toBe("admin")
  })

  it("refuses a bad password without setting a session", async () => {
    const h = harness({ badLogin: true })
    const res = await h.app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "admin", password: "wrong" },
    })
    expect(res.statusCode).toBe(401)
    expect(res.headers["set-cookie"]).toBeUndefined()
  })

  it("says a session expired rather than that you were never logged in", async () => {
    // Different words on screen for the same status code: one means "log in",
    // the other means "you did, an hour ago". An expired cookie is also
    // cleared, so the next request doesn't present a handle to a jar that no
    // longer exists.
    let clock = 0
    const h = harness({ sessions: new SessionStore({ ttlMs: 1000, now: () => clock }) })
    await h.login()

    clock = 2000
    const res = await h.app.inject({
      method: "GET",
      url: "/api/championships",
      headers: { cookie: h.cookie() },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe("session-expired")
    expect(String(res.headers["set-cookie"])).toContain("Max-Age=0")
  })

  it("stops forwarding guesses to ACSM after enough failures", async () => {
    // Without this the login endpoint is a credential-testing oracle for the
    // league's admin panel that also launders the source address: every
    // attempt reaches ACSM from champctl's host.
    const h = harness({ badLogin: true, throttle: new LoginThrottle({ maxFailures: 3 }) })
    const attempt = () =>
      h.app.inject({
        method: "POST",
        url: "/api/login",
        payload: { username: "admin", password: "wrong" },
      })

    expect((await attempt()).statusCode).toBe(401)
    expect((await attempt()).statusCode).toBe(401)
    expect((await attempt()).statusCode).toBe(401)
    const blocked = await attempt()
    expect(blocked.statusCode).toBe(429)
    expect(blocked.headers["retry-after"]).toBeDefined()
  })

  /**
   * An ACSM that is down is not being guessed at.
   *
   * Every login exception used to spend the allowance, so a handful of
   * timeouts or 502s during an outage locked the address out for another
   * fifteen minutes *after* the service recovered — punishing someone who
   * never typed a wrong password, at exactly the moment they were trying to
   * get back in.
   */
  it.each(["5xx", "transport"] as const)(
    "does not spend the login allowance on an ACSM %s failure",
    async (mode) => {
      const throttle = new LoginThrottle({ maxFailures: 3 })
      const down = harness({ loginOutage: mode, throttle })
      const attempt = (h: Harness) =>
        h.app.inject({
          method: "POST",
          url: "/api/login",
          payload: { username: "admin", password: "right" },
        })

      for (let i = 0; i < 5; i++) {
        const res = await attempt(down)
        expect(res.statusCode, "an outage is not a rejected credential").not.toBe(429)
      }

      // The allowance is intact, so the real password still works the moment
      // ACSM comes back.
      const recovered = harness({ throttle })
      expect((await attempt(recovered)).statusCode).toBe(200)
    },
  )

  /**
   * Every /api response varies by the httpOnly session cookie and none of it is
   * shared — a championship list is read with this person's ACSM credentials,
   * and /session answers with their username. A URL is identical between two
   * people and a cookie is not part of a shared cache's key, so a proxy would
   * be entitled to hand one person's session to the next. Running behind a
   * reverse proxy is a supported deployment, which makes "entitled to" a thing
   * that happens.
   */
  it("marks every API response uncacheable", async () => {
    const h = harness()
    await h.login()

    for (const url of ["/api/session", "/api/config", "/api/championships"]) {
      const res = await h.app.inject({ method: "GET", url, headers: { cookie: h.cookie() } })
      expect(res.headers["cache-control"], `${url} must not be cached`).toBe("no-store")
      expect(String(res.headers["vary"] ?? ""), `${url} varies by cookie`).toContain("Cookie")
    }
  })

  it("logs out for real, rather than only in the browser", async () => {
    // The client sends this with no body. Declaring Content-Type: application/json
    // on a bodyless POST makes Fastify reject it as an empty JSON body before
    // the route runs — so the UI switched to the login screen while the server
    // session stayed valid, and a reload signed the person straight back in.
    const h = harness()
    await h.login()
    const cookie = h.cookie()

    const out = await h.app.inject({
      method: "POST",
      url: "/api/logout",
      headers: { cookie, "content-type": "application/json" },
    })
    expect(out.statusCode, "a bodyless logout must be accepted").toBeLessThan(400)

    const after = await h.app.inject({ method: "GET", url: "/api/session", headers: { cookie } })
    expect(after.json()).toMatchObject({ authenticated: false })
  })

  it("forgets the failures once a login works", async () => {
    const throttle = new LoginThrottle({ maxFailures: 3 })
    const bad = harness({ badLogin: true, throttle })
    await bad.app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "a", password: "x" },
    })
    await bad.app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "a", password: "x" },
    })

    const good = harness({ throttle })
    expect(
      (
        await good.app.inject({
          method: "POST",
          url: "/api/login",
          payload: { username: "a", password: "right" },
        })
      ).statusCode,
    ).toBe(200)

    // The two earlier failures no longer count, so a fresh mistake doesn't
    // immediately trip a limit the person has already cleared.
    const after = harness({ badLogin: true, throttle })
    expect(
      (
        await after.app.inject({
          method: "POST",
          url: "/api/login",
          payload: { username: "a", password: "x" },
        })
      ).statusCode,
    ).toBe(401)
  })

  it("calls a malformed body a bad request, not a crash", async () => {
    // The content-type parser marks it 400; the error handler used to ignore
    // that and report a SyntaxError as champctl having fallen over — logged as
    // an unhandled error for someone to go and investigate a typo in a curl
    // command.
    const h = harness()
    await h.login()
    const res = await h.app.inject({
      method: "POST",
      url: `/api/championships/${CHAMP_ID}/rounds/1/plan`,
      headers: { cookie: h.cookie(), "content-type": "application/json" },
      payload: '{"laps": 18',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe("bad-json")
    expect(h.posts).toHaveLength(0)
  })

  it("treats a POST with no body at all as a request for no change", async () => {
    // `fetch(url, { method: "POST" })` sends no Content-Type, so Fastify runs
    // no parser and the body is undefined. The schemas say `type: "object"`,
    // so without normalising this first the caller gets "body must be object"
    // for a request that meant exactly what the handler already supports.
    const h = harness()
    await h.login()
    const res = await h.app.inject({
      method: "POST",
      url: `/api/championships/${CHAMP_ID}/rounds/1/plan`,
      headers: { cookie: h.cookie() },
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(h.posts).toHaveLength(0)
  })

  it("still treats an empty body as a request for no change", async () => {
    // Distinct from malformed. `fetch(url, {method:"POST"})` with no body is a
    // perfectly meaningful "preview the round as it stands".
    const h = harness()
    await h.login()
    const res = await h.app.inject({
      method: "POST",
      url: `/api/championships/${CHAMP_ID}/rounds/1/plan`,
      headers: { cookie: h.cookie(), "content-type": "application/json" },
      payload: "",
    })
    expect(res.statusCode, res.body).toBe(200)
  })

  it("refuses a write that came from somewhere else", async () => {
    const h = harness()
    await h.login()
    const res = await h.app.inject({
      method: "POST",
      url: `/api/championships/${CHAMP_ID}/rounds/1/plan`,
      headers: { cookie: h.cookie(), origin: "https://evil.example" },
      payload: { laps: 18 },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe("cross-origin")
  })

  it("lets a write through when the browser omitted the default port", async () => {
    // A browser writes `https://league.example` and never
    // `https://league.example:443`, while `Host` carries whatever was in the
    // URL or whatever a proxy put there. Comparing the two as strings turns a
    // person sitting on the site into a 403.
    const h = harness()
    await h.login()
    for (const [origin, host] of [
      ["https://league.example", "league.example:443"],
      ["http://league.example", "league.example:80"],
      ["http://localhost:8080", "localhost:8080"],
      ["https://LEAGUE.example", "league.example"],
    ] as const) {
      const res = await h.app.inject({
        method: "POST",
        url: `/api/championships/${CHAMP_ID}/rounds/1/plan`,
        headers: { cookie: h.cookie(), origin, host },
        payload: { laps: 18 },
      })
      expect(res.statusCode, `${origin} against ${host}`).not.toBe(403)
    }
  })

  it("still refuses an Origin the browser declined to name", async () => {
    // A sandboxed iframe sends `Origin: null`, which is a browser saying it
    // will not vouch for where this came from.
    const h = harness()
    await h.login()
    const res = await h.app.inject({
      method: "POST",
      url: `/api/championships/${CHAMP_ID}/rounds/1/plan`,
      headers: { cookie: h.cookie(), origin: "null", host: "league.example" },
      payload: { laps: 18 },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe("cross-origin")
  })
})

// ---------------------------------------------------------------------------
// Previewing
// ---------------------------------------------------------------------------

describe("previewing a change", () => {
  it("describes the change and the fields, and writes nothing", async () => {
    const h = harness()
    await h.login()
    const res = await preview(h, { laps: 18 })

    expect(res.statusCode).toBe(200)
    const { plan } = res.json()
    expect(plan.changes).toContainEqual({
      label: "Race length",
      before: "20 laps",
      after: "18 laps",
    })
    expect(plan.formChanges).toContainEqual({ name: "Race.Laps", before: "20", after: "18" })
    expect(plan.noop).toBe(false)

    // The whole point of plan-then-apply: previewing is a read, so no write
    // left the process. (Login is a POST too, and deliberately not counted.)
    expect(h.posts).toHaveLength(0)
  })

  it("does not send the entry list to the browser", async () => {
    // A preview reads the rendered event form, which carries every entrant's
    // name and Steam GUID. The finalize screen sets a lap count; it has no use
    // for any of that, and the export it comes from is public but this
    // response is not the place to republish it.
    const h = harness()
    await h.login()
    const res = await preview(h, { laps: 18 })

    expect(res.payload).not.toContain("76561198000000001")
    expect(res.payload).not.toContain("Ada")
    expect(res.payload).not.toContain("EntryList")
  })

  it("changes only what it was asked to change", async () => {
    // "18 laps" means make it 18 laps, not "and reset everything I didn't
    // mention". Same rule the CLI documents, same implementation.
    const h = harness()
    await h.login()
    const { plan } = (await preview(h, { laps: 18 })).json()
    expect(plan.formChanges.map((f: { name: string }) => f.name)).toEqual(["Race.Laps"])
  })

  it("refuses laps and minutes together", async () => {
    const h = harness()
    await h.login()
    const res = await preview(h, { laps: 18, minutes: 40 })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe("length-ambiguous")
  })

  it("refuses a lap count that would not survive being turned into a string", async () => {
    // `formFieldsFor` posts `String(laps)`, and 1e30 is an integer as far as
    // both JSON Schema and Number.isInteger are concerned — it stringifies to
    // "1e+30", which ACSM parses as zero. A race with no end condition.
    const h = harness()
    await h.login()
    const res = await preview(h, { laps: 1e30 })
    expect(res.statusCode).toBe(400)
    expect(h.posts).toHaveLength(0)
  })

  it("says there is nothing to do rather than pretending there is", async () => {
    const h = harness()
    await h.login()
    const { plan } = (await preview(h, { laps: 20 })).json()
    expect(plan.noop).toBe(true)
    expect(plan.changes).toEqual([])
  })

  it("reports a round that doesn't exist as a 404 naming how many there are", async () => {
    const h = harness()
    await h.login()
    const res = await preview(h, { laps: 18 }, 7)
    expect(res.statusCode).toBe(404)
    expect(res.json().error.message).toContain("it has 1")
  })

  it("checks the championship as it would be, not as it is", async () => {
    // Moving the race onto a Saturday has to say so *before* it is sent. A
    // check against the current championship would report yesterday's problems
    // and miss the one this change is about to introduce.
    const h = harness()
    await h.login()
    const { plan } = (
      await preview(h, { laps: 18, quali: { date: "2026-09-12", time: "20:00" } })
    ).json()
    expect(plan.gridmom.findings.map((f: { code: string }) => f.code)).toContain("schedule.weekday")
    expect(plan.needsAcknowledgement).toBe(true)
    expect(plan.schedule.to).toContain("2026-09-12 20:00")
  })

  it("refuses a wall clock the league's zone doesn't have", async () => {
    const h = harness()
    await h.login()
    // 02:30 on the morning the clocks go forward in America/Los_Angeles.
    const res = await preview(h, { quali: { date: "2027-03-14", time: "02:30" } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe("schedule")
  })
})

// ---------------------------------------------------------------------------
// Pushing
// ---------------------------------------------------------------------------

async function planId(h: Harness, body: Record<string, unknown> = { laps: 18 }): Promise<string> {
  const res = await preview(h, body)
  return res.json().plan.planId as string
}

function push(h: Harness, id: string, body: Record<string, unknown> = {}) {
  return h.app.inject({
    method: "POST",
    url: `/api/plans/${id}/apply`,
    headers: { cookie: h.cookie() },
    payload: body,
  })
}

describe("pushing a change", () => {
  it("posts the event form with the new length", async () => {
    const h = harness()
    await h.login()
    const res = await push(h, await planId(h))

    expect(res.statusCode).toBe(200)
    expect(res.json().eventSaved).toBe(true)

    const submit = h.posts.find((p) => p.url.endsWith("/event/submit"))
    expect(submit).toBeDefined()
    const sent = new URLSearchParams(submit!.body)
    expect(sent.get("Race.Laps")).toBe("18")
    expect(sent.get("action")).toBe("saveChampionship")
    expect(sent.get("Editing")).toBe(EVENT_ID)
    // The entry list is round-tripped rather than rebuilt, so both entrants
    // still have their pit boxes.
    expect(sent.getAll("EntryList.EntrantID")).toEqual(["0", "1"])
  })

  it("takes a plan id and nothing else", async () => {
    // The push body carries no lap count, so there is no second chance to
    // disagree with the preview. What was approved is what is sent.
    const h = harness()
    await h.login()
    const res = await push(h, await planId(h), { laps: 99 })
    expect(res.statusCode).toBe(400)
    expect(h.posts).toHaveLength(0)
  })

  it("won't spend a plan belonging to another session", async () => {
    const sessions = new SessionStore()
    const plans = new PlanStore<FinalizePlan>()
    const a = harness({ sessions, plans })
    const b = harness({ sessions, plans })
    await a.login("ada")
    await b.login("grace")

    const stolen = await planId(a)
    const res = await push(b, stolen)
    expect(res.statusCode).toBe(404)
    expect(b.posts).toHaveLength(0)
  })

  it("won't spend a plan twice", async () => {
    const h = harness()
    await h.login()
    const id = await planId(h)
    expect((await push(h, id)).statusCode).toBe(200)

    const again = await push(h, id)
    expect(again.statusCode).toBe(404)
    expect(h.posts.filter((p) => p.url.endsWith("/event/submit"))).toHaveLength(1)
  })

  /**
   * Genuinely concurrent, not two sequential awaits: the second request is
   * dispatched while the first is inside its POST, held there by `postGate`.
   * The sequential version of this test passes against the racy code, which is
   * the whole reason the gate exists.
   *
   * `plans.get` reserved nothing, so both requests could read the same plan and
   * both go on to POST the same event form — two full-form replaces racing over
   * one entry list, from a double-click or a retried request. The plan was
   * destroyed only after the write, too late to stop the second starting.
   */
  it("refuses a second apply while the first is still writing", async () => {
    let openGate = (): void => {}
    const gate = new Promise<void>((resolve) => {
      openGate = resolve
    })
    const h = harness({ postGate: gate })
    await h.login()
    const id = await planId(h)

    const first = push(h, id)
    // Wait until the first request is actually inside the POST, so the second
    // is dispatched mid-write rather than before it starts. Macrotask yields,
    // not microtask: the request pipeline has real async steps before it gets
    // there, and a microtask drain never lets them run.
    for (let i = 0; i < 200 && h.posts.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 1))
    }
    expect(h.posts.length, "the first request should be in its write by now").toBeGreaterThan(0)

    const second = await push(h, id)
    expect(second.statusCode, "the second must be turned away, not queued behind it").toBe(409)
    expect(second.json().error.code).toBe("plan-in-flight")

    openGate()
    expect((await first).statusCode).toBe(200)

    // The property that matters: one write, not two.
    expect(h.posts.filter((p) => p.url.endsWith("/event/submit"))).toHaveLength(1)
  })

  it("won't spend an expired plan", async () => {
    let clock = 0
    const h = harness({ plans: new PlanStore({ ttlMs: 1000, now: () => clock }) })
    await h.login()
    const id = await planId(h)
    clock = 2000

    expect((await push(h, id)).statusCode).toBe(404)
    expect(h.posts).toHaveLength(0)
  })

  it("refuses warnings without an acknowledgement, and keeps the plan for one", async () => {
    const h = harness()
    await h.login()
    const id = await planId(h, { laps: 18, quali: { date: "2026-09-12", time: "20:00" } })

    const refused = await push(h, id)
    expect(refused.statusCode).toBe(422)
    expect(h.posts).toHaveLength(0)

    // Ticking the box must not mean rebuilding the preview: making someone do
    // that to get past a warning is a reason to stop reading them.
    const accepted = await push(h, id, { acknowledgeWarnings: true })
    expect(accepted.statusCode).toBe(200)
    expect(h.posts.filter((p) => p.url.endsWith("/event/submit"))).toHaveLength(1)
  })

  it("sends the schedule as a second request, after the event", async () => {
    // The event submit form doesn't carry `Scheduled`, so moving quali is two
    // writes — and the order is what makes a failure leave a coherent state.
    const h = harness()
    await h.login()
    const id = await planId(h, { laps: 18, quali: { date: "2026-09-09", time: "20:00" } })
    const res = await push(h, id, { acknowledgeWarnings: true })

    expect(res.json()).toMatchObject({ eventSaved: true, scheduleSaved: true })
    const order = h.posts.map((p) => (p.url.includes("/schedule") ? "schedule" : "event"))
    expect(order).toEqual(["event", "schedule"])
  })

  it("is blocked by an error, and nothing is sent", async () => {
    // Duplicate pit boxes: ACSM's AddInPitBox overwrites on collision, so the
    // next form save drops the loser. Nothing overrides this.
    const h = harness({
      championship: champ({
        Events: [
          raceEvent({
            ID: EVENT_ID,
            Scheduled: "2026-09-02T19:00:00-07:00",
            EntryList: entryList([driver("Ada"), { ...driver("Grace"), PitBox: 0 }]),
            RaceSetup: { Sessions: { RACE: { Name: "Race", Time: 0, Laps: 20, IsOpen: 1 } } },
          }),
        ],
      }),
    })
    await h.login()

    const { plan } = (await preview(h, { laps: 18 })).json()
    expect(plan.blocked).toBe(true)

    const res = await push(h, plan.planId, { acknowledgeWarnings: true })
    expect(res.statusCode).toBe(422)
    expect(h.posts).toHaveLength(0)
  })

  it("refuses when the entry list moved under the preview, and drops the plan", async () => {
    // The sharpest edge in the tool: ACSM's event form replaces the whole
    // entry list, so a sign-up approved while a preview is open would be
    // silently deleted by the save. The second GET is the re-fetch before the
    // POST; it now has a third entrant.
    const h = harness({
      eventPages: [
        eventFormHtml(CHAMP_ID, TWO),
        eventFormHtml(CHAMP_ID, [...TWO, { name: "Linus", guid: "76561198000000003", pit: 2 }]),
      ],
    })
    await h.login()
    const id = await planId(h)

    const res = await push(h, id)
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe("entry-list-changed")
    expect(h.posts).toHaveLength(0)

    // Gone, so the obvious retry says "take a fresh look" rather than
    // refusing identically a second time.
    expect((await push(h, id)).statusCode).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Reads and session lifecycle
// ---------------------------------------------------------------------------

describe("reading a championship", () => {
  it("lists the rounds with their format and quali time", async () => {
    const h = harness()
    await h.login()
    const res = await h.app.inject({
      method: "GET",
      url: `/api/championships/${CHAMP_ID}`,
      headers: { cookie: h.cookie() },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.championship.rounds).toHaveLength(1)
    const round = body.championship.rounds[0]
    expect(round.round).toBe(1)
    expect(round.track).toBe("suzuka")
    expect(round.format.length).toEqual({ kind: "laps", laps: 20 })
    // Scheduled is practice start; quali is an hour later. Anyone reading
    // `Scheduled` as the quali time is an hour out.
    expect(round.quali.time).toBe("20:00")
    expect(round.practiceStart.time).toBe("19:00")
    expect(round.started).toBe(false)
  })

  it("shows an unscheduled round as unscheduled rather than as the year 1", async () => {
    // ACSM writes Go's zero time rather than omitting the field, and treating
    // `0001-01-01` as a real date produces a race two thousand years ago.
    const h = harness({
      championship: champ({
        Events: [raceEvent({ ID: EVENT_ID, Scheduled: "0001-01-01T00:00:00Z" })],
      }),
    })
    await h.login()
    const res = await h.app.inject({
      method: "GET",
      url: `/api/championships/${CHAMP_ID}`,
      headers: { cookie: h.cookie() },
    })
    expect(res.json().championship.rounds[0].quali).toBeNull()
  })

  it("runs gridmom over the championship as it stands", async () => {
    const h = harness({
      championship: champ({
        Events: [
          raceEvent({
            ID: EVENT_ID,
            EntryList: entryList([driver("Ada"), { ...driver("Grace"), PitBox: 0 }]),
          }),
        ],
      }),
    })
    await h.login()
    const res = await h.app.inject({
      method: "GET",
      url: `/api/championships/${CHAMP_ID}`,
      headers: { cookie: h.cookie() },
    })
    expect(res.json().gridmom.counts.ERROR).toBeGreaterThan(0)
  })

  it("lists championships as id and name", async () => {
    const h = harness()
    await h.login()
    const res = await h.app.inject({
      method: "GET",
      url: "/api/championships",
      headers: { cookie: h.cookie() },
    })
    expect(res.json().championships).toEqual([{ id: CHAMP_ID, name: "Test Championship" }])
  })
})

describe("logging out", () => {
  it("ends the session and its plans", async () => {
    const h = harness()
    await h.login()
    const id = await planId(h)

    const res = await h.app.inject({
      method: "POST",
      url: "/api/logout",
      headers: { cookie: h.cookie() },
    })
    expect(res.statusCode).toBe(204)
    expect(String(res.headers["set-cookie"])).toContain("Max-Age=0")

    // The plan held a parsed entry list. Dropping the session without dropping
    // its plans would leave that resident and unreachable until the TTL.
    const after = await push(h, id)
    expect(after.statusCode).toBe(401)
    expect(h.posts).toHaveLength(0)
  })

  it("works on a session that has already expired", async () => {
    // The browser still has a cookie to be rid of, and the one thing logout
    // must not do is leave it there.
    const h = harness()
    const res = await h.app.inject({
      method: "POST",
      url: "/api/logout",
      headers: { cookie: "champctl_session=long-gone" },
    })
    expect(res.statusCode).toBe(204)
    expect(String(res.headers["set-cookie"])).toContain("Max-Age=0")
  })
})

// ---------------------------------------------------------------------------
// Creating a championship (plan §5.1)
// ---------------------------------------------------------------------------

describe("previewing a new championship", () => {
  const planChampionship = async (h: Harness, body: Record<string, unknown> = {}) =>
    h.app.inject({
      method: "POST",
      url: "/api/championships/plan",
      headers: { cookie: h.cookie() },
      payload: { sourceId: CHAMP_ID, ...body },
    })

  it("builds a new championship from a past one, and writes nothing", async () => {
    const h = harness()
    await h.login()
    const res = await planChampionship(h, { name: "September 2026" })
    expect(res.statusCode, res.body).toBe(200)

    const { plan } = res.json() as NewChampionshipPlanResponse
    expect(plan.planId).toBeTruthy()
    expect(plan.sourceId).toBe(CHAMP_ID)
    expect(plan.name).toBe("September 2026")
    expect(plan.rounds.length).toBeGreaterThan(0)
    // Previewing is a read. The whole point of the two-step.
    expect(h.posts).toHaveLength(0)
  })

  it("replaces the track list rather than merging into it", async () => {
    // Same rule as `cloneChampionship`: someone who sends three tracks means three
    // race nights, and merging would silently keep a fourth from the source.
    const h = harness()
    await h.login()
    const res = await planChampionship(h, {
      name: "September 2026",
      tracks: [{ track: "spa" }, { track: "monza" }, { track: "brands_hatch", layout: "indy" }],
    })
    expect(res.statusCode, res.body).toBe(200)

    const { plan } = res.json() as NewChampionshipPlanResponse
    expect(plan.rounds.map((r: { track: string }) => r.track)).toEqual([
      "spa",
      "monza",
      "brands_hatch",
    ])
    expect(plan.rounds[2]?.layout).toBe("indy")
    expect(plan.rounds[2]?.label).toBe("brands_hatch/indy")
  })

  it("names the track that bound the grid", async () => {
    // §5.1 step 5. "Capped at 24" without saying by what leaves someone
    // guessing which track to go and change.
    const h = harness()
    await h.login()
    const res = await planChampionship(h, { name: "September 2026", tracks: [{ track: "suzuka" }] })
    const { plan } = res.json() as NewChampionshipPlanResponse
    expect(plan.grid.maxClients).toBeGreaterThan(0)
    expect(plan.grid.summary).toBeTruthy()
  })

  it("reports what the emitter decided rather than inherited", async () => {
    // Every entry here was a real bug once — an inherited `Created` claiming
    // the championship existed a month before it did, a car list naming a
    // spectator model that is switched off.
    const h = harness()
    await h.login()
    const { plan } = (
      await planChampionship(h, { name: "September 2026" })
    ).json() as NewChampionshipPlanResponse
    expect(plan.derived.length).toBeGreaterThan(0)
  })

  it("runs gridmom against the championship as it would be", async () => {
    const h = harness()
    await h.login()
    const { plan } = (
      await planChampionship(h, { name: "September 2026" })
    ).json() as NewChampionshipPlanResponse
    expect(plan.gridmom).toBeDefined()
    expect(plan.blocked).toBe(plan.gridmom.counts.ERROR > 0)
    expect(plan.needsAcknowledgement).toBe(plan.gridmom.counts.WARN > 0)
  })

  it("refuses an empty layout rather than reading it as no layout", async () => {
    // `roundSpecFrom` treats "" as "this track has no layout", so an empty
    // string would arrive looking like a deliberate choice and hide whatever
    // produced it. A track with no layout omits the key.
    const h = harness()
    await h.login()
    const res = await h.app.inject({
      method: "POST",
      url: "/api/championships/plan",
      headers: { cookie: h.cookie() },
      payload: {
        sourceId: CHAMP_ID,
        name: "September 2026",
        tracks: [{ track: "spa", layout: "" }],
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe("bad-request")
  })

  it("accepts a track with the layout key left off", async () => {
    const h = harness()
    await h.login()
    const res = await planChampionship(h, { name: "September 2026", tracks: [{ track: "spa" }] })
    expect(res.statusCode, res.body).toBe(200)
    expect((res.json() as NewChampionshipPlanResponse).plan.rounds[0]?.layout).toBeUndefined()
  })

  it("refuses a request with no source to clone", async () => {
    const h = harness()
    await h.login()
    const res = await h.app.inject({
      method: "POST",
      url: "/api/championships/plan",
      headers: { cookie: h.cookie() },
      payload: { name: "September 2026" },
    })
    expect(res.statusCode).toBe(400)
  })

  it("needs a session", async () => {
    const h = harness()
    const res = await h.app.inject({
      method: "POST",
      url: "/api/championships/plan",
      payload: { sourceId: CHAMP_ID },
    })
    expect(res.statusCode).toBe(401)
  })

  /**
   * The car list a clone inherits, made changeable.
   *
   * It was always inherited and never mentioned, so the screen asked which
   * tracks a championship runs at and never what anyone would drive — the one
   * thing about a championship that cannot be worked out from the rest of the
   * form. A different model from the fixture's on purpose: asserting the
   * source's own car would pass whether the override reached the emitter or
   * not.
   */
  it("takes a car list, and replaces the source's rather than adding to it", async () => {
    const h = harness()
    await h.login()
    const planId = await previewedWith(h, { cars: ["ks_porsche_911_gt3_r_2016"] })

    const created = await h.app.inject({
      method: "POST",
      url: `/api/championships/${planId}/create`,
      headers: { cookie: h.cookie() },
      payload: { acknowledgeWarnings: true },
    })
    expect(created.statusCode, created.body).toBe(200)

    const champ = importedChampionship(h)
    expect(champ.Classes?.[0]?.AvailableCars).toEqual(["ks_porsche_911_gt3_r_2016"])
    // Derived from the class list rather than inherited, which is the bug plan
    // §5.5 found: a template's `Cars` string outlived the class it came from.
    expect(champ.Events?.[0]?.RaceSetup?.Cars).toBe("ks_porsche_911_gt3_r_2016")
  })

  it("keeps the source's cars when none are named", async () => {
    const h = harness()
    await h.login()
    const planId = await previewedWith(h, {})
    await h.app.inject({
      method: "POST",
      url: `/api/championships/${planId}/create`,
      headers: { cookie: h.cookie() },
      payload: { acknowledgeWarnings: true },
    })
    expect(importedChampionship(h).Classes?.[0]?.AvailableCars).toEqual(["rss_formula_hybrid_2021"])
  })

  it("takes a description, and sends it as written", async () => {
    const h = harness()
    await h.login()
    const planId = await previewedWith(h, { description: "September, and five new tracks." })
    await h.app.inject({
      method: "POST",
      url: `/api/championships/${planId}/create`,
      headers: { cookie: h.cookie() },
      payload: { acknowledgeWarnings: true },
    })
    expect(importedChampionship(h).Description).toBe("September, and five new tracks.")
  })

  /**
   * An empty string is a value, and `""` is falsy — so a handler that tested
   * for truthiness would drop it and fall back to inheriting. That would put
   * the cloned championship's blurb on a championship whose author had just
   * cleared the box.
   */
  it("clears the description when asked to, rather than inheriting one", async () => {
    const h = harness({
      championship: champ({ Description: "August was a good month." }),
    })
    await h.login()
    const planId = await previewedWith(h, { description: "" })
    await h.app.inject({
      method: "POST",
      url: `/api/championships/${planId}/create`,
      headers: { cookie: h.cookie() },
      payload: { acknowledgeWarnings: true },
    })
    expect(importedChampionship(h).Description).toBe("")
  })

  it("keeps the source's description when none is named", async () => {
    const h = harness({
      championship: champ({ Description: "August was a good month." }),
    })
    await h.login()
    const planId = await previewedWith(h, {})
    await h.app.inject({
      method: "POST",
      url: `/api/championships/${planId}/create`,
      headers: { cookie: h.cookie() },
      payload: { acknowledgeWarnings: true },
    })
    expect(importedChampionship(h).Description).toBe("August was a good month.")
  })

  it("refuses an empty car list rather than reading it as 'inherit'", async () => {
    // `[]` is a class with no cars, not "leave it alone". The emitter refuses
    // it, and refusing at the schema says so about the request instead of
    // producing a 422 about something nobody asked for.
    const h = harness()
    await h.login()
    const res = await planChampionship(h, { name: "September 2026", cars: [] })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe("bad-request")
  })

  const previewedWith = async (h: Harness, body: Record<string, unknown>): Promise<string> => {
    const res = await planChampionship(h, { name: "September 2026", ...body })
    expect(res.statusCode, res.body).toBe(200)
    return (res.json() as NewChampionshipPlanResponse).plan.planId
  }

  /** The championship JSON that reached ACSM's import form. */
  const importedChampionship = (h: Harness): Championship => {
    const sent = h.posts.find((p) => p.url.endsWith(IMPORT_PATH))
    expect(sent, "the championship should have been imported").toBeTruthy()
    const field = new URLSearchParams(sent!.body).get("import")
    expect(field, "the import form's field should carry the championship").toBeTruthy()
    return JSON.parse(field as string) as Championship
  }
})

describe("what content is installed", () => {
  it("answers with the cars and tracks the reader found", async () => {
    const h = harness({
      content: new ContentCache({
        load: async () => ({
          cars: [{ id: "ks_porsche_911_gt3_r_2016", name: "Porsche 911 GT3 R" }],
          tracks: [{ id: "ks_brands_hatch", name: "Brands Hatch" }],
        }),
      }),
    })
    await h.login()
    const res = await h.app.inject({
      method: "GET",
      url: "/api/content",
      headers: { cookie: h.cookie() },
    })
    expect(res.statusCode, res.body).toBe(200)
    // Both halves: the folder name is what a championship stores, the display
    // name is the only part anybody knows.
    expect(res.json()).toEqual({
      cars: [{ id: "ks_porsche_911_gt3_r_2016", name: "Porsche 911 GT3 R" }],
      tracks: [{ id: "ks_brands_hatch", name: "Brands Hatch" }],
    })
  })

  it("needs a session, like every other read", async () => {
    // Not secrecy — it is a list of folder names — but it is champctl's most
    // expensive read, and it walks several pages of a league's manager.
    const h = harness()
    const res = await h.app.inject({ method: "GET", url: "/api/content" })
    expect(res.statusCode).toBe(401)
  })
})

describe("creating the championship", () => {
  const previewed = async (h: Harness, body: Record<string, unknown> = {}): Promise<string> => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/championships/plan",
      headers: { cookie: h.cookie() },
      payload: { sourceId: CHAMP_ID, name: "September 2026", ...body },
    })
    expect(res.statusCode, res.body).toBe(200)
    return (res.json() as NewChampionshipPlanResponse).plan.planId
  }

  const createChampionship = (h: Harness, planId: string, ack = true) =>
    h.app.inject({
      method: "POST",
      url: `/api/championships/${planId}/create`,
      headers: { cookie: h.cookie() },
      payload: { acknowledgeWarnings: ack },
    })

  it("imports the championship that was previewed and reports what ACSM made", async () => {
    const h = harness()
    await h.login()
    const res = await createChampionship(h, await previewed(h))
    expect(res.statusCode, res.body).toBe(200)

    const body = res.json() as NewChampionshipResponse
    expect(body.championshipId).toBe(IMPORTED_ID)
    expect(body.name).toBe("September 2026")
    expect(body.rounds).toBeGreaterThan(0)
    expect(h.posts.some((p) => p.url.endsWith(IMPORT_PATH))).toBe(true)
  })

  it("spends the plan once, so a double-tap cannot create two", async () => {
    // Sharper than the finalize equivalent: applying a format twice re-applies
    // something already applied, while importing twice leaves a league
    // two championships to tell apart and delete by hand.
    const h = harness()
    await h.login()
    const planId = await previewed(h)

    expect((await createChampionship(h, planId)).statusCode).toBe(200)
    const second = await createChampionship(h, planId)
    expect(second.statusCode).toBe(404)
    expect(second.json().error.code).toBe("no-such-plan")
    expect(h.posts.filter((p) => p.url.endsWith(IMPORT_PATH))).toHaveLength(1)
  })

  it("will not let another session spend it", async () => {
    const sessions = new SessionStore()
    const newChampionships = new PlanStore<HeldChampionship>()
    const a = harness({ sessions, newChampionships })
    const b = harness({ sessions, newChampionships })
    await a.login("ada")
    await b.login("grace")

    const planId = await previewed(a)
    const stolen = await createChampionship(b, planId)
    expect(stolen.statusCode).toBe(404)
    expect(b.posts.some((p) => p.url.endsWith(IMPORT_PATH))).toBe(false)
  })

  it("keeps the plan when the import is refused, so it can be retried", async () => {
    // The refusals are things the person can act on. Wedging it would
    // make them rebuild a preview they are looking at.
    const h = harness({ importOutcome: "no-redirect" })
    await h.login()
    const planId = await previewed(h)

    const first = await createChampionship(h, planId)
    expect(first.statusCode).toBe(502)
    // Still there: the same id works once ACSM is behaving.
    const second = await createChampionship(h, planId)
    expect(second.statusCode).toBe(502)
    expect(second.json().error.code).not.toBe("no-such-plan")
  })

  it("says what champctl refused rather than a generic gateway sentence", async () => {
    // `AcsmWriteError` messages are champctl's own, about the request, and
    // each names something to go and look at. The generic 502 sentence is
    // right for a transport failure and useless here.
    const h = harness({ importOutcome: "no-redirect" })
    await h.login()
    const res = await createChampionship(h, await previewed(h))
    expect(res.json().error.code).toBe("acsm-write")
    expect(res.json().error.message).toMatch(/redirect|championship/i)
  })

  it("refuses an id it never issued", async () => {
    const h = harness()
    await h.login()
    const res = await createChampionship(h, "not-a-plan")
    expect(res.statusCode).toBe(404)
  })
})

describe("serving the client", () => {
  it("answers an unknown API path with JSON rather than a page", async () => {
    // A mistyped endpoint answering 200 with HTML is a bug that surfaces as a
    // parse error somewhere far away from the mistake.
    const h = harness()
    const res = await h.app.inject({ method: "GET", url: "/api/nope" })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe("not-found")
  })

  describe("with a built client behind it", () => {
    // The SPA fallback only exists when there is a client to fall back to, so
    // the interesting cases are unreachable without one. A directory with an
    // index.html in it is the whole of what `registerClient` needs.
    let root = ""
    let app: FastifyInstance | undefined

    const serving = async (): Promise<FastifyInstance> => {
      if (app) return app
      root = await mkdtemp(join(tmpdir(), "champctl-client-"))
      await writeFile(join(root, "index.html"), "<!doctype html><title>champctl</title>")
      app = buildServer({
        profile: testProfile(),
        baseUrl: BASE_URL,
        reader: new StaticAcsmReader([champ()]),
        clientRoot: root,
        secureCookies: false,
        logger: false,
      })
      await app.ready()
      return app
    }

    afterEach(async () => {
      if (app) await app.close()
      app = undefined
      if (root) await rm(root, { recursive: true, force: true })
      root = ""
    })

    it("serves the page for a route the client owns", async () => {
      const res = await (await serving()).inject({ method: "GET", url: "/championships/abc" })
      expect(res.statusCode).toBe(200)
      expect(res.body).toContain("<!doctype html>")
    })

    it.each(["/api", "/api/", "/api?probe=1", "/api/nope", "/api/championships"])(
      "refuses %s as an API path rather than serving the page",
      async (url) => {
        // `/api` without the trailing slash is what a mistyped base URL
        // produces, and it used to fall through to index.html — 200, HTML, and
        // a parse error at the far end instead of a 404 at the near one.
        const res = await (await serving()).inject({ method: "GET", url })
        expect(res.statusCode, `${url} returned ${res.statusCode}`).not.toBe(200)
        expect(res.headers["content-type"]).toMatch(/json/)
      },
    )

    it("does not serve the page for a write to an unknown path", async () => {
      const res = await (await serving()).inject({ method: "POST", url: "/not-a-route" })
      expect(res.statusCode).toBe(404)
      expect(res.json().error.code).toBe("not-found")
    })
  })
})
