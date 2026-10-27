import { describe, expect, it } from "vitest"

import { type AcsmReader, StaticAcsmReader } from "../src/acsm/client.js"
import type { Championship } from "../src/acsm/types.js"
import { type InfoEmbed, infoEmbed, infoText } from "../src/info/embed.js"
import { ChampionshipInfo, InfoRouter } from "../src/info/post.js"
import type { SlashCommand } from "../src/bot/transport.js"
import { championship, raceEvent, testProfile } from "./support/build.js"

const ADMIN = "777777777777777777"
const CHANNEL = "790738391469654038"
const GUILD = "338186558282924032"

describe("infoText", () => {
  it("takes the first heading as the title and the rest as Discord markdown", () => {
    const html =
      `<html><body><h1><img src="data:image/jpeg;base64,AAAA"/><br/></h1>` +
      `<h1><span>Ghosts &amp; Giants</span></h1>` +
      `<p dir="ltr"><span>Four tracks, </span><b>two</b><span> giants &#39;n* ghosts.</span></p>` +
      `<p><span>Race Dates:</span></p>` +
      `<ul><li><p>October 7: Fuji</p></li><li><p>October 14: Interlagos</p></li></ul>` +
      `<p>AC Server: <a href="https://ac.example/live">https://ac.example/live</a>` +
      `<a href="https://ac.example/live"> </a> and <a href="https://x.example">our Discord</a></p>` +
      `<p><iframe src="//www.youtube.com/embed/x"></iframe><br/></p></body></html>`
    expect(infoText(html)).toEqual({
      title: "Ghosts & Giants",
      body:
        "Four tracks, **two** giants 'n\\* ghosts.\n\n" +
        "Race Dates:\n\n" +
        "• October 7: Fuji\n• October 14: Interlagos\n\n" +
        "AC Server: https://ac.example/live  and [our Discord](https://x.example)",
      image: "data:image/jpeg;base64,AAAA",
    })
  })

  it("keeps text outside paragraphs, and markdown in it reading as itself", () => {
    const html =
      `<body>Rules first.<br/>Be kind.<div>Track: <a href="https://w.example/Spa_(circuit)">Spa [GP]</a></div>` +
      `<div># not a heading</div></body>`
    expect(infoText(html).body).toBe(
      "Rules first.\nBe kind.\n\nTrack: [Spa \\[GP\\]](https://w.example/Spa_%28circuit%29)\n\n\\# not a heading",
    )
  })

  it("is empty for a championship with no info", () => {
    expect(infoText("")).toEqual({ body: "" })
  })
})

