import { describe, expect, it } from "vitest"

import { CHAMPIONSHIP_SUBMIT_PATH } from "../src/acsm/paths.js"
import { AcsmSession } from "../src/acsm/session.js"
import type { Entrant } from "../src/acsm/types.js"
import {
  LiveryRecordError,
  MultiClassError,
  RosterChangedError,
  applyLiveries,
  uploadTimeoutMs,
} from "../src/liveries/apply.js"
import { AcsmWriteError } from "../src/acsm/session.js"
import type { Livery, LiveryPack } from "../src/liveries/pack.js"
import { planLiveries } from "../src/liveries/plan.js"
import { championship, championshipClass, entryList, raceEvent } from "./support/build.js"

const CAR = "rss_formula_hybrid_2021"
const CHAMP_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
const EVENT_ID = "event-1"

const livery = (driverName: string, carModel = CAR): Livery => ({
  carModel,
  driverName,
  skinFolder: driverName,
  files: [
    { name: "livery.dds", bytes: new TextEncoder().encode("dds") },
    { name: "ui_skin.json", bytes: new TextEncoder().encode("{}") },
  ],
  totalBytes: 5,
})

const packOf = (...l: Livery[]): LiveryPack => ({ liveries: l, totalBytes: 0 })

const person = (over: Partial<Entrant>): Partial<Entrant> => ({ Model: CAR, Skin: "", ...over })

const champ = (names: string[] = ["Misha", "postaL"]) =>
  championship({
    ID: CHAMP_ID,
    Classes: [championshipClass({ Entrants: entryList(names.map((Name) => person({ Name }))) })],
    Events: [raceEvent({ ID: EVENT_ID, EntryList: {} })],
  })

/**
 * The championship edit page, shaped like 2.4.15's.
 *
 * `classTemplate` renders the `#class-template` block ACSM puts before the real
 * classes — its own ClassName, its own NumEntrants of 0 and its own
 * #entrantTemplate inside. `manager.js` removes it in a browser and champctl
 * has to remove it by hand, and leaving it in is what makes every driver
 * inherit the previous one's car. It belongs in a test of the *write*, not only
 * of the parser, because the write is where the damage would land.
 *
 * `secondClass` renders a second real class, which is the shape champctl
 * refuses outright.
 */
function editPage(
  names: string[],
  options: { classTemplate?: boolean; secondClass?: string[] } = {},
): string {
  const row = (name: string, spectator = false) => `
    <div class="entrant">
      <input type="hidden" name="EntryList.InternalUUID" value="00000000-0000-0000-0000-000000000000">
      <select name="EntryList.Car"><option value="${CAR}" selected>c</option></select>
      <select name="EntryList.Skin"></select>
      <input type="text" name="EntryList.Name" value="${name}">
      <input type="text" name="EntryList.Team" value="">
      <input type="text" name="EntryList.GUID" value="">
      <input type="number" name="EntryList.Ballast" value="0">
      <input type="number" name="EntryList.Restrictor" value="0">
      <select name="EntryList.FixedSetup"><option value="" selected></option></select>
      ${spectator ? '<input type="checkbox" name="EntryList.Spectator">' : ""}
    </div>`

  const classTemplate = options.classTemplate
    ? `<div id="class-template" style="display: none;">
        <input type="text" name="ClassName" value="">
        <div id="entrantTemplate">${row("")}</div>
        <input type="hidden" name="EntryList.NumEntrants" value="0">
      </div>`
    : ""

  const second = options.secondClass
    ? `<input type="text" name="ClassName" value="GT3">
       <div id="entrantTemplate">${row("")}</div>
       ${options.secondClass.map((n) => row(n)).join("")}
       <input type="hidden" name="EntryList.NumEntrants" value="${options.secondClass.length}">`
    : ""

  return `<html><body><form action="${CHAMPIONSHIP_SUBMIT_PATH}" method="post">
    <input type="text" name="ChampionshipName" value="September 2026">
    <div id="entrantTemplate">${row("", true)}</div>
    ${row("Stream Van", true)}
    ${classTemplate}
    <input type="text" name="ClassName" value="RSS">
    <div id="entrantTemplate">${row("")}</div>
    ${names.map((n) => row(n)).join("")}
    <input type="hidden" name="EntryList.NumEntrants" value="${names.length}">
    ${second}
  </form></body></html>`
}

