import { zipSync } from "fflate"
import { describe, expect, it } from "vitest"

import type { Entrant } from "../src/acsm/types.js"
import {
  DEFAULT_UPLOAD_LIMITS,
  clampProblem,
  handleClaim,
  handleUpload,
  handleUploadUrl,
  uploadReply,
  type UploadContext,
  type UploadQueue,
} from "../src/bot/livery.js"
import { SqliteClaimStore, type DriverClaim } from "../src/liveries/claims.js"
import { DEFAULT_LIMITS } from "../src/liveries/pack.js"
import { autoApplyPromised, DRAIN_STALE_AFTER_MS } from "../src/liveries/accept.js"
import { SqliteSubmissionQueue } from "../src/liveries/queue.js"
import { SqliteTokenStore } from "../src/liveries/upload-token.js"
import { championship, championshipClass, entryList } from "./support/build.js"

const CAR = "rss_formula_hybrid_2021"
const CHAMP = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
const MISHA = "111111111111111111"
const GUILD = "999999999999999999"
const LIVERY_CHANNEL = "888888888888888888"
const OTHER_CHANNEL = "777777777777777777"
const RACER_ROLE = "666666666666666666"

const bytes = (s: string) => new TextEncoder().encode(s)
const skin = (extra: Record<string, Uint8Array> = {}) =>
  zipSync({ "livery.dds": bytes("dds"), "preview.jpg": bytes("jpg"), ...extra })

const person = (over: Partial<Entrant>): Partial<Entrant> => ({ Model: CAR, Skin: "", ...over })

const champ = (names: string[] = ["Misha", "postaL"]) =>
  championship({
    Name: "September 2026",
    Classes: [championshipClass({ Entrants: entryList(names.map((Name) => person({ Name }))) })],
  })

/** `guildId: undefined` is the DM case, so it has to be expressible. */
type ContextOverride = { [K in keyof UploadContext]?: UploadContext[K] | undefined }

const context = (over: ContextOverride = {}): UploadContext => {
  const merged: ContextOverride = {
    discordUserId: MISHA,
    discordHandle: "misha",
    guildId: GUILD,
    channelId: LIVERY_CHANNEL,
    roleIds: [RACER_ROLE],
    ...over,
  }
  // Drop the keys explicitly set to undefined rather than carrying them, so a
  // DM context is genuinely absent a guild rather than holding one that is
  // undefined — which is the distinction the clamp turns on.
  for (const key of Object.keys(merged) as (keyof ContextOverride)[]) {
    if (merged[key] === undefined) delete merged[key]
  }
  return merged as UploadContext
}

const claim = (over: Partial<DriverClaim> = {}): DriverClaim => ({
  discordUserId: MISHA,
  entrantName: "Misha",
  discordHandle: "misha",
  claimedAt: "2026-09-01T20:00:00.000Z",
  ...over,
})

/** A queue that records rather than stores, so most tests need no database. */
const fakeQueue = (over: Partial<UploadQueue> = {}): UploadQueue & { calls: unknown[] } => {
  const calls: unknown[] = []
  return {
    calls,
    submit: async (input) => {
      calls.push(input)
      return {
        submission: {
          id: calls.length,
          discordUserId: input.discordUserId,
          championshipId: input.championshipId,
          driverName: input.driverName,
          carModel: input.carModel,
          skinFolder: input.skinFolder,
          bytes: input.body.length,
          state: "queued" as const,
          submittedAt: input.at.toISOString(),
        },
      }
    },
    lastAcceptedAt: async () => undefined,
    queuedBytes: async () => 0,
    ...over,
  }
}

const NOW = new Date("2026-09-02T20:00:00.000Z")

const upload = (over: Partial<Parameters<typeof handleUpload>[0]> = {}) =>
  handleUpload({
    context: context(),
    clamp: {},
    championship: champ(),
    championshipId: CHAMP,
    claim: claim(),
    body: skin(),
    queue: fakeQueue(),
    now: NOW,
    ...over,
  })