describe("infoEmbed", () => {
  const profile = testProfile()
  const c = (over: Partial<Championship> = {}) =>
    championship({
      ID: "be7446cd-b2c0-4157-8094-4d16add5be9d",
      Name: "BATL October",
      Events: [
        raceEvent({
          CompletedTime: "2026-10-08T05:00:00Z",
          Scheduled: "0001-01-01T00:00:00Z",
          RaceSetup: { Track: "fuji68" },
        }),
        raceEvent({ Scheduled: "2026-10-28T19:00:00-07:00", RaceSetup: { Track: "thomson" } }),
        raceEvent({ Scheduled: "0001-01-01T00:00:00Z", RaceSetup: { Track: "" } }),
      ],
      ...over,
    })
  const options = {
    profile,
    baseUrl: "https://ac.example/",
    trackNames: new Map([["fuji68", "Fuji Speedway 1968"]]),
    links: [{ label: "Twitch", url: "https://twitch.example" }],
  }

  it("lists the rounds, raced struck out and quali in everyone's own time", () => {
    const e = infoEmbed(c(), options)
    // Practice at 19:00 Pacific and 60 minutes of it: quali at 20:00 PDT, 03:00 UTC.
    expect(e.fields[0]).toEqual({
      name: "Rounds",
      value: `~~1. Fuji Speedway 1968~~\n2. thomson: <t:${Date.parse("2026-10-29T03:00:00Z") / 1000}:F>\n3. to be announced: date to come`,
    })
  })

  it("links the sign-up, the profile's links and the carset", () => {
    expect(infoEmbed(c(), options).fields[1]?.value).toMatch(/^\[Details\]/)
    const e = infoEmbed(c({ SignUpForm: { Enabled: true } }), {
      ...options,
      profile: testProfile({ discord: { livery: {} } }),
      carsetUrl: "https://up.example/c/abc",
    })
    const signUp = "https://ac.example/championship/be7446cd-b2c0-4157-8094-4d16add5be9d"
    expect(e.url).toBe(signUp)
    expect(e.title).toBe("BATL October")
    expect(e.fields[1]?.value).toBe(
      `[Sign up](${signUp}) · [Twitch](https://twitch.example) · [Everyone's liveries](https://up.example/c/abc)\n` +
        "Send your livery with `/livery upload`.",
    )
  })

  it("tells two layouts of one track apart", () => {
    const e = infoEmbed(
      c({
        Events: [
          raceEvent({ RaceSetup: { Track: "fuji68", TrackLayout: "gp" } }),
          raceEvent({ RaceSetup: { Track: "fuji68", TrackLayout: "short" } }),
        ],
      }),
      options,
    )
    expect(e.fields[0]?.value).toMatch(
      /^1\. Fuji Speedway 1968 \(gp\):.*\n2\. Fuji Speedway 1968 \(short\):/,
    )
  })

  it.each([
    ["a link", `<img src="https://img.example/a.png">`, "https://img.example/a.png", undefined],
    [
      "one pasted in, as an attachment",
      `<p><img src="data:image/png;base64,${Buffer.from("png!").toString("base64")}"></p>`,
      "attachment://picture.png",
      { name: "picture.png", data: Buffer.from("png!") },
    ],
    [
      "none for a file that isn't a picture",
      `<img src="data:text/html;base64,PGI+">`,
      undefined,
      undefined,
    ],
  ])("shows the info's picture: %s", (_, Info, image, file) => {
    const e = infoEmbed(c({ Info }), options)
    expect(e.image).toBe(image)
    expect(e.file).toEqual(file)
  })

  it("keeps within Discord's limits on a title and a whole embed", () => {
    const e = infoEmbed(
      c({
        Info: `<h1>${"T".repeat(300)}</h1>${`<p>${"word ".repeat(150)}</p>`.repeat(10)}`,
        Events: Array.from({ length: 40 }, () =>
          raceEvent({ RaceSetup: { Track: "x".repeat(40) } }),
        ),
      }),
      {
        ...options,
        links: Array.from({ length: 30 }, () => ({
          label: "L".repeat(20),
          url: "https://x.example/abc",
        })),
      },
    )
    expect(e.title.length).toBeLessThanOrEqual(256)
    const total =
      e.title.length +
      e.description.length +
      e.footer.length +
      e.fields.reduce((n, f) => n + f.name.length + f.value.length, 0)
    expect(total).toBeLessThanOrEqual(6000)
  })

  it("cuts a story too long for an embed at a line", () => {
    const para = `<p>${"word ".repeat(150)}</p>`
    const e = infoEmbed(c({ Info: `<h1>T</h1>${para.repeat(10)}` }), options)
    expect(e.description.length).toBeLessThanOrEqual(4096)
    expect(e.description.endsWith("\n…") || e.description.endsWith("…")).toBe(true)
    expect(e.description).not.toMatch(/wor…$/)
  })
})

function harness(
  championships: Championship[],
  unreadable: string[] = [],
  store = new Map<string, string>(),
) {
  const inner = new StaticAcsmReader(championships)
  const exported: string[] = []
  const reader = {
    listChampionships: () => inner.listChampionships(),
    listContent: () => inner.listContent(),
    exportChampionship: async (id: string) => {
      exported.push(id)
      if (unreadable.includes(id)) throw new Error("timed out")
      return inner.exportChampionship(id)
    },
  } as unknown as AcsmReader
  const posted: InfoEmbed[] = []
  const edited: { id: string; embed: InfoEmbed }[] = []
  const removed: string[] = []
  let gone = false
  const info = new ChampionshipInfo({
    reader,
    profile: testProfile(),
    baseUrl: "https://ac.example",
    links: [],
    store: { get: (k) => store.get(k), set: (k, v) => void store.set(k, v) },
    channel: {
      post: async (embed) => {
        posted.push(embed)
        return `m${posted.length}`
      },
      edit: async (id, embed) => {
        if (gone) return false
        edited.push({ id, embed })
        return true
      },
      remove: async (id) => {
        removed.push(id)
      },
      exists: async () => !gone,
    },
    log: () => {},
  })
  return {
    info,
    exported,
    posted,
    edited,
    removed,
    deleteIt: () => {
      gone = true
    },
  }
}

const season = (id: string, created: string, over: Partial<Championship> = {}) =>
  championship({ ID: id, Name: id, Created: created, Events: [raceEvent()], ...over })