interface Recorded {
  url: string
  method: string
  body?: string
  parts?: { name: string; size: number }[]
  referer?: string
}

/**
 * Resolves after `ms`, unless the request is aborted first.
 *
 * Node's fetch is replaced here, so nothing else honours the AbortSignal the
 * session attaches — and a test about timeouts against a fetch that ignores
 * them proves nothing.
 */
function delayed(ms: number, signal: AbortSignal | null | undefined, res: () => Response) {
  return new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => resolve(res()), ms)
    signal?.addEventListener("abort", () => {
      clearTimeout(timer)
      const e = new Error("This operation was aborted")
      e.name = "AbortError"
      reject(e)
    })
  })
}

async function fakeSession(
  options: {
    formNames?: string[]
    uploadStatus?: number
    submitStatus?: number
    /** Where the save's 302 points. The default is a correct edit. */
    submitLocation?: string
    /** Render the #class-template block the browser removes. */
    classTemplate?: boolean
    /** Render a second real class, which champctl refuses to write. */
    secondClass?: string[]
    practiceStatus?: number
    /** The session-wide default, to show the upload does not use it. */
    sessionTimeoutMs?: number
    /** How long the skin upload takes to answer. */
    skinDelayMs?: number
  } = {},
) {
  const requests: Recorded[] = []
  const names = options.formNames ?? ["Misha", "postaL"]

  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    const headers = new Headers(init?.headers)
    const record: Recorded = { url, method }
    const referer = headers.get("referer")
    if (referer) record.referer = referer

    if (method === "POST" && init?.body instanceof FormData) {
      record.parts = [...init.body.entries()].map(([, v]) => ({
        name: v instanceof File ? v.name : "",
        size: v instanceof File ? v.size : 0,
      }))
    } else if (method === "POST" && init?.body) {
      record.body = String(init.body)
    }
    requests.push(record)

    if (url.includes("/login")) {
      return new Response("", {
        status: 302,
        headers: { location: "/", "set-cookie": "_acsm_data=x; Path=/" },
      })
    }
    if (url.includes("/skin")) {
      const respond = () =>
        new Response("", { status: options.uploadStatus ?? 302, headers: { location: "/car/x" } })
      return options.skinDelayMs ? delayed(options.skinDelayMs, init?.signal, respond) : respond()
    }
    if (url.includes(CHAMPIONSHIP_SUBMIT_PATH)) {
      return new Response("", {
        status: options.submitStatus ?? 302,
        headers: { location: options.submitLocation ?? `/championship/${CHAMP_ID}` },
      })
    }
    if (url.includes("/practice")) {
      return new Response("", {
        status: options.practiceStatus ?? 302,
        headers: { location: `/championship/${CHAMP_ID}` },
      })
    }
    if (url.includes("/edit")) {
      return new Response(
        editPage(names, {
          ...(options.classTemplate ? { classTemplate: true } : {}),
          ...(options.secondClass ? { secondClass: options.secondClass } : {}),
        }),
        { status: 200 },
      )
    }
    return new Response("", { status: 404 })
  }

  const session = new AcsmSession({
    baseUrl: "https://acsm.example",
    fetch: fetchImpl,
    rateLimit: false,
    ...(options.sessionTimeoutMs !== undefined ? { timeoutMs: options.sessionTimeoutMs } : {}),
  })
  await session.login({ username: "admin", password: "x" })
  return { session, requests }
}

const plan = (names?: string[], ...l: Livery[]) =>
  planLiveries(champ(names), CHAMP_ID, packOf(...(l.length ? l : [livery("Misha")])))

