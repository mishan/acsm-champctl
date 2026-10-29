/**
 * The sign-up queue against a fake ACSM that accepts and rejects the way
 * 2.4.15 was measured to (docs/acsm-signups.md): a GET per action, a redirect
 * whatever happened, and a seat taken or cleared by Steam ID.
 */

import { describe, expect, it } from "vitest"

import { StaticAcsmReader } from "../src/acsm/client.js"
import { AcsmSession } from "../src/acsm/session.js"
import type { Championship, Entrant, SignUpResponse } from "../src/acsm/types.js"
import type { SignUpsResponse } from "../src/web/wire.js"
import { buildServer } from "../src/web/server.js"
import { NOW, pitTable, testProfile } from "./support/build.js"

const BASE_URL = "https://acsm.example"
const ID = "11111111-2222-3333-4444-555555555555"

interface Fake {
  /** Every accept or reject link ACSM was sent, with the Referer it came with. */
  actions: { url: string; referer: string | null }[]
  /** ACSM sends the action back to its front page, as it does for a lapsed session. */
  lapsed?: boolean
  /** ACSM answers with a redirect and changes nothing. */
  ignores?: boolean
}

function fakeAcsm(entrants: Record<string, Entrant>, responses: SignUpResponse[], fake: Fake) {
  const c: Championship = {
    ID: ID,
    Name: "November 2026",
    Classes: [{ Name: "Civic", Entrants: entrants }],
    SignUpForm: { Enabled: true, Responses: responses },
  }
  const seats = () => Object.values(entrants)
  const fetchImpl: typeof globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.pathname === "/login") {
      return new Response("", {
        status: 302,
        headers: { "set-cookie": "_acsm_data=x; Path=/", location: "/" },
      })
    }
    if (url.pathname === `/championship/${ID}/export`) return Response.json(c)
    const m = /^\/championship\/[^/]+\/entrant\/([^/]+)$/.exec(url.pathname)
    if (m) {
      fake.actions.push({
        url: url.pathname + url.search,
        referer: new Headers(init.headers).get("referer"),
      })
      if (fake.lapsed) return new Response("", { status: 302, headers: { location: "/" } })
      const guid = decodeURIComponent(m[1] ?? "")
      const r = responses.find((x) => x.GUID === guid)
      if (r && !fake.ignores) {
        const own = seats().find((e) => e.GUID === guid)
        if (own) Object.assign(own, { GUID: "", Name: "" })
        if (url.searchParams.get("action") === "reject") r.Status = "Rejected"
        else {
          const free = seats().find(
            (e) => !e.GUID && !e.Name && (e.Model === r.Car || e.Model === "any_car_model"),
          )
          if (free) {
            Object.assign(free, { GUID: guid, Name: r.Name, Model: r.Car })
            r.Status = "Accepted"
          }
        }
      }
      return new Response("", { status: 302, headers: { location: "/back" } })
    }
    return new Response("not here", { status: 404 })
  }

  const app = buildServer({
    profile: testProfile(),
    baseUrl: BASE_URL,
    reader: new StaticAcsmReader([c]),
    pits: pitTable([]),
    createSession: (baseUrl) => new AcsmSession({ baseUrl, fetch: fetchImpl, rateLimit: false }),
    secureCookies: false,
    now: () => NOW,
  })

  let cookie = ""
  const login = async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "admin", password: "x" },
    })
    const header = res.headers["set-cookie"]
    cookie = String((Array.isArray(header) ? header[0] : header) ?? "").split(";")[0] ?? ""
  }
  const act = (guid: string, body: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: `/api/championships/${ID}/signups/${guid}`,
      headers: { cookie },
      payload: body,
    })
  const list = () =>
    app.inject({ method: "GET", url: `/api/championships/${ID}/signups`, headers: { cookie } })
  return { login, act, list, entrants, responses }
}

const seat = (over: Partial<Entrant> = {}): Entrant => ({
  Name: "",
  GUID: "",
  Model: "any_car_model",
  ...over,
})
const pending = (guid: string, name: string, car: string, created: string): SignUpResponse => ({
  GUID: guid,
  Name: name,
  Car: car,
  Skin: "red",
  Created: created,
  Status: "Pending Approval",
  Questions: { "Discord name?": name.toLowerCase() },
})