describe("clampProblem", () => {
  it("lets anyone through when nothing is configured", () => {
    expect(clampProblem({}, context())).toBeUndefined()
  })

  it("refuses a channel that isn't the livery channel", () => {
    expect(
      clampProblem({ channelIds: [LIVERY_CHANNEL] }, context({ channelId: OTHER_CHANNEL })),
    ).toMatch(/Not here/)
  })

  it("refuses someone without the role", () => {
    expect(clampProblem({ roleIds: [RACER_ROLE] }, context({ roleIds: [] }))).toMatch(
      /limited to a role you don't have/,
    )
  })

  /**
   * A role clamp implies a guild clamp.
   *
   * DMs have no member and no roles, so a `/livery` invoked in one cannot
   * satisfy a role check — and "you don't have the role" is baffling to someone
   * who does and simply isn't anywhere the server can see it.
   */
  it("explains a DM rather than reporting a missing role", () => {
    const problem = clampProblem({ roleIds: [RACER_ROLE] }, context({ guildId: undefined }))
    expect(problem).toMatch(/a DM has no roles in it/)
    expect(problem).toMatch(/Run this in the server/)
  })

  it("allows a DM when only channels are clamped and the channel matches", () => {
    expect(
      clampProblem({ channelIds: [LIVERY_CHANNEL] }, context({ guildId: undefined })),
    ).toBeUndefined()
  })

  it("ANDs the two, so the right channel with the wrong role still refuses", () => {
    expect(
      clampProblem(
        { channelIds: [LIVERY_CHANNEL], roleIds: [RACER_ROLE] },
        context({ roleIds: ["nope"] }),
      ),
    ).toMatch(/role/)
  })
})