describe("applyLiveries", () => {
  it("uploads each skin, then saves the championship, then restarts practice", async () => {
    // The order is the safety property: an uploaded skin nobody references is
    // disk space, an entry list pointing at a folder that isn't there is a
    // driver who can't join.
    const { session, requests } = await fakeSession()
    const result = await applyLiveries(session, plan(), {
      restartPracticeRound: 1,
      eventIds: [EVENT_ID],
    })

    const paths = requests.filter((r) => !r.url.includes("/login")).map((r) => r.url)
    expect(paths).toEqual([
      `https://acsm.example/car/${CAR}/skin`,
      `https://acsm.example/championship/${CHAMP_ID}/edit`,
      `https://acsm.example${CHAMPIONSHIP_SUBMIT_PATH}`,
      `https://acsm.example/championship/${CHAMP_ID}/event/${EVENT_ID}/practice`,
    ])
    expect(result).toMatchObject({ championshipSaved: true, practiceRestarted: true })
    expect(result.uploaded).toEqual([
      { driverName: "Misha", carModel: CAR, skinFolder: "Misha", files: 2 },
    ])
  })

  it("names each part with the skin folder as a path prefix", async () => {
    // The only way ACSM is told what to call the skin folder: it writes to
    // skins/<filepath.Dir(filename)>/<filepath.Base(filename)>.
    const { session, requests } = await fakeSession()
    await applyLiveries(session, plan())
    const upload = requests.find((r) => r.url.includes("/skin"))
    expect(upload?.parts?.map((p) => p.name)).toEqual(["Misha/livery.dds", "Misha/ui_skin.json"])
  })

  it("sends a Referer so ACSM's redirect-to-referer has somewhere to go", async () => {
    const { session, requests } = await fakeSession()
    await applyLiveries(session, plan())
    expect(requests.find((r) => r.url.includes("/skin"))?.referer).toBe(
      `https://acsm.example/car/${CAR}`,
    )
  })

  it("posts one championship save for several drivers", async () => {
    // Not one save per driver: that POST replaces the whole championship, so
    // each extra one is another chance to lose a sign-up.
    const { session, requests } = await fakeSession()
    await applyLiveries(session, plan(undefined, livery("Misha"), livery("postaL")))
    expect(requests.filter((r) => r.url.includes(CHAMPIONSHIP_SUBMIT_PATH))).toHaveLength(1)
    expect(requests.filter((r) => r.url.includes("/skin"))).toHaveLength(2)
  })

  it("writes the skin into the right row, past the spectator car", async () => {
    // Row 0 is the spectator car on premium. Off by one and the stream van gets
    // the livery.
    const { session, requests } = await fakeSession()
    await applyLiveries(session, plan(undefined, livery("postaL")))
    const body = new URLSearchParams(
      requests.find((r) => r.url.includes(CHAMPIONSHIP_SUBMIT_PATH))?.body ?? "",
    )
    expect(body.getAll("EntryList.Name")).toEqual(["Stream Van", "Misha", "postaL"])
    expect(body.getAll("EntryList.Skin")).toEqual(["", "", "postaL"])
  })

  it("drops the template rows from what it posts", async () => {
    // The form renders five Name fields for two entrants plus a spectator.
    // Posting all five shifts everyone and pushes the last past start+length.
    const { session, requests } = await fakeSession()
    await applyLiveries(session, plan())
    const body = new URLSearchParams(
      requests.find((r) => r.url.includes(CHAMPIONSHIP_SUBMIT_PATH))?.body ?? "",
    )
    expect(body.getAll("EntryList.Name")).toHaveLength(3)
    expect(body.getAll("EntryList.NumEntrants")).toEqual(["2"])
  })

  it("never posts to an event form", async () => {
    // The whole design: the class list is the source and per-event lists are
    // overrides that champctl leaves alone.
    const { session, requests } = await fakeSession()
    await applyLiveries(session, plan(), { restartPracticeRound: 1, eventIds: [EVENT_ID] })
    expect(requests.filter((r) => r.url.includes("/event/submit"))).toEqual([])
  })

  it("uploads but does not write the championship when the skin is already assigned", async () => {
    // The re-submission: Misha's entrant already says Skin = "Misha", and he
    // has sent a corrected livery. The files have to go up — nothing here can
    // ask ACSM what is in that folder — and the championship does not, because
    // no field on the form would change.
    //
    // This used to do neither, and report success.
    const c = championship({
      ID: CHAMP_ID,
      Classes: [
        championshipClass({ Entrants: entryList([person({ Name: "Misha", Skin: "Misha" })]) }),
      ],
      Events: [raceEvent({ ID: EVENT_ID, EntryList: {} })],
    })
    const { session, requests } = await fakeSession()
    const result = await applyLiveries(session, planLiveries(c, CHAMP_ID, packOf(livery("Misha"))))

    expect(result).toMatchObject({ championshipSaved: false, practiceRestarted: false })
    expect(result.uploaded).toMatchObject([{ driverName: "Misha", skinFolder: "Misha" }])
    expect(requests.filter((r) => r.url.includes("/skin"))).toHaveLength(1)
    expect(requests.filter((r) => r.url.includes("/championships/new/submit"))).toEqual([])
  })

  it("posts the right rows when the page carries the class template too", async () => {
    // The end-to-end version of the parser's #class-template test, and the one
    // that was missing: every applyLiveries test rendered a page without the
    // block, so the write path this commit exists for was only ever exercised
    // by unit tests. Left in, ACSM reads NumEntrants as `0, 2`, builds an empty
    // first class, and starts the real one a row early — every driver inherits
    // the previous one's car and the last is dropped.
    const { session, requests } = await fakeSession({ classTemplate: true })
    const result = await applyLiveries(session, plan())

    expect(result.championshipSaved).toBe(true)
    const submit = requests.find((r) => r.url.includes(CHAMPIONSHIP_SUBMIT_PATH))
    const body = new URLSearchParams(submit?.body ?? "")
    // Three rows: the spectator van and the two drivers. Not five, and not one
    // NumEntrants of 0 followed by one of 2.
    expect(body.getAll("EntryList.Name")).toEqual(["Stream Van", "Misha", "postaL"])
    expect(body.getAll("EntryList.NumEntrants")).toEqual(["2"])
    expect(body.getAll("ClassName")).toEqual(["RSS"])
    expect(body.getAll("EntryList.Skin")).toEqual(["", "Misha", ""])
  })

  it("refuses to write a championship whose form renders two classes", async () => {
    // The guarantee, rather than the courtesy: plan.ts refuses this from the
    // export, and this refuses it from the form — which is the thing actually
    // being posted, and the only one that can be trusted to describe it. The
    // export said one class here and the form says two.
    //
    // docs/acsm-champ-form.md 4.4: no EntryList.EntrantID on this form means
    // ACSM rebuilds pit boxes by position, restarting at 0 for each class, and
    // AddInPitBox overwrites on collision — so a driver disappears.
    const { session, requests } = await fakeSession({ secondClass: ["Ann"] })

    await expect(applyLiveries(session, plan())).rejects.toThrowError(MultiClassError)
    expect(requests.filter((r) => r.url.includes(CHAMPIONSHIP_SUBMIT_PATH))).toEqual([])
    // The refusal promises the uploads are harmless, which is only true if they
    // happened: this refuses at the write, after the skins are on the server.
    expect(requests.filter((r) => r.url.includes("/skin"))).toHaveLength(1)
  })

  it("refuses a save that redirected to the login page", async () => {
    // A session that lapsed between reading the form and posting it. ACSM
    // answers with a 302 to /login, which is a perfectly good redirect and
    // means nothing was written — reported, until this check, as saved.
    const { session } = await fakeSession({ submitLocation: "/login" })

    await expect(applyLiveries(session, plan())).rejects.toThrowError(AcsmWriteError)
    await expect(applyLiveries(session, plan())).rejects.toThrowError(
      /redirected to "\/login", not to/,
    )
  })

  it("refuses a save ACSM answered as a brand-new championship", async () => {
    // /championships/new/submit serves create and edit, and an edit is a create
    // carrying an existing ID. If that ID doesn't survive the round trip, ACSM
    // makes a *new* championship holding the entry list: the real one is
    // untouched and there is now a duplicate. Also a 302, also reported as
    // saved until the Location is read.
    const other = "99999999-9999-9999-9999-999999999999"
    const { session } = await fakeSession({ submitLocation: `/championship/${other}` })

    await expect(applyLiveries(session, plan())).rejects.toThrowError(AcsmWriteError)
    await expect(applyLiveries(session, plan())).rejects.toThrowError(
      new RegExp(`redirected to championship ${other}, not to ${CHAMP_ID}`),
    )
  })

  it("accepts the save when the id was typed in a different case", () => {
    // ACSM parses the id case-insensitively, so a championship pasted in upper
    // case reads and saves perfectly — and Go's uuid.String() writes Location
    // in lower case regardless. Comparing the two exactly would call that
    // successful save a duplicate-creating failure, which is a worse answer
    // than the one the check replaced.
    const shouted = CHAMP_ID.toUpperCase()
    const upper = () => planLiveries(champ(), shouted, packOf(livery("Misha")))

    return fakeSession().then(async ({ session }) => {
      const result = await applyLiveries(session, upper())
      expect(result.championshipSaved).toBe(true)
    })
  })

  it("leaves practice alone when no round is named", async () => {
    const { session, requests } = await fakeSession()
    const result = await applyLiveries(session, plan())
    expect(result.practiceRestarted).toBe(false)
    expect(requests.filter((r) => r.url.includes("/practice"))).toEqual([])
  })
})