describe("the sign-up queue", () => {
  it("lists pending sign-ups first, newest first, and says which can't be accepted", async () => {
    const fake = fakeAcsm(
      { CAR_0: seat({ Name: "Seated", GUID: "s", Model: "civic" }) },
      [
        { ...pending("s", "Seated", "civic", "2026-10-01T00:00:00Z"), Status: "Accepted" },
        pending("a", "Alice", "civic", "2026-10-02T00:00:00Z"),
        pending("b", "Bob", "civic", "2026-10-03T00:00:00Z"),
      ],
      { actions: [] },
    )
    await fake.login()
    const body = (await fake.list()).json() as SignUpsResponse
    expect(body.signUps.map((u) => [u.name, u.status, u.seated])).toEqual([
      ["Bob", "Pending Approval", false],
      ["Alice", "Pending Approval", false],
      ["Seated", "Accepted", true],
    ])
    expect(body.signUps[0]?.cantAccept).toMatch(/no free seat for civic/)
    expect(body.signUps[0]?.questions).toEqual([{ question: "Discord name?", answer: "bob" }])
  })

  it("accepts through ACSM's link, and says so once the championship shows it", async () => {
    const fake = fakeAcsm(
      { CAR_0: seat() },
      [pending("a", "Alice", "civic", "2026-10-02T00:00:00Z")],
      { actions: [] },
    )
    await fake.login()
    const res = await fake.act("a", { action: "accept" })
    expect(res.statusCode, res.body).toBe(200)
    expect((res.json() as SignUpsResponse).signUps[0]).toMatchObject({
      status: "Accepted",
      seated: true,
    })
    expect(fake.entrants["CAR_0"]).toMatchObject({ GUID: "a", Model: "civic" })
  })

  it("won't accept when ACSM would find no seat, and sends it nothing", async () => {
    const actions: Fake["actions"] = []
    // A seated driver asking for another car: ACSM would clear their seat first.
    const fake = fakeAcsm(
      { CAR_0: seat({ Name: "Seated", GUID: "s", Model: "civic" }) },
      [pending("s", "Seated", "integra", "2026-10-02T00:00:00Z")],
      { actions },
    )
    await fake.login()
    const res = await fake.act("s", { action: "accept" })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.message).toMatch(/take away the seat they already have/)
    expect(actions).toEqual([])
    expect(fake.entrants["CAR_0"]).toMatchObject({ GUID: "s" })
  })

  it("rejects a seated driver only when told that's meant", async () => {
    const actions: Fake["actions"] = []
    const fake = fakeAcsm(
      { CAR_0: seat({ Name: "Seated", GUID: "s", Model: "civic" }) },
      [pending("s", "Seated", "civic", "2026-10-02T00:00:00Z")],
      { actions },
    )
    await fake.login()
    const asked = await fake.act("s", { action: "reject" })
    expect(asked.statusCode).toBe(409)
    expect(asked.json().error.code).toBe("would-unseat")
    expect(actions).toEqual([])

    const meant = await fake.act("s", { action: "reject", confirm: true })
    expect(meant.statusCode, meant.body).toBe(200)
    expect(actions).toEqual([
      {
        url: `/championship/${ID}/entrant/s?action=reject`,
        referer: `${BASE_URL}/championship/${ID}/entrants`,
      },
    ])
  })

  it.each([
    ["ignores the request", { ignores: true }, 502, /still pending approval/],
    ["sends it to its front page", { lapsed: true }, 401, /./],
  ])("says so when ACSM %s", async (_, behavior, status, message) => {
    const fake = fakeAcsm(
      { CAR_0: seat() },
      [pending("a", "Alice", "civic", "2026-10-02T00:00:00Z")],
      { actions: [], ...behavior },
    )
    await fake.login()
    const res = await fake.act("a", { action: "accept" })
    expect(res.statusCode).toBe(status)
    expect(res.json().error.message).toMatch(message)
  })
})