describe("handleUpload", () => {
  it("queues a valid livery and says what it took", async () => {
    const queue = fakeQueue()
    const result = await upload({ queue })
    expect(result.ok).toBe(true)
    expect(queue.calls).toHaveLength(1)
    expect(queue.calls[0]).toMatchObject({
      driverName: "Misha",
      carModel: CAR,
      skinFolder: "Misha",
    })
  })

  /**
   * The car comes from `Entrant.Model` and the driver from the claim, so the
   * attachment's filename — the one piece of driver-controlled text in this
   * flow — is used for nothing at all.
   */
  it("never takes a name from anything the submitter chose", async () => {
    const queue = fakeQueue()
    await upload({ queue, body: zipSync({ "../evil/livery.dds": bytes("d") }) }).catch(() => {})
    // That upload is refused outright; the point is that a *valid* one still
    // gets its names from the entry list.
    await upload({ queue })
    expect(queue.calls.at(-1)).toMatchObject({ carModel: CAR, driverName: "Misha" })
  })

  it("checks the clamp before unpacking anything", async () => {
    // A driver in the wrong channel should not have their zip unpacked to find
    // out. The zip here is not a livery at all, and the reply is about the
    // channel.
    const result = await upload({
      clamp: { channelIds: [LIVERY_CHANNEL] },
      context: context({ channelId: OTHER_CHANNEL }),
      body: bytes("not a zip"),
    })
    expect(result).toMatchObject({ ok: false, reason: "clamp" })
    expect(result.reply).toMatch(/Not here/)
  })

  it("tells an unclaimed driver what to run", async () => {
    const result = await upload({ claim: undefined })
    expect(result).toMatchObject({ ok: false, reason: "identity" })
    expect(result.reply).toMatch(/\/livery claim/)
  })

  it("passes the pack refusal through in the driver's own terms", async () => {
    // LiveryPackError messages were written for a driver to read; this is where
    // that pays off, while they are still looking at Discord.
    const result = await upload({ body: skin({ "work.psd": bytes("x") }) })
    expect(result).toMatchObject({ ok: false, reason: "pack" })
    expect(result.reply).toMatch(/Photoshop source file/)
  })

  it("refuses a zip with no .dds, so it isn't a livery", async () => {
    const result = await upload({ body: zipSync({ "readme.txt": bytes("hi") }) })
    expect(result.reply).toMatch(/no .dds file/)
  })

  it("refuses something that isn't a zip without leaking the exception", async () => {
    const result = await upload({ body: bytes("definitely not a zip") })
    expect(result).toMatchObject({ ok: false, reason: "pack" })
  })

  it("holds a driver to a cooldown after an accepted upload", async () => {
    const queue = fakeQueue({
      lastAcceptedAt: async () => new Date(NOW.getTime() - 60_000),
    })
    const result = await upload({ queue })
    expect(result).toMatchObject({ ok: false, reason: "cooldown" })
    expect(result.reply).toMatch(/4 minutes/)
  })

  it("lets them through once the cooldown has passed", async () => {
    const queue = fakeQueue({
      lastAcceptedAt: async () => new Date(NOW.getTime() - DEFAULT_UPLOAD_LIMITS.cooldownMs - 1),
    })
    expect((await upload({ queue })).ok).toBe(true)
  })

  it("refuses when the queue is already full, in a sentence", async () => {
    // The driver who happens to be the hundredth did nothing wrong.
    const queue = fakeQueue({ queuedBytes: async () => DEFAULT_UPLOAD_LIMITS.maxQueuedBytes })
    const result = await upload({ queue })
    expect(result).toMatchObject({ ok: false, reason: "queue-full" })
    expect(result.reply).toMatch(/An admin needs to run the drain/)
  })

  it("refuses an entrant with no car assigned yet", async () => {
    const c = championship({
      Name: "September 2026",
      Classes: [
        championshipClass({ Entrants: entryList([{ Name: "Misha", Model: "", Skin: "" }]) }),
      ],
    })
    expect((await upload({ championship: c })).reply).toMatch(/no car assigned/)
  })

  it("works end to end through the real queue", async () => {
    const queue = await SqliteSubmissionQueue.open(":memory:")
    const result = await upload({ queue })
    expect(result.ok).toBe(true)
    expect((await queue.queued(CHAMP)).map((s) => s.driverName)).toEqual(["Misha"])
    queue.close()
  })

  it("says when it replaced an earlier upload", async () => {
    const queue = await SqliteSubmissionQueue.open(":memory:")
    await upload({ queue })
    const second = await upload({
      queue,
      now: new Date(NOW.getTime() + DEFAULT_UPLOAD_LIMITS.cooldownMs + 1),
    })
    expect(second.reply).toMatch(/replaces the one you sent earlier/)
    expect(await queue.queued(CHAMP)).toHaveLength(1)
    queue.close()
  })

  it("takes limits it is given rather than only the defaults", async () => {
    const result = await upload({
      limits: { ...DEFAULT_UPLOAD_LIMITS, pack: { ...DEFAULT_LIMITS, maxFileBytes: 2 } },
    })
    expect(result.reply).toMatch(/over the/)
  })
})