/**
 * Recording what was applied, for the carset pack
 * (docs/discord-livery-upload.md §6).
 *
 * Hung off the apply so that every route in is covered by construction. The
 * tests that matter here are the two orderings: nothing recorded when the
 * server write did not land, and a recording failure that does not read as an
 * apply failure.
 */
describe("recording what was applied", () => {
  const recorder = (fail?: Error) => {
    const calls: { championshipId: string; drivers: string[]; source: string }[] = []
    return {
      calls,
      record: async (
        championshipId: string,
        liveries: readonly Livery[],
        _at: Date,
        source: string,
      ) => {
        if (fail) throw fail
        calls.push({ championshipId, drivers: liveries.map((l) => l.driverName), source })
        return { stored: liveries.length, unchanged: 0 }
      },
    }
  }

  it("records every livery it applied, with the source it was given", async () => {
    const { session } = await fakeSession()
    const record = recorder()
    const result = await applyLiveries(
      session,
      plan(undefined, livery("Misha"), livery("postaL")),
      {
        record,
        source: "discord",
      },
    )

    expect(record.calls).toEqual([
      { championshipId: CHAMP_ID, drivers: ["Misha", "postaL"], source: "discord" },
    ])
    expect(result.recorded).toEqual({ stored: 2, unchanged: 0 })
  })

  it("records nothing when the championship save failed", async () => {
    // An uploaded skin nothing points at is not on the grid. Recording it would
    // put artwork in the carset for a car that still shows the default.
    const { session } = await fakeSession({ submitStatus: 200 })
    const record = recorder()
    await expect(applyLiveries(session, plan(), { record })).rejects.toThrow()
    expect(record.calls).toEqual([])
  })

  it("records nothing when an upload failed", async () => {
    const { session } = await fakeSession({ uploadStatus: 200 })
    const record = recorder()
    await expect(applyLiveries(session, plan(), { record })).rejects.toThrow()
    expect(record.calls).toEqual([])
  })

  it("says the liveries are applied when only the recording failed", async () => {
    // The obvious message is wrong in both directions: "failed to apply" sends
    // an operator to re-upload something already on the server, and swallowing
    // it leaves the carset quietly missing a car.
    const { session } = await fakeSession()
    const record = recorder(new Error("database is locked"))
    await expect(applyLiveries(session, plan(), { record })).rejects.toThrow(LiveryRecordError)
    await expect(applyLiveries(session, plan(), { record })).rejects.toThrow(
      /uploaded and assigned — that part worked/,
    )
    await expect(applyLiveries(session, plan(), { record })).rejects.toThrow(/database is locked/)
  })

  /**
   * The case that used to be "nothing to do", and is the one that matters most.
   *
   * A driver who fixed a wrong sponsor and resubmitted keeps the same skin
   * folder — it is their own name — so `EntryList.Skin` needs no edit and
   * `skinChanges` is empty. The *bytes* still changed, and the upload still
   * happened. Recording only what moved the form would leave the carset handing
   * the whole grid the livery that was just replaced, which is the exact bug
   * the plan's `noop` flag used to cause on the server.
   */
  it("records a re-upload even when the entry list needs no change", async () => {
    const c = championship({
      ID: CHAMP_ID,
      Classes: [
        championshipClass({ Entrants: entryList([person({ Name: "Misha", Skin: "Misha" })]) }),
      ],
      Events: [raceEvent({ ID: EVENT_ID, EntryList: {} })],
    })
    const { session } = await fakeSession()
    const record = recorder()
    const plan = planLiveries(c, CHAMP_ID, packOf(livery("Misha")))
    expect(plan.skinChanges).toEqual([])

    const result = await applyLiveries(session, plan, { record })
    expect(result.championshipSaved).toBe(false)
    expect(record.calls).toEqual([
      { championshipId: CHAMP_ID, drivers: ["Misha"], source: "unknown" },
    ])
    expect(result.recorded).toEqual({ stored: 1, unchanged: 0 })
  })

  it("applies exactly as before when there is no recorder", async () => {
    const { session, requests } = await fakeSession()
    const result = await applyLiveries(session, plan())
    expect(result.championshipSaved).toBe(true)
    expect(result.recorded).toBeUndefined()
    expect(requests.some((r) => r.url.includes(CHAMPIONSHIP_SUBMIT_PATH))).toBe(true)
  })
})