describe("ChampionshipInfo", () => {
  const running = season("00000000-0000-0000-0000-00000000000a", "2026-09-30T00:00:00Z", {
    Events: [raceEvent({ StartedTime: "2026-10-08T03:00:00Z" })],
  })

  it("posts once, edits only when it would say something new, and posts again if deleted", async () => {
    const h = harness([running])
    expect(await h.info.refresh()).toBe("m1")
    expect(await h.info.refresh()).toBe("m1")
    expect(h.edited).toEqual([])
    running.Name = "Renamed"
    await h.info.refresh()
    expect(h.edited.map((e) => e.embed.title)).toEqual(["Renamed"])
    h.deleteIt()
    expect(await h.info.refresh()).toBe("m2")
  })

  it("edits when only the picture changes", async () => {
    const pictured = (bytes: string) =>
      season("00000000-0000-0000-0000-00000000000a", "2026-09-30T00:00:00Z", {
        Info: `<img src="data:image/png;base64,${Buffer.from(bytes).toString("base64")}">`,
        Events: [raceEvent({ StartedTime: "2026-10-08T03:00:00Z" })],
      })
    const first = pictured("one")
    const h = harness([first])
    await h.info.refresh()
    first.Info = pictured("two").Info
    await h.info.refresh()
    expect(h.edited.map((e) => Buffer.from(e.embed.file?.data ?? []).toString())).toEqual(["two"])
  })

  it("shows the newest season racing or taking sign-ups, not a draft", async () => {
    const open = season("00000000-0000-0000-0000-00000000000b", "2026-10-20T00:00:00Z", {
      SignUpForm: { Enabled: true },
    })
    const draft = season("00000000-0000-0000-0000-00000000000c", "2026-10-25T00:00:00Z")
    const h = harness([running, open, draft])
    await h.info.refresh()
    expect(h.posted.map((e) => e.title)).toEqual([open.Name])
  })

  it("reads only the championship shown and newer ones once it knows when each was made, restarted or not", async () => {
    const old = season("00000000-0000-0000-0000-000000000001", "2025-01-01T00:00:00Z", {
      Events: [raceEvent({ StartedTime: "2025-01-08T03:00:00Z" })],
    })
    const store = new Map<string, string>()
    const h = harness([old, running], [], store)
    await h.info.refresh()
    h.exported.length = 0
    await h.info.refresh()
    expect(h.exported).toEqual([running.ID])
    const restarted = harness([old, running], [], store)
    await restarted.info.refresh()
    expect(restarted.exported).toEqual([running.ID])
  })

  it("skips an old championship it can't read, but won't guess past a new one", async () => {
    const newer = "00000000-0000-0000-0000-00000000000d"
    const h = harness(
      [
        season("00000000-0000-0000-0000-000000000001", "2025-01-01T00:00:00Z"),
        running,
        season(newer, "2026-10-25T00:00:00Z"),
      ],
      ["00000000-0000-0000-0000-000000000001", newer],
    )
    await expect(h.info.refresh()).rejects.toThrow(/couldn't read every championship/)
    expect(h.posted).toEqual([])
  })

  it("posts nothing with nothing to show", async () => {
    const h = harness([season("00000000-0000-0000-0000-00000000000c", "2026-10-25T00:00:00Z")])
    expect(await h.info.refresh()).toBeUndefined()
    expect(h.posted).toEqual([])
  })
})

describe("InfoRouter", () => {
  const running = season("00000000-0000-0000-0000-00000000000a", "2026-09-30T00:00:00Z", {
    Events: [raceEvent({ StartedTime: "2026-10-08T03:00:00Z" })],
  })
  const command = (over: Partial<SlashCommand> = {}): SlashCommand => ({
    name: "championship",
    subcommand: "info",
    options: {},
    userId: "1",
    username: "admin",
    guildId: GUILD,
    channelId: "5",
    roleIds: [ADMIN],
    ...over,
  })
  const router = (h: ReturnType<typeof harness>) =>
    new InfoRouter({ info: h.info, adminRoleId: ADMIN, guildId: GUILD, channelId: CHANNEL })

  it("is for admins", async () => {
    const h = harness([running])
    expect((await router(h).handle(command({ roleIds: [] }))).content).toMatch(/Only admins/)
    expect(h.posted).toEqual([])
  })

  it.each([
    [`https://discord.com/channels/${GUILD}/${CHANNEL}/123456789012345678`],
    ["123456789012345678"],
  ])("replaces the message it's given, once its own is up: %s", async (replace) => {
    const h = harness([running])
    const reply = await router(h).handle(command({ options: { replace } }))
    expect(reply.content).toBe(`Updated: https://discord.com/channels/${GUILD}/${CHANNEL}/m1`)
    expect(h.removed).toEqual(["123456789012345678"])
  })

  it("won't delete a message in another channel", async () => {
    const h = harness([running])
    const replace = `https://discord.com/channels/${GUILD}/111111111111111111/123456789012345678`
    expect((await router(h).handle(command({ options: { replace } }))).content).toMatch(
      /takes a message in/,
    )
    expect(h.posted).toEqual([])
    expect(h.removed).toEqual([])
  })
})