describe("what the driver is told", () => {
  const facts = {
    driverName: "Misha",
    carModel: CAR,
    fileCount: 2,
    hasPreview: true,
    replaced: false,
    autoApply: false,
  }

  /**
   * The sentence that stops the retry loop.
   *
   * Bot uploads never restart practice — a driver at 8pm must not be able to
   * disconnect everyone else over a cosmetic change — so the livery appears at
   * the *next* practice start. Without saying so, a driver joins practice, sees
   * the old car, assumes it failed, and uploads again.
   */
  it("says practice that's running keeps the old entry list", () => {
    expect(uploadReply(facts)).toMatch(/practice that's running now keeps the old entry list/)
  })

  it("does not claim it is on the server when an admin still has to apply it", () => {
    const reply = uploadReply(facts)
    expect(reply).toMatch(/queued for an admin/)
    expect(reply).not.toMatch(/on the server (now|already)/)
  })

  it("says it goes on shortly when the drain runs on a timer", () => {
    expect(uploadReply({ ...facts, autoApply: true })).toMatch(/go on the server shortly/)
  })

  it("mentions a missing preview, which races fine and looks broken", () => {
    expect(uploadReply({ ...facts, hasPreview: false })).toMatch(/blank tile in Content Manager/)
  })

  it("says nothing about previews when there is one", () => {
    expect(uploadReply(facts)).not.toMatch(/blank tile/)
  })

  it("counts one file without pluralising it", () => {
    expect(uploadReply({ ...facts, fileCount: 1 })).toMatch(/1 file for/)
  })
})

describe("handleClaim", () => {
  const request = (over: Partial<Parameters<typeof handleClaim>[0]> = {}) => ({
    context: context(),
    clamp: {},
    championship: champ(),
    entrantName: "Misha",
    ...over,
  })

  it("claims, and announces it", async () => {
    // Nothing verifies that a driver is who they say, so being named in the
    // admin channel *is* the check.
    const store = await SqliteClaimStore.open(":memory:")
    const result = await handleClaim(request(), store, NOW)

    expect(result.ok).toBe(true)
    expect(result.reply).toMatch(/You're claimed as "Misha"/)
    expect((result as { announcement: string }).announcement).toMatch(/claimed the entry list name/)
    store.close()
  })

  it("announces even a claim that looks fine", async () => {
    const store = await SqliteClaimStore.open(":memory:")
    await store.rememberHandleHint("Misha", "misha", NOW)
    const result = await handleClaim(request(), store, NOW)
    expect((result as { announcement: string }).announcement).toMatch(/Matches the Discord handle/)
    store.close()
  })

  it("passes the refusal through when the name isn't on the entry list", async () => {
    const store = await SqliteClaimStore.open(":memory:")
    const result = await handleClaim(request({ entrantName: "Nobody" }), store, NOW)
    expect(result).toMatchObject({ ok: false })
    expect(result.reply).toMatch(/isn't on the entry list/)
    store.close()
  })

  it("obeys the same clamp as an upload", async () => {
    const store = await SqliteClaimStore.open(":memory:")
    const result = await handleClaim(
      request({
        clamp: { channelIds: [LIVERY_CHANNEL] },
        context: context({ channelId: OTHER_CHANNEL }),
      }),
      store,
      NOW,
    )
    expect(result).toMatchObject({ ok: false })
    expect(result.reply).toMatch(/Not here/)
    store.close()
  })

  it("claims then uploads, which is the whole flow", async () => {
    const store = await SqliteClaimStore.open(":memory:")
    const queue = await SqliteSubmissionQueue.open(":memory:")

    expect((await upload({ claim: undefined })).reply).toMatch(/\/livery claim/)
    await handleClaim(request(), store, NOW)
    const result = await upload({ claim: await store.forDiscordUser(MISHA), queue })

    expect(result.ok).toBe(true)
    expect(await queue.queued(CHAMP)).toHaveLength(1)
    store.close()
    queue.close()
  })
})

describe("handleUploadUrl", () => {
  type Req = Parameters<typeof handleUploadUrl>[0]
  const request = (over: { [K in keyof Req]?: Req[K] | undefined } = {}): Req => {
    const merged = {
      context: context(),
      clamp: {},
      championship: champ(),
      championshipId: CHAMP,
      claim: claim(),
      uploadBaseUrl: "https://liveries.example.com",
      ...over,
    }
    if (merged.uploadBaseUrl === undefined)
      delete (merged as { uploadBaseUrl?: string }).uploadBaseUrl
    return merged as Req
  }

  it("hands back a link scoped to the driver and car", async () => {
    const tokens = await SqliteTokenStore.open(":memory:")
    const result = await handleUploadUrl(request(), tokens, NOW)

    expect(result.ok).toBe(true)
    expect(result.reply).toMatch(/https:\/\/liveries\.example\.com\/u\/[A-Za-z0-9_-]{43}/)
    expect(result.reply).toMatch(/Misha's rss_formula_hybrid_2021/)
    tokens.close()
  })

  it("says it works once and for how long", async () => {
    const tokens = await SqliteTokenStore.open(":memory:")
    const result = await handleUploadUrl(request(), tokens, NOW)
    expect(result.reply).toMatch(/works once/)
    expect(result.reply).toMatch(/next 30 minutes/)
    tokens.close()
  })

  it("wraps the link so Discord doesn't unfurl it", async () => {
    // Belt and braces — GET doesn't spend the token either, but a preview card
    // for a credential is not a thing to put in a channel.
    const tokens = await SqliteTokenStore.open(":memory:")
    const result = await handleUploadUrl(request(), tokens, NOW)
    expect(result.reply).toMatch(/<https:\/\//)
    tokens.close()
  })

  it("tells the driver not to share it", async () => {
    const tokens = await SqliteTokenStore.open(":memory:")
    expect((await handleUploadUrl(request(), tokens, NOW)).reply).toMatch(/Don't share it/)
    tokens.close()
  })

  it("says so plainly when the league has no upload server", async () => {
    const tokens = await SqliteTokenStore.open(":memory:")
    const result = await handleUploadUrl(request({ uploadBaseUrl: undefined }), tokens, NOW)
    expect(result).toMatchObject({ ok: false })
    expect(result.reply).toMatch(/hasn't set up upload links/)
    tokens.close()
  })

  it("obeys the clamp", async () => {
    const tokens = await SqliteTokenStore.open(":memory:")
    const result = await handleUploadUrl(
      request({
        clamp: { channelIds: [LIVERY_CHANNEL] },
        context: context({ channelId: OTHER_CHANNEL }),
      }),
      tokens,
      NOW,
    )
    expect(result).toMatchObject({ ok: false })
    tokens.close()
  })

  it("won't mint for someone who hasn't claimed a driver", async () => {
    const tokens = await SqliteTokenStore.open(":memory:")
    const result = await handleUploadUrl(request({ claim: undefined }), tokens, NOW)
    expect(result.reply).toMatch(/\/livery claim/)
    tokens.close()
  })

  /**
   * Throws rather than handing the driver a working link over plain HTTP. The
   * mistake belongs to the operator and the driver cannot act on it, so a
   * failed command is the right place for it to surface.
   */
  it("refuses to put the token on plain http", async () => {
    const tokens = await SqliteTokenStore.open(":memory:")
    await expect(
      handleUploadUrl(request({ uploadBaseUrl: "http://liveries.example.com" }), tokens, NOW),
    ).rejects.toThrow(/has to be https/)
    tokens.close()
  })
})

describe("autoApplyPromised", () => {
  const now = new Date("2026-09-02T20:00:00.000Z")
  const ago = (ms: number) => new Date(now.getTime() - ms)

  it("promises nothing when the league hasn't configured it", () => {
    expect(autoApplyPromised(false, now, now)).toBe(false)
  })

  /**
   * The failure this exists for: `autoApply: true` in the profile with nobody
   * running `--drain --watch`. Without the heartbeat every driver is told
   * "shortly" for ever while nothing applies anything, and the reply is the
   * only place they'd have found out.
   */
  it("promises nothing when the watcher has never run", () => {
    expect(autoApplyPromised(true, undefined, now)).toBe(false)
  })

  it("promises when the watcher ran recently", () => {
    expect(autoApplyPromised(true, ago(60_000), now)).toBe(true)
  })

  it("stops promising when the heartbeat goes stale", () => {
    expect(autoApplyPromised(true, ago(DRAIN_STALE_AFTER_MS + 1000), now)).toBe(false)
  })

  it("tolerates a watcher that is merely slow", () => {
    // Flapping between two wordings would confuse a driver more than either.
    expect(autoApplyPromised(true, ago(DRAIN_STALE_AFTER_MS - 1000), now)).toBe(true)
  })

  it("changes what the driver is told, end to end", async () => {
    const queue = await SqliteSubmissionQueue.open(":memory:")
    const stale = await upload({ queue, autoApply: autoApplyPromised(true, undefined, NOW) })
    expect(stale.reply).toMatch(/queued for an admin/)

    await queue.recordDrainRun(CHAMP, NOW)
    const live = await upload({
      queue,
      now: new Date(NOW.getTime() + DEFAULT_UPLOAD_LIMITS.cooldownMs + 1),
      autoApply: autoApplyPromised(true, await queue.lastDrainRun(CHAMP), NOW),
    })
    expect(live.reply).toMatch(/go on the server shortly/)
    queue.close()
  })
})