describe("how long an upload is given", () => {
  const MB = 1024 * 1024

  it("allows far more than the session default for a large livery", () => {
    // AcsmSession's default is 30s, which is right for a page of HTML and
    // aborts a legitimate 48 MB upload — reachable since the pack limits were
    // doubled. This is the number that stops that.
    expect(uploadTimeoutMs(48 * MB)).toBeGreaterThan(180_000)
  })

  it("keeps a floor for a small one", () => {
    // A tiny upload still gets the ordinary allowance; the size term is added
    // to it rather than replacing it, so a 3 KB skin isn't given 30ms.
    expect(uploadTimeoutMs(3 * 1024)).toBeGreaterThanOrEqual(30_000)
    expect(uploadTimeoutMs(0)).toBe(30_000)
  })

  it("actually uses it, instead of the session's default", async () => {
    // The arithmetic above is worthless if nobody passes it. Here the session
    // would abort after 5ms and the upload takes 60ms, so this only passes if
    // the per-request timeout reaches AbortController — which is both halves of
    // the wiring: uploadSkin passing it, and the session honouring it.
    const { session, requests } = await fakeSession({ sessionTimeoutMs: 5, skinDelayMs: 60 })
    const result = await applyLiveries(session, plan())
    expect(result.uploaded).toHaveLength(1)
    expect(requests.filter((r) => r.url.includes("/skin"))).toHaveLength(1)
  })

  it("grows with the payload rather than being one fixed number", () => {
    // A flat ten minutes would work and would also wait ten minutes on a
    // request that died in the first second.
    expect(uploadTimeoutMs(64 * MB)).toBeGreaterThan(uploadTimeoutMs(8 * MB))
  })

  it("assumes an uplink slow enough to be nobody's bottleneck", () => {
    // 256 KB/s is about 2 Mbit. Wrong high aborts a good upload; wrong low
    // costs a wait on one that was never going to finish.
    const seconds = (uploadTimeoutMs(10 * MB) - 30_000) / 1000
    expect(seconds).toBe(40)
  })
})

