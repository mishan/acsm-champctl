/**
 * The HTTP API, against a real ACSM.
 *
 *   npm run harness:oss -- start
 *   CHAMPCTL_LIVE_URL=... CHAMPCTL_LIVE_PASSWORD=... npm run test:live
 *
 * The `--` is what CI uses and the form that works everywhere: npm 7 and later
 * forward a bare trailing argument too, but npm 6 silently swallows it and the
 * harness starts nothing while looking like it did.
 *
 * `test/web.test.ts` drives these same endpoints against a scripted `fetch`,
 * and `flows.live.test.ts` drives the same domain functions against a real
 * manager. What neither covers is the join: the web layer holding a live ACSM
 * session across requests, and a push made *through the API* actually landing
 * in the manager.
 *
 * That join is where the interesting failures live, because everything either
 * side of it is already green when it breaks. A session that logs in and then
 * cannot read, a plan computed from one request's cookies and applied with
 * another's, a Set-Cookie the browser will keep but ACSM won't honour — a
 * scripted fetch answers however the script says, so none of them show up.
 *
 * The server is built the way `champctl-serve` builds it, over `inject` rather
 * than a socket. Inject is Fastify's own request pipeline — hooks, schemas,
 * serialisation — so what is skipped is the TCP, not the server.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { HttpAcsmReader } from "../../src/acsm/client.js"
import { getAll, parseForm, setAt } from "../../src/acsm/form.js"
import { AcsmSession } from "../../src/acsm/session.js"
import type { Championship } from "../../src/acsm/types.js"
import { events } from "../../src/acsm/view.js"
import { eventEditPath, eventSubmitPath, importChampionship } from "../../src/acsm/write.js"
import { readFormat } from "../../src/finalize/format.js"
import type {
  ApplyResponse,
  MonthImportResponse,
  MonthPlanResponse,
  MonthPlanView,
  PlanResponse,
  PlanView,
} from "../../src/web/wire.js"
import { buildServer } from "../../src/web/server.js"
import { testProfile } from "../support/build.js"
import {
  assertWouldChange,
  deleteChampionship,
  lapsUnlikeSeed,
  LIVE,
  liveConfig,
  liveSession,
  loadFixture,
  SEED,
} from "./harness.js"

describe.skipIf(!LIVE)("the champctl API against a real ACSM", () => {
  let admin: AcsmSession | undefined
  let app: ReturnType<typeof buildServer> | undefined
  const created: string[] = []

  beforeAll(async () => {
    const config = liveConfig()
    if (!config) return
    admin = await liveSession()

    app = buildServer({
      profile: testProfile(),
      baseUrl: config.baseUrl,
      reader: new HttpAcsmReader({ baseUrl: config.baseUrl, rateLimit: false }),
      // Rate limiting off for the same reason `liveSession` turns it off: the
      // politeness delay is aimed at a league's production manager, and this
      // is a throwaway container the harness just started.
      createSession: (baseUrl) => new AcsmSession({ baseUrl, rateLimit: false }),
      // The cookie would otherwise carry `Secure`, and `inject` is http.
      secureCookies: false,
      logger: false,
    })
  }, 60_000)

  afterAll(async () => {
    if (app) await app.close()
    if (!admin) return
    for (const id of created) {
      try {
        await deleteChampionship(admin, id)
      } catch (e) {
        console.warn(`could not delete ${id}: ${e instanceof Error ? e.message : e}`)
      }
    }
  })

  const server = (): NonNullable<typeof app> => {
    if (!app) throw new Error("no server; beforeAll did not complete")
    return app
  }

  const live = (): AcsmSession => {
    if (!admin) throw new Error("no live session; beforeAll did not complete")
    return admin
  }

  /**
   * A logged-in browser, as a cookie header.
   *
   * Goes through `/api/login` rather than being fabricated, because what this
   * file is here to test starts with champctl forwarding real credentials to a
   * real manager and holding what comes back.
   */
  const loggedIn = async (): Promise<string> => {
    const config = liveConfig()
    if (!config) throw new Error("no live config")
    const res = await server().inject({
      method: "POST",
      url: "/api/login",
      payload: { username: config.username, password: config.password },
    })
    expect(res.statusCode, res.body).toBe(200)
    const cookie = res.headers["set-cookie"]
    const raw = Array.isArray(cookie) ? cookie[0] : cookie
    if (!raw) throw new Error("login returned no session cookie")
    return raw.split(";")[0] as string
  }

  /** A seed championship in the live manager, registered for teardown. */
  const seeded = async (): Promise<string> => {
    const { championshipId } = await importChampionship(live(), await loadFixture(SEED))
    if (championshipId) created.push(championshipId)
    if (!championshipId) throw new Error("import did not redirect to a new championship")
    return championshipId
  }

  const exported = async (id: string): Promise<Championship> =>
    live().getJson<Championship>(`/championship/${id}/export`)

  /**
   * Previews a month and returns the plan.
   *
   * Same reasoning as `planFor`: assert the status before reading the body, so
   * a failure lands on the request that failed rather than on whichever
   * assertion first touches an undefined plan.
   */
  const monthPlan = async (
    cookie: string,
    body: Record<string, unknown>,
  ): Promise<MonthPlanView> => {
    const res = await server().inject({
      method: "POST",
      url: "/api/months/plan",
      headers: { cookie },
      payload: body,
    })
    expect(res.statusCode, res.body).toBe(200)
    return (res.json() as MonthPlanResponse).plan
  }

  const importMonth = (planId: string, cookie: string) =>
    server().inject({
      method: "POST",
      url: `/api/months/${planId}/import`,
      headers: { cookie },
      payload: { acknowledgeWarnings: true },
    })

  /** An import that is meant to land, registered for teardown either way. */
  const imported = async (planId: string, cookie: string): Promise<MonthImportResponse> => {
    const res = await importMonth(planId, cookie)
    // Registered before the assertion: if the status is wrong but ACSM made
    // the championship anyway, the one case worth cleaning up is the one that
    // would otherwise leak.
    const body = res.json() as Partial<MonthImportResponse>
    if (body.championshipId) created.push(body.championshipId)
    expect(res.statusCode, res.body).toBe(200)
    return body as MonthImportResponse
  }

  /**
   * Previews a change and returns the plan.
   *
   * Asserts the 200 before reading the body, which is the whole reason this is
   * a helper rather than five copies of the same three lines. Reading
   * `.json()` off an unchecked response turns an auth or ACSM failure into
   * `Cannot read properties of undefined` several lines later, pointing at the
   * assertion that happened to touch the plan rather than at the request that
   * actually failed — and against a live manager, "which request" is most of
   * the diagnosis.
   *
   * Also refuses a plan with nothing to do. Every caller here is asking for a
   * change — to push it, or to prove it was refused — and a request that
   * happens to match what the seed already races produces a plan that writes
   * nothing and assertions that pass for the absence of the write. Checked
   * once, here, because remembering it per test is exactly what failed.
   */
  const planFor = async (
    id: string,
    cookie: string,
    payload: Record<string, unknown>,
  ): Promise<PlanView> => {
    const res = await server().inject({
      method: "POST",
      url: `/api/championships/${id}/rounds/1/plan`,
      headers: { cookie },
      payload,
    })
    expect(res.statusCode, res.body).toBe(200)
    const plan = (res.json() as PlanResponse).plan
    assertWouldChange(plan, `a plan for ${JSON.stringify(payload)}`)
    return plan
  }

  /**
   * Pushes a plan and hands back the response, asserting nothing.
   *
   * Deliberately unasserted: half the tests here are about a push being
   * *refused*, and a helper that insisted on 200 would be unusable for exactly
   * the cases worth having. Use `pushed` when the push is meant to land.
   */
  const push = (planId: string, cookie: string) =>
    server().inject({
      method: "POST",
      url: `/api/plans/${planId}/apply`,
      headers: { cookie },
      payload: { acknowledgeWarnings: true },
    })

  /**
   * A push that is meant to land, and a failure that says so at the push.
   *
   * `eventSaved` is checked here rather than in each caller because a 200 does
   * not mean a write. Apply returns early and reports `eventSaved: false` when
   * the plan had nothing to do, which is precisely the case that makes the
   * assertions after a push pass for the wrong reason — see `assertWouldChange`
   * in the harness.
   */
  const pushed = async (planId: string, cookie: string): Promise<ApplyResponse> => {
    const res = await push(planId, cookie)
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json() as ApplyResponse
    expect(body.eventSaved, `the push reported no write: ${res.body}`).toBe(true)
    return body
  }

  // -------------------------------------------------------------------------

  describe("holding a session", () => {
    it("logs in with credentials the manager actually accepts", async () => {
      const cookie = await loggedIn()
      const res = await server().inject({
        method: "GET",
        url: "/api/session",
        headers: { cookie },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ authenticated: true })
    })

    it("refuses credentials the manager rejects, without inventing a session", async () => {
      // ACSM answers a wrong password by re-rendering the login page with a
      // 200, not a 401. A live check is the only way to know champctl still
      // reads that as failure — the day it stops, every wrong password becomes
      // a working login.
      //
      // The *configured* username with a wrong password, not a hard-coded
      // "admin". Against a harness using any other account, "admin" is a user
      // that does not exist, and ACSM refusing an unknown username is a
      // different path from ACSM refusing a known one — the second is the one
      // worth pinning, and it is the one that would quietly stop being tested.
      const config = liveConfig()
      if (!config) throw new Error("no live config")
      const res = await server().inject({
        method: "POST",
        url: "/api/login",
        payload: { username: config.username, password: "not-the-password" },
      })
      expect(res.statusCode).toBe(401)
      expect(res.headers["set-cookie"]).toBeUndefined()
    })

    it("reads the manager with the session it was given, not with the server's", async () => {
      // The endpoint is only reachable with a cookie, and what it returns had
      // to come back over that session's own ACSM login.
      const id = await seeded()
      const cookie = await loggedIn()

      const anonymous = await server().inject({ method: "GET", url: "/api/championships" })
      expect(anonymous.statusCode).toBe(401)

      const res = await server().inject({
        method: "GET",
        url: "/api/championships",
        headers: { cookie },
      })
      expect(res.statusCode).toBe(200)
      const ids = (res.json().championships as { id: string }[]).map((c) => c.id)
      expect(ids).toContain(id)
    })

    it("stops working the moment the browser logs out", async () => {
      const cookie = await loggedIn()
      const out = await server().inject({ method: "POST", url: "/api/logout", headers: { cookie } })
      expect(out.statusCode).toBe(204)

      const after = await server().inject({
        method: "GET",
        url: "/api/championships",
        headers: { cookie },
      })
      expect(after.statusCode).toBe(401)
    })
  })

  describe("the weekly flow, over HTTP", () => {
    it("previews a change without writing it", async () => {
      const id = await seeded()
      const cookie = await loggedIn()
      const before = await exported(id)

      const res = await server().inject({
        method: "POST",
        url: `/api/championships/${id}/rounds/1/plan`,
        headers: { cookie },
        // Derived, not a literal: asking for what the seed already races makes
        // this a plan with no changes, and "the preview listed Race length"
        // then fails for the fixture rather than for the endpoint.
        payload: { laps: await lapsUnlikeSeed() },
      })
      expect(res.statusCode, res.body).toBe(200)

      const body = res.json() as PlanResponse
      assertWouldChange(body.plan, "the preview under test")
      expect(body.plan.planId).toBeTruthy()
      expect(body.plan.changes.map((c) => c.label)).toContain("Race length")
      expect(body.plan.formChanges.length).toBeGreaterThan(0)

      // The read is the proof. A preview that quietly wrote would leave the
      // championship changed, and every later assertion would still pass.
      const after = await exported(id)
      expect(readFormat(events(after)[0]!)).toEqual(readFormat(events(before)[0]!))
    })

    it("lands the plan it previewed, and the manager agrees", async () => {
      const id = await seeded()
      const cookie = await loggedIn()

      const plan = await planFor(id, cookie, {
        laps: 17,
        reversedGridPositions: 4,
        mandatoryPit: false,
      })
      await pushed(plan.planId, cookie)

      // Read back out of ACSM rather than trusting the response. What champctl
      // reports and what the manager stored are two different claims, and only
      // the second one is a finalized round.
      const format = readFormat(events(await exported(id))[0]!)
      expect(format.length).toEqual({ kind: "laps", laps: 17 })
      expect(format.reversedGridPositions).toBe(4)
      expect(format.mandatoryPit).toBe(false)
    })

    it("keeps every entrant a push was not supposed to touch", async () => {
      // ACSM's event form replaces the whole entry list on every save, so a
      // finalize that drops an entrant is a silent way to unregister someone.
      // The unit tests assert this against a fixture; this asserts it against
      // a form the manager rendered.
      const id = await seeded()
      const cookie = await loggedIn()

      /**
       * Who is entered, by GUID, ignoring which `CAR_n` slot they sit in.
       *
       * Compared as a set because ACSM reassigns those slots on a save and the
       * order carries no meaning — the same reason `entryListFingerprint`
       * hashes a sorted set rather than a sequence. Comparing slot by slot
       * fails the moment the manager shuffles two entrants who are both still
       * entered, which is a passing grade dressed as a bug.
       */
      const entrants = (c: Championship) =>
        Object.values(events(c)[0]?.EntryList ?? {})
          .map((e) => `${e.GUID}:${e.Model}`)
          .sort()

      const before = entrants(await exported(id))
      expect(before.length).toBeGreaterThan(1)

      // Derived from the fixture rather than written as a literal. This asked
      // for 12 once, which is what the seed already races — so the plan was a
      // no-op, the push was skipped, and the test spent its life proving that a
      // write which never happened left the entry list alone.
      const plan = await planFor(id, cookie, { laps: await lapsUnlikeSeed() })
      await pushed(plan.planId, cookie)

      expect(entrants(await exported(id))).toEqual(before)
    })

    it("spends a plan once, so a double-click cannot write twice", async () => {
      const id = await seeded()
      const cookie = await loggedIn()

      const plan = await planFor(id, cookie, { laps: 19 })

      await pushed(plan.planId, cookie)

      const second = await push(plan.planId, cookie)
      expect(second.statusCode).toBe(404)
      expect(second.json().error.code).toBe("no-such-plan")
    })

    it("will not let one browser spend another's plan", async () => {
      // Two sessions against the same manager with the same credentials. The
      // plan still belongs to the one that made it, because applying it posts
      // a form fetched with that session's cookies.
      const id = await seeded()
      const mine = await loggedIn()
      const theirs = await loggedIn()
      expect(mine).not.toBe(theirs)

      const plan = await planFor(id, mine, { laps: 21 })

      const stolen = await push(plan.planId, theirs)
      expect(stolen.statusCode).toBe(404)

      const format = readFormat(events(await exported(id))[0]!)
      expect(format.length).not.toEqual({ kind: "laps", laps: 21 })
    })

    it("refuses a push when the entry list moved under the preview", async () => {
      const id = await seeded()
      const cookie = await loggedIn()

      const plan = await planFor(id, cookie, { laps: 14 })

      // Somebody else approves a sign-up while the preview is open: fetch the
      // same form, change an entrant, post it back. Through the admin session,
      // which is what makes it somebody else.
      //
      // Ballast rather than Name, for the reason `flows.live.test.ts` records:
      // the championship event form renders Name, Team and GUID readonly and
      // ACSM ignores them on save, so meddling with a name changes nothing and
      // the guard correctly doesn't fire — a test that fails for the meddling
      // not working rather than for the guard being wrong.
      const path = eventEditPath(id, plan.eventId)
      const form = parseForm(await live().getText(path), { pageUrl: live().url(path) })
      const meddled = [...form.fields]
      setAt(meddled, "EntryList.Ballast", 0, "42")
      const meddledGuid = getAll(meddled, "EntryList.GUID")[0] as string
      await live().postForm(eventSubmitPath(id), meddled)

      const ballastOf = (c: Championship, guid: string) =>
        Object.values(events(c)[0]?.EntryList ?? {}).find((e) => e.GUID === guid)?.Ballast
      expect(ballastOf(await exported(id), meddledGuid), "the meddling must have landed").toBe(42)

      const applied = await push(plan.planId, cookie)
      expect(applied.statusCode, applied.body).toBe(409)
      expect(applied.json().error.code).toBe("entry-list-changed")

      // Nothing was written: the meddled value is untouched and the laps the
      // plan wanted never landed.
      const after = await exported(id)
      expect(ballastOf(after, meddledGuid)).toBe(42)
      expect(readFormat(events(after)[0]!).length).not.toEqual({ kind: "laps", laps: 14 })
    })

    it("lets the browser recover by planning again", async () => {
      // The refusal above is only half the remedy. The UI's answer to it is
      // "reload the round", so a fresh plan against the changed list has to
      // work — otherwise the screen is stuck telling someone to do something
      // that fails.
      const id = await seeded()
      const cookie = await loggedIn()

      const stale = await planFor(id, cookie, { laps: 15 })

      const path = eventEditPath(id, stale.eventId)
      const form = parseForm(await live().getText(path), { pageUrl: live().url(path) })
      const meddled = [...form.fields]
      setAt(meddled, "EntryList.Ballast", 0, "33")
      await live().postForm(eventSubmitPath(id), meddled)

      const refused = await push(stale.planId, cookie)
      expect(refused.statusCode).toBe(409)

      const fresh = await planFor(id, cookie, { laps: 15 })
      await pushed(fresh.planId, cookie)
      expect(readFormat(events(await exported(id))[0]!).length).toEqual({ kind: "laps", laps: 15 })
    })
  })

  // -------------------------------------------------------------------------
  // Creating a month (plan §5.1)
  // -------------------------------------------------------------------------

  describe("creating a month, over HTTP", () => {
    it("previews a month from last month without writing anything", async () => {
      const source = await seeded()
      const cookie = await loggedIn()
      const before = (await server()
        .inject({
          method: "GET",
          url: "/api/championships",
          headers: { cookie },
        })
        .then((r) => r.json())) as { championships: { id: string }[] }

      const plan = await monthPlan(cookie, {
        sourceId: source,
        name: "champctl live preview",
        tracks: [{ track: "spa" }, { track: "monza" }],
      })
      expect(plan.rounds.map((r) => r.track)).toEqual(["spa", "monza"])
      expect(plan.grid.summary).toBeTruthy()

      // A preview that quietly created something would leave a championship
      // behind, and every later assertion would still pass.
      const after = (await server()
        .inject({
          method: "GET",
          url: "/api/championships",
          headers: { cookie },
        })
        .then((r) => r.json())) as { championships: { id: string }[] }
      expect(after.championships.length).toBe(before.championships.length)
    })

    it("creates the month it previewed, and the manager has it", async () => {
      const source = await seeded()
      const cookie = await loggedIn()

      const plan = await monthPlan(cookie, {
        sourceId: source,
        name: "champctl live september",
        tracks: [{ track: "spa" }, { track: "monza" }, { track: "suzuka" }],
      })
      const made = await imported(plan.planId, cookie)
      expect(made.name).toBe("champctl live september")
      expect(made.rounds).toBe(3)

      // Read it back out of ACSM rather than trusting the response. What
      // champctl reports and what the manager stored are two claims, and only
      // the second is a month anyone can race.
      const champ = await exported(made.championshipId)
      expect(champ.Name).toBe("champctl live september")
      const tracks = events(champ).map((e) => e.RaceSetup?.Track)
      expect(tracks).toEqual(["spa", "monza", "suzuka"])
    })

    it("gives the new month fresh event ids rather than last month's", async () => {
      // The import regenerates ids. Reusing them would make the new month's
      // events collide with the source's, which is a mess ACSM will happily
      // store.
      const source = await seeded()
      const cookie = await loggedIn()
      const sourceEventIds = events(await exported(source)).map((e) => e.ID)

      const plan = await monthPlan(cookie, {
        sourceId: source,
        name: "champctl live fresh ids",
        tracks: [{ track: "spa" }],
      })
      const made = await imported(plan.planId, cookie)

      const champ = await exported(made.championshipId)
      expect(made.championshipId).not.toBe(source)
      for (const id of events(champ).map((e) => e.ID)) {
        expect(sourceEventIds).not.toContain(id)
      }
    })

    it("carries the entry list slots and cars across from last month", async () => {
      // The point of cloning: the class, the cars and the slots come from the
      // source, and only what was named changes.
      const source = await seeded()
      const cookie = await loggedIn()
      const before = await exported(source)

      const plan = await monthPlan(cookie, {
        sourceId: source,
        name: "champctl live inherited",
        tracks: [{ track: "spa" }],
      })
      const made = await imported(plan.planId, cookie)
      const champ = await exported(made.championshipId)

      expect(champ.Classes?.[0]?.AvailableCars).toEqual(before.Classes?.[0]?.AvailableCars)
      expect(events(champ)[0]?.RaceSetup?.Cars).toBeTruthy()
    })

    it("spends the month once, so a double-tap cannot create two", async () => {
      const source = await seeded()
      const cookie = await loggedIn()
      const plan = await monthPlan(cookie, {
        sourceId: source,
        name: "champctl live once",
        tracks: [{ track: "spa" }],
      })

      await imported(plan.planId, cookie)
      const second = await importMonth(plan.planId, cookie)
      expect(second.statusCode).toBe(404)
      expect(second.json().error.code).toBe("no-such-plan")
    })

    it("will not let one browser create another's month", async () => {
      const source = await seeded()
      const mine = await loggedIn()
      const theirs = await loggedIn()
      const plan = await monthPlan(mine, {
        sourceId: source,
        name: "champctl live ownership",
        tracks: [{ track: "spa" }],
      })

      const stolen = await importMonth(plan.planId, theirs)
      expect(stolen.statusCode).toBe(404)
    })
  })
})