describe("applyLiveries refusals", () => {
  it("still writes the right driver when a sign-up shifted every row", async () => {
    // The old code computed the row from the export and refused when the name
    // there had moved. Looking the row up by name makes an approved sign-up a
    // non-event instead of a refusal — which is what the operator wants at nine
    // on a race night.
    const { session, requests } = await fakeSession({ formNames: ["Newcomer", "Misha", "postaL"] })
    await applyLiveries(session, plan())
    const body = new URLSearchParams(
      requests.find((r) => r.url.includes(CHAMPIONSHIP_SUBMIT_PATH))?.body ?? "",
    )
    expect(body.getAll("EntryList.Name")).toEqual(["Stream Van", "Newcomer", "Misha", "postaL"])
    // Misha is at row 2 now, not row 1. Newcomer keeps their own empty skin.
    expect(body.getAll("EntryList.Skin")).toEqual(["", "", "Misha", ""])
  })

  it("refuses when the driver has left the entry list entirely", async () => {
    const { session, requests } = await fakeSession({ formNames: ["postaL"] })
    await expect(applyLiveries(session, plan())).rejects.toThrow(RosterChangedError)
    await expect(applyLiveries(session, plan())).rejects.toThrow(
      /the entry list on the form does not have them/,
    )
    expect(requests.filter((r) => r.url.includes(CHAMPIONSHIP_SUBMIT_PATH))).toEqual([])
  })

  it("stops before the championship save when an upload fails", async () => {
    const { session, requests } = await fakeSession({ uploadStatus: 200 })
    await expect(applyLiveries(session, plan())).rejects.toThrow(/didn't accept Misha's livery/)
    expect(requests.filter((r) => r.url.includes(CHAMPIONSHIP_SUBMIT_PATH))).toEqual([])
  })

  it("explains a timed-out upload as the uplink rather than as ACSM", async () => {
    // Otherwise it reads as "the request failed", which sends whoever is
    // holding the zip looking at Server Manager.
    // An AbortError from fetch is exactly what the session's own
    // AbortController produces on a timeout, and it is what #fetchOnce turns
    // into "timed out". Simulating it beats waiting for a real one.
    const slow = new AcsmSession({
      baseUrl: "https://acsm.example",
      rateLimit: false,
      fetch: async (input) => {
        if (String(input).includes("/skin")) {
          const abort = new Error("This operation was aborted")
          abort.name = "AbortError"
          throw abort
        }
        return new Response("", { status: 302, headers: { location: "/" } })
      },
    })
    await expect(applyLiveries(slow, plan())).rejects.toThrow(
      /Uploading Misha's livery for .* timed out/,
    )
  })

  it("treats a 200 from the championship save as a failure", async () => {
    // ACSM reports a rejected form by re-rendering the page with a flash and a
    // 200, so the redirect is the only success signal there is.
    const { session } = await fakeSession({ submitStatus: 200 })
    await expect(applyLiveries(session, plan())).rejects.toThrow(
      /didn't accept the championship save/,
    )
  })

  it("reports a failed practice restart as the partial write it is", async () => {
    // Re-running would re-post a whole championship to fix something a click in
    // ACSM fixes, so the message has to say what already landed.
    const { session } = await fakeSession({ practiceStatus: 500 })
    await expect(
      applyLiveries(session, plan(), { restartPracticeRound: 1, eventIds: [EVENT_ID] }),
    ).rejects.toThrow(/uploaded and assigned, and only the practice restart failed/)
  })

  it("reports a round that doesn't exist without pretending nothing landed", async () => {
    const { session } = await fakeSession()
    await expect(
      applyLiveries(session, plan(), { restartPracticeRound: 3, eventIds: [EVENT_ID] }),
    ).rejects.toThrow(/no round 3 to restart/)
  })
})
