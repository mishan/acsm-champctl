/**
 * The JSON API the finalize screen runs on (plan §5.2).
 *
 * Thin on purpose. Everything that can lose a race night lives in
 * `src/finalize/`, and this reads a request, calls it, and shapes the answer —
 * the same relationship `src/cli/finalize.ts` has to the same engine. Two front
 * ends over one engine is the arrangement that keeps them agreeing about what a
 * push does; a second implementation of "which fields change" would be a second
 * set of bugs, and only one of the two would get fixed.
 *
 * Three things here are load-bearing rather than plumbing:
 *
 * **Routes are authenticated unless they say otherwise.** Not a list of
 * protected paths — a list of public ones, checked by a hook that runs for
 * everything. A route added without thinking about auth comes out protected,
 * which is the direction this has to fail in.
 *
 * **A push takes a plan id and nothing else.** Not a lap count, not a quali
 * time. See `plans.ts`: it is what makes the entry-list guard mean anything
 * across two HTTP requests, and what stops a client pushing a change nobody
 * previewed.
 *
 * **Numbers have upper bounds.** `formFieldsFor` posts `String(laps)`, and
 * JSON Schema's `integer` is happy with `1e30` — for which `Number.isInteger`
 * is true and `String` gives `"1e+30"`. A bound is the difference between a
 * rejected request and a race length ACSM parses as zero.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify"

import type { AcsmReader } from "../acsm/client.js"
import { AcsmAuthError, AcsmSession } from "../acsm/session.js"
import { ContentCache } from "./content-cache.js"
import { readTrackLayouts, type TrackLayouts } from "./layouts.js"
import { events } from "../acsm/view.js"
import { importChampionship } from "../acsm/write.js"
import { cloneChampionship } from "../emit/clone.js"
import {
  EmitError,
  type EmitResult,
  type ChampionshipSpec,
  type RoundSpec,
} from "../emit/championship.js"
import { applyFinalize, EntryListChangedError, PartialWriteError } from "../finalize/apply.js"
import {
  MAX_LAPS,
  MAX_MINUTES,
  MAX_REVERSED,
  readFormat,
  withOverrides,
  type FormatOverrides,
} from "../finalize/format.js"
import { planFinalize, type FinalizePlan } from "../finalize/plan.js"
import { applyReorder, PartialReorderError } from "../reorder/apply.js"
import { planReorder, type ReorderPlan } from "../reorder/plan.js"
import type { CheckReport } from "../gridmom/finding.js"
import { check } from "../gridmom/index.js"
import type { PitTable } from "../pits/table.js"
import { EMPTY_PIT_TABLE } from "../pits/table.js"
import type { LeagueProfile } from "../profile/types.js"
import { ApiError } from "./errors.js"
import { PlanStore } from "./plans.js"
import {
  DEFAULT_TTL_MS,
  SESSION_COOKIE,
  SessionStore,
  sessionCookieAttributes,
  type StoredSession,
} from "./sessions.js"
import { LoginThrottle } from "./throttle.js"
import {
  championshipList,
  championshipView,
  newChampionshipPlanView,
  planView,
  reorderPlanView,
  roundView,
} from "./view.js"
import type {
  ApplyResponse,
  ChampionshipListResponse,
  ChampionshipResponse,
  ConfigResponse,
  ContentResponse,
  LoginResponse,
  NewChampionshipResponse,
  NewChampionshipRequest,
  NewChampionshipPlanResponse,
  PlanRequest,
  PlanResponse,
  ReorderPlanResponse,
  ReorderRequest,
  ReorderResponse,
  SessionResponse,
  TrackRequest,
} from "./wire.js"

declare module "fastify" {
  interface FastifyContextConfig {
    /**
     * Reachable without a champctl session.
     *
     * Absent means protected. Every route that wants otherwise says so at the
     * route, where the person adding it is looking.
     */
    public?: boolean
  }
}

export interface ApiContext {
  profile: LeagueProfile
  pits: PitTable
  /** The league's ACSM. Logins and reads both go here. */
  baseUrl: string
  reader: AcsmReader
  sessions: SessionStore
  plans: PlanStore<FinalizePlan>
  /**
   * Championships awaiting confirmation. Separate from `plans` because they hold
   * different things and expire independently, not because the lease differs —
   * it is the same store with the same guarantees.
   */
  newChampionships: PlanStore<HeldChampionship>
  /**
   * Reorders awaiting confirmation. A third store for the same reason there is
   * a second: one lease, three things worth leasing, and none of them should
   * expire when another is spent.
   */
  reorders: PlanStore<ReorderPlan>
  /**
   * Installed cars and tracks, held for an hour. The new-championship screen
   * offers only what is in here, so this is what stops anyone having to know
   * that Brands Hatch is `ks_brands_hatch`.
   */
  content: ContentCache
  /**
   * Track layouts, held the same way — but read on a caller's session rather
   * than at boot, because the only page that lists them needs a login. See
   * `layouts.ts`.
   */
  layouts: ContentCache<TrackLayouts | null>
  throttle: LoginThrottle
  /** Injectable so a test can drive a session over a stub `fetch`. */
  createSession: (baseUrl: string) => AcsmSession
  /** Whether the session cookie carries `Secure`. See `sessions.ts`. */
  secureCookies: boolean
  sessionTtlMs: number
  /** Injectable so the schedule checks are deterministic under test. */
  now: () => Date
}

export interface ApiContextOptions extends Partial<ApiContext> {
  profile: LeagueProfile
  baseUrl: string
  reader: AcsmReader
}

export function apiContext(options: ApiContextOptions): ApiContext {
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_TTL_MS
  return {
    profile: options.profile,
    baseUrl: options.baseUrl,
    reader: options.reader,
    pits: options.pits ?? EMPTY_PIT_TABLE,
    sessions: options.sessions ?? new SessionStore({ ttlMs: sessionTtlMs }),
    // Labelled, because there are two of them and the message when one fills
    // up is otherwise "more than 2000" of something unspecified.
    plans: options.plans ?? new PlanStore({ label: "finalize plans" }),
    newChampionships:
      options.newChampionships ?? new PlanStore({ label: "unconfirmed new championships" }),
    reorders: options.reorders ?? new PlanStore({ label: "unconfirmed round reorders" }),
    content: options.content ?? new ContentCache({ load: () => options.reader.listContent() }),
    layouts: options.layouts ?? new ContentCache<TrackLayouts | null>(),
    throttle: options.throttle ?? new LoginThrottle(),
    createSession: options.createSession ?? ((baseUrl) => new AcsmSession({ baseUrl })),
    secureCookies: options.secureCookies ?? true,
    sessionTtlMs,
    now: options.now ?? (() => new Date()),
  }
}

const planBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    laps: { type: "integer", minimum: 1, maximum: MAX_LAPS },
    minutes: { type: "integer", minimum: 1, maximum: MAX_MINUTES },
    reversedGridPositions: { type: "integer", minimum: 0, maximum: MAX_REVERSED },
    mandatoryPit: { type: "boolean" },
    extraLap: { type: "boolean" },
    quali: {
      type: "object",
      additionalProperties: false,
      required: ["date", "time"],
      properties: {
        date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        time: { type: "string", pattern: "^\\d{2}:\\d{2}$" },
      },
    },
    /**
     * Where the round runs. Both fields together or neither.
     *
     * `layout` may be empty, unlike the one on the create screen: `""` is how
     * ACSM spells a track with a single layout, and a move to such a track has
     * to be able to say so. `track` is required alongside it because a layout
     * without a track is not a location — the pair is the unit that gets
     * validated against what the server has, and against each other.
     */
    venue: {
      type: "object",
      additionalProperties: false,
      required: ["track", "layout"],
      properties: {
        track: { type: "string", minLength: 1, maxLength: 200 },
        layout: { type: "string", maxLength: 200 },
      },
    },
  },
} as const

/**
 * What the lease holds between previewing a championship and creating it.
 *
 * The emitted championship rather than the request that produced it, for the
 * same reason a finalize plan holds the parsed form: re-deriving on import
 * would mean trusting the inputs twice and hoping the second pass agreed. The
 * gridmom report travels with it so the import decides on the findings the
 * person was actually shown.
 */
export interface HeldChampionship {
  sourceId: string
  result: EmitResult
  gridmom: CheckReport
}

/** One track from the browser as the emitter's round spec. */
function roundSpecFrom(t: TrackRequest): RoundSpec {
  return {
    track: t.track,
    ...(t.layout ? { layout: t.layout } : {}),
    // Trimmed to nothing is no name, not a name made of spaces — and a round
    // with no name is the normal case, so it must not become one that renders
    // as blank in the manager.
    ...(t.name?.trim() ? { name: t.name.trim() } : {}),
  }
}

const newChampionshipBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["sourceId"],
  properties: {
    sourceId: { type: "string", minLength: 1, maxLength: 200 },
    name: { type: "string", minLength: 1, maxLength: 200 },
    startDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    /**
     * The class car list, as folder names.
     *
     * Absent means "whatever the source ran", which is what a clone did before
     * this existed and is still the common case. Present replaces it outright
     * rather than adding to it — the same rule as `tracks`, and the one
     * somebody changing a championship's class expects.
     *
     * `minItems: 1` because an empty array is not "inherit", it is a class
     * with no cars, and `emitChampionship` refuses that with a message about
     * an empty car list. Better to refuse the request than to produce a
     * plausible-looking 422 about something the person did not ask for.
     */
    cars: {
      type: "array",
      minItems: 1,
      // A multi-make championship is a handful of models; the Legends one ran
      // ten. The bound is here for the same reason every other bound is.
      maxItems: 200,
      items: { type: "string", minLength: 1, maxLength: 200 },
    },
    /**
     * The championship blurb. Empty is a value, not an omission — someone who
     * cleared the box wants it cleared — so there is no `minLength` here and
     * the handler tests for `undefined` rather than for truthiness.
     */
    description: { type: "string", maxLength: 20_000 },
    tracks: {
      type: "array",
      minItems: 1,
      // A championship is a handful of race nights. The bound is here for the same
      // reason every other bound is: past it the value is a mistake or an
      // attack, and each entry costs a pit-table lookup and an event.
      maxItems: 52,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["track"],
        properties: {
          track: { type: "string", minLength: 1, maxLength: 200 },
          // Non-empty when present. `roundSpecFrom` reads "" as "no layout",
          // so an empty string would arrive as a track without one and hide
          // whatever produced it — omit the key instead.
          layout: { type: "string", minLength: 1, maxLength: 200 },
          // Empty *is* allowed, unlike layout: the screen sends whatever is in
          // the box, and clearing it means "no name, show the track". No
          // minLength, so that stays expressible.
          name: { type: "string", maxLength: 200 },
        },
      },
    },
  },
} as const

const createChampionshipBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: { acknowledgeWarnings: { type: "boolean" } },
} as const

/**
 * The new calendar, as 1-based source rounds.
 *
 * Bounded like every other array here, and `maxItems` matches the create
 * screen's track list because they are the same quantity — a championship is a
 * handful of race nights. `planReorder` still checks it really is a
 * rearrangement of the rounds that exist, which is the check that matters and
 * is not expressible in a schema: it needs to know how many rounds there are.
 */
const reorderBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["order"],
  properties: {
    order: {
      type: "array",
      minItems: 1,
      maxItems: 52,
      items: { type: "integer", minimum: 1, maximum: 52 },
    },
  },
} as const

const planIdParamsSchema = {
  type: "object",
  required: ["planId"],
  properties: { planId: { type: "string", minLength: 1, maxLength: 200 } },
} as const

const roundParamsSchema = {
  type: "object",
  required: ["id", "round"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 200 },
    round: { type: "integer", minimum: 1 },
  },
} as const

/**
 * The preview body.
 *
 * `PlanRequest` is the wire contract the client codes against; intersecting it
 * with `FormatOverrides` is what makes it type-check when passed straight to
 * `withOverrides`. If the two ever drift apart, this stops compiling — which is
 * the point of writing it this way rather than restating the fields.
 */
type PlanBody = PlanRequest & FormatOverrides

export function apiRoutes(ctx: ApiContext): FastifyPluginAsync {
  return async (app: FastifyInstance): Promise<void> => {
    app.addHook("onRequest", async (req) => {
      if (req.routeOptions.config?.public === true) return
      requireSession(ctx, req)
    })

    /**
     * An absent body means an empty one.
     *
     * Both POSTs here are meaningful with nothing attached: a plan for no
     * change is how the UI opens a round, and apply takes a plan id from the
     * URL. `fetch(url, { method: "POST" })` sends no `Content-Type`, so
     * Fastify never runs a parser, `req.body` stays undefined, and the schemas
     * — which reasonably say `type: "object"` — reject it before the handler
     * that already treats the body as optional ever runs. The caller gets
     * "body must be object" for a request that was perfectly clear.
     *
     * `preValidation` rather than the parser, because there is no parser to
     * reach: this is the case where Fastify decided there was nothing to
     * parse. A body that *is* present and malformed still fails, in the
     * content-type parser, and still reports itself as bad JSON.
     */
    app.addHook("preValidation", async (req) => {
      if (req.body === undefined || req.body === null) req.body = {}
    })

    /**
     * Nothing under /api is cacheable, by anyone.
     *
     * Every response here varies by the httpOnly session cookie and none of it
     * is shared: a championship list is read with *this* person's ACSM
     * credentials, and `/session` answers with their username. A URL is
     * identical between two people and a cookie is not part of a shared
     * cache's key, so a proxy is entitled to hand one person's
     * `{ authenticated: true, username }` to the next — and running behind a
     * reverse proxy is a supported deployment, so "entitled to" is a thing
     * that will happen.
     *
     * Applied to the whole plugin rather than to `/session`, because the same
     * argument covers every route under it and picking them off one at a time
     * means the next route added is the one that isn't.
     */
    app.addHook("onSend", async (_req, reply) => {
      reply.header("Cache-Control", "no-store")
      reply.header("Vary", "Cookie")
    })

    // -----------------------------------------------------------------------
    // Session
    // -----------------------------------------------------------------------

    /**
     * Which manager this is, so the login screen can name it.
     *
     * Public because a login screen is public, and because none of it is a
     * secret: the base URL is a manager whose read API is open by design, and
     * the schedule defaults are in the league profile that ships in the repo.
     */
    app.get(
      "/config",
      { config: { public: true } },
      async (): Promise<ConfigResponse> => ({
        league: { id: ctx.profile.id, name: ctx.profile.name },
        baseUrl: ctx.baseUrl,
        timezone: ctx.profile.schedule.timezone,
        qualiStart: ctx.profile.schedule.qualiStart,
        practiceMinutes: ctx.profile.schedule.practiceMinutes,
        // The league's shorthands — "1x40", "2x20" — as one-tap starting points.
        // They come from the profile rather than from the client so that another
        // league's names and numbers are a config change, not a fork.
        formats: ctx.profile.formats ?? [],
      }),
    )

    /**
     * Public, and answers 200 either way.
     *
     * "Nobody is logged in yet" is the ordinary state of a cold page load, not
     * a failure, and reporting it as 401 makes every first visit look like an
     * error in the console and in whatever is watching the logs.
     */
    app.get("/session", { config: { public: true } }, async (req): Promise<SessionResponse> => {
      const info = ctx.sessions.info(req.cookies[SESSION_COOKIE])
      if (!info) return { authenticated: false }
      return { authenticated: true, username: info.username, expiresAt: info.expiresAt }
    })

    app.post<{ Body: { username: string; password: string } }>(
      "/login",
      {
        config: { public: true },
        schema: {
          body: {
            type: "object",
            required: ["username", "password"],
            additionalProperties: false,
            properties: {
              username: { type: "string", minLength: 1, maxLength: 200 },
              // No minimum. A short password is ACSM's business to reject, and
              // a length rule here would only teach an attacker where the
              // boundary is without stopping anything.
              password: { type: "string", maxLength: 1000 },
            },
          },
        },
      },
      async (req, reply): Promise<LoginResponse> => {
        const wait = ctx.throttle.retryAfterMs(req.ip)
        if (wait > 0) {
          reply.header("retry-after", String(Math.ceil(wait / 1000)))
          throw new ApiError(
            429,
            "throttled",
            `Too many failed logins from this address. champctl forwards these to ${ctx.baseUrl}, ` +
              `so it stops asking on your behalf for ${Math.ceil(wait / 60_000)} more minutes. ` +
              `If this is you, that is how long until the next attempt.`,
          )
        }

        const acsm = ctx.createSession(ctx.baseUrl)
        try {
          await acsm.login({ username: req.body.username, password: req.body.password })
        } catch (e) {
          // Only a rejected credential counts against the allowance.
          //
          // Counting every exception meant an ACSM outage spent the allowance
          // for the address: a handful of timeouts or 502s and the person was
          // locked out for another fifteen minutes *after* the service came
          // back, having never typed a wrong password. The throttle exists to
          // stop champctl forwarding guesses at someone else's manager, and a
          // manager that is down is not being guessed at.
          if (isRejectedCredential(e)) ctx.throttle.fail(req.ip)
          throw e
        }
        ctx.throttle.succeed(req.ip)

        const id = ctx.sessions.create(req.body.username, acsm)
        setSessionCookie(ctx, reply, id)
        const info = ctx.sessions.info(id)
        return { username: req.body.username, expiresAt: info?.expiresAt ?? 0 }
      },
    )

    /**
     * Public so that logging out of a session that has already expired is not
     * itself a 401 — the browser still has a cookie to be rid of, and the one
     * thing it must not do is leave it there.
     */
    app.post("/logout", { config: { public: true } }, async (req, reply) => {
      const id = req.cookies[SESSION_COOKIE]
      if (id) {
        // Plans before the session: dropping the session first would leave
        // every plan it owns unreachable but still resident, holding a parsed
        // entry list until the TTL swept it.
        //
        // All three stores, not just the finalize one. A reorder plan holds a
        // parsed event form per round it moves, which is the league's driver
        // names and Steam GUIDs several times over — exactly the thing this
        // line exists to stop outliving the session that read it.
        dropPlansFor(ctx, id)
        ctx.sessions.destroy(id)
      }
      clearSessionCookie(ctx, reply)
      return reply.code(204).send()
    })

    // -----------------------------------------------------------------------
    // Reads
    // -----------------------------------------------------------------------

    app.get(
      "/championships",
      async (): Promise<ChampionshipListResponse> => ({
        championships: championshipList(await ctx.reader.listChampionships()),
      }),
    )

    /**
     * What is installed on the server, so the screen can offer it rather than
     * ask someone to type `ks_brands_hatch` from memory.
     *
     * Behind a session like every other read, even though ACSM serves both
     * listings without credentials. Not for secrecy — it is a list of folder
     * names — but because it is champctl's most expensive read, and an
     * unauthenticated endpoint that walks five pages of a league's manager is
     * something a stranger could point at that manager on a loop.
     */
    /**
     * The layout index, on this caller's session, and never fatal.
     *
     * On the caller's session because the form that lists layouts is the one
     * page ACSM will not serve without a login, and champctl holds no
     * credentials of its own. Held for an hour afterwards, so it is one read
     * per manager rather than one per screen.
     *
     * Nothing here is worth failing a request over: the create screen falls
     * back to a free-text layout field, and gridmom skips its layout checks.
     * Both degrade to what champctl did before it could read layouts at all.
     *
     * Logged, though, and that is not decoration. Swallowed silently this reads
     * as a manager whose tracks each have one layout — a wrong answer shaped
     * exactly like a right one, and the log is the only place the difference
     * shows.
     */
    const layoutsFor = async (
      s: { acsm: AcsmSession },
      req: FastifyRequest,
    ): Promise<TrackLayouts | null> =>
      ctx.layouts
        .get(() => readTrackLayouts(s.acsm, ctx.reader))
        .catch((err: unknown) => {
          req.log.warn({ err }, "could not read track layouts")
          return null
        })

    app.get("/content", async (req): Promise<ContentResponse> => {
      const s = requireSession(ctx, req)
      const [content, layouts] = await Promise.all([ctx.content.get(), layoutsFor(s, req)])
      return { ...content, layouts }
    })

    app.get<{ Params: { id: string } }>(
      "/championships/:id",
      {
        schema: {
          params: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string", minLength: 1, maxLength: 200 } },
          },
        },
      },
      async (req): Promise<ChampionshipResponse> => {
        const s = requireSession(ctx, req)
        const [c, layouts] = await Promise.all([
          ctx.reader.exportChampionship(req.params.id),
          // Costs a page fetch the first time and nothing for the hour after.
          // Worth it here of all places: this is the screen that shows a round
          // with no layout set, and the screen where it gets fixed.
          layoutsFor(s, req),
        ])
        return {
          championship: championshipView(c, ctx.profile),
          // The championship as it stands, before anyone edits anything. Plan
          // §1's third job — "checking a championship for mistakes before
          // people show up to race" — is most of this tool's value and costs
          // one pure function call over an export already in hand.
          gridmom: check(c, ctx.profile, { pits: ctx.pits, now: ctx.now(), layouts }),
        }
      },
    )

    // -----------------------------------------------------------------------
    // Preview and push
    // -----------------------------------------------------------------------

    app.post<{ Params: { id: string; round: number }; Body: PlanBody }>(
      "/championships/:id/rounds/:round/plan",
      { schema: { params: roundParamsSchema, body: planBodySchema } },
      async (req): Promise<PlanResponse> => {
        const s = requireSession(ctx, req)
        const { id, round } = req.params
        const body = req.body ?? {}

        if (body.laps !== undefined && body.minutes !== undefined) {
          throw new ApiError(
            400,
            "length-ambiguous",
            "Laps and minutes are two ways to say the same thing; pick one. A race is measured " +
              "in laps or in minutes, and setting both leaves the export ambiguous.",
          )
        }

        const championship = await ctx.reader.exportChampionship(id)
        const list = events(championship)
        const ev = list[round - 1]
        if (!ev?.ID) {
          throw new ApiError(
            404,
            "no-such-round",
            `Championship ${id} has no round ${round} — it has ${list.length}.`,
          )
        }

        const plan = await planFinalize(s.acsm, {
          championship,
          championshipId: id,
          eventId: ev.ID,
          format: withOverrides(readFormat(ev), body),
          ...(body.quali ? { qualiStart: body.quali } : {}),
          ...(body.venue ? { venue: body.venue } : {}),
          profile: ctx.profile,
          pits: ctx.pits,
          now: ctx.now(),
        })

        return {
          plan: planView(ctx.plans.create(s.id, plan), plan),
          // What the round looks like right now, so the screen can show the
          // "before" side without a second request — and so a round that has
          // since been run says so before anyone pushes to it.
          round: roundView(ev, round, ctx.profile),
        }
      },
    )

    // -----------------------------------------------------------------------
    // Reordering the rounds of a championship that already exists
    // -----------------------------------------------------------------------

    /**
     * What the calendar would look like in a different order, written nowhere.
     *
     * The same `planReorder` a reorder push spends, so the review and the write
     * cannot disagree about which rounds move. Held server-side like a finalize
     * plan and for the sharper version of the same reason: a reorder is several
     * event-form writes, each one a full-list replace, so each one carries its
     * own entry-list fingerprint taken while the person was still reading.
     */
    app.post<{ Params: { id: string }; Body: ReorderRequest }>(
      "/championships/:id/reorder/plan",
      {
        schema: {
          params: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string", minLength: 1, maxLength: 200 } },
          },
          body: reorderBodySchema,
        },
      },
      async (req): Promise<ReorderPlanResponse> => {
        const s = requireSession(ctx, req)
        const { id } = req.params

        const championship = await ctx.reader.exportChampionship(id)

        // The engine's refusals — an order that isn't a rearrangement, a round
        // that has been raced — reach the browser as a 422 through
        // `describeError`, which is where `ReorderError` is mapped. Not caught
        // and rewrapped here: the emitter needs that because `EmitError` has no
        // branch there, and doing it for a class that does would be two places
        // deciding one status.
        const plan = await planReorder(s.acsm, {
          championship,
          championshipId: id,
          order: req.body.order,
          profile: ctx.profile,
          pits: ctx.pits,
          now: ctx.now(),
        })

        return {
          plan: reorderPlanView(ctx.reorders.create(s.id, plan), plan, championship, ctx.profile),
        }
      },
    )

    /**
     * Applies the reorder that was previewed, and only that one.
     *
     * Takes a plan id and nothing else. That matters more here than anywhere
     * else in this file: the plan is the only thing holding the entry-list
     * fingerprints for *every* round about to be written, and re-planning at
     * push time would take each of them one round trip before comparing it —
     * a guard comparing a form against itself.
     */
    app.post<{ Params: { planId: string }; Body: { acknowledgeWarnings?: boolean } }>(
      "/reorders/:planId/apply",
      { schema: { params: planIdParamsSchema, body: createChampionshipBodySchema } },
      async (req): Promise<ReorderResponse> => {
        const s = requireSession(ctx, req)
        const { planId } = req.params

        const taken = ctx.reorders.acquire(planId, s.id)
        if (taken.kind === "not-found") {
          throw new ApiError(
            404,
            "no-such-plan",
            "That preview has expired, or it was already applied. Nothing was written. Open the " +
              "championship again — the fresh preview will show the order it is in now.",
          )
        }
        if (taken.kind === "in-flight") {
          throw new ApiError(
            409,
            "plan-in-flight",
            "This reorder is already being applied. Nothing extra was written. Wait for it to " +
              "finish rather than sending it again — a second run would move the rounds twice.",
          )
        }
        const plan = taken.plan

        try {
          const result = await applyReorder(s.acsm, plan, {
            acknowledgeWarnings: req.body?.acknowledgeWarnings === true,
          })
          ctx.reorders.destroy(planId, s.id)
          return { rounds: result.rounds }
        } catch (e) {
          // Terminal for *this* plan, and for different reasons. A changed
          // entry list means the plan's fingerprints describe a championship
          // that has moved on. A partial reorder means some rounds are already
          // at their new tracks, so spending this plan again would move them a
          // second time — which is exactly what its message tells the person
          // not to do, and the store should not be the thing that allows it.
          //
          // Everything else keeps the plan, so ticking the acknowledgement box
          // and pressing again is the normal path it looks like.
          if (e instanceof EntryListChangedError || e instanceof PartialReorderError) {
            ctx.reorders.destroy(planId, s.id)
          } else {
            ctx.reorders.release(planId, s.id)
          }
          throw e
        }
      },
    )

    // -----------------------------------------------------------------------
    // Creating a championship (plan §5.1)
    // -----------------------------------------------------------------------

    /**
     * A past championship, rebuilt as a new one, and written nowhere.
     *
     * The same `cloneChampionship` and the same `check` the CLI runs — one built
     * by the browser and one built by `champctl-championship clone` are the same
     * championship or one of them is wrong.
     *
     * The source is both template and spec: `specFromChampionship` reads the
     * cars, the class, the format and the slots off it, and `overrides` is a
     * shallow layer on top. `tracks` therefore *replaces* the round list
     * rather than merging into it, which is what someone editing a track list
     * means and what the CLI already does.
     */
    app.post<{ Body: NewChampionshipRequest }>(
      "/championships/plan",
      { schema: { body: newChampionshipBodySchema } },
      async (req): Promise<NewChampionshipPlanResponse> => {
        const s = requireSession(ctx, req)
        const body = req.body

        const source = await ctx.reader.exportChampionship(body.sourceId)

        // One instant for the emit and the check both. Two calls to `now()`
        // can land either side of midnight or a DST change, and then the
        // schedule gridmom is checking is not quite the schedule that was
        // generated — a disagreement that reproduces roughly never.
        const now = ctx.now()

        const overrides: Partial<ChampionshipSpec> = {
          ...(body.name ? { name: body.name } : {}),
          ...(body.startDate ? { startDate: body.startDate } : {}),
          ...(body.cars?.length ? { cars: body.cars } : {}),
          ...(body.description === undefined ? {} : { description: body.description }),
          ...(body.tracks ? { rounds: body.tracks.map(roundSpecFrom) } : {}),
        }

        let result: EmitResult
        try {
          result = cloneChampionship({
            source,
            profile: ctx.profile,
            overrides,
            pits: ctx.pits,
            now,
          })
        } catch (e) {
          // The emitter's refusals are written for a person and are about the
          // request rather than about champctl — an empty car list, a
          // championship with no name to inherit. 422 for the same reason a gridmom block
          // is: understood, and declined.
          if (e instanceof EmitError) throw new ApiError(422, "emit", e.message)
          throw e
        }

        const gridmom = check(result.championship, ctx.profile, {
          pits: ctx.pits,
          now,
          layouts: await layoutsFor(s, req),
        })

        return {
          plan: newChampionshipPlanView(
            ctx.newChampionships.create(s.id, { sourceId: body.sourceId, result, gridmom }),
            body.sourceId,
            result,
            gridmom,
            ctx.profile,
          ),
        }
      },
    )

    /**
     * Imports the championship that was previewed, and only that one.
     *
     * Takes a plan id and nothing else, so what lands is what was on screen —
     * the same contract as `/plans/:planId/apply`, and here it matters more:
     * a championship that imports twice leaves a league two of them to tell
     * apart and delete by hand.
     */
    app.post<{ Params: { planId: string }; Body: { acknowledgeWarnings?: boolean } }>(
      "/championships/:planId/create",
      { schema: { params: planIdParamsSchema, body: createChampionshipBodySchema } },
      async (req): Promise<NewChampionshipResponse> => {
        const s = requireSession(ctx, req)
        const { planId } = req.params

        const taken = ctx.newChampionships.acquire(planId, s.id)
        if (taken.kind === "not-found") {
          throw new ApiError(
            404,
            "no-such-plan",
            "That preview has expired, or the championship was already created. Nothing was written. " +
              "Build it again — the fresh preview will show what it looks like now.",
          )
        }
        if (taken.kind === "in-flight") {
          throw new ApiError(
            409,
            "plan-in-flight",
            "This championship is already being created. Nothing extra was written. Wait for it to " +
              "finish rather than sending it again.",
          )
        }
        const held = taken.plan

        try {
          if (held.gridmom.counts.ERROR > 0) {
            throw new ApiError(
              422,
              "gridmom-blocked",
              "gridmom found an error in this championship, so it was not created. An error means a " +
                "broken or unfair season rather than a matter of taste — fix the cause and " +
                "build it again.",
            )
          }
          if (held.gridmom.counts.WARN > 0 && req.body?.acknowledgeWarnings !== true) {
            throw new ApiError(
              422,
              "unacknowledged-warnings",
              "gridmom has warnings about this championship. Read them and confirm, or change what " +
                "they are about. Nothing was written.",
            )
          }

          /**
           * The import changes two things about the payload, and neither is
           * part of what was reviewed.
           *
           * `freshIds` regenerates every UUID. The emitter already did that
           * once, so this is belt and braces — kept on rather than turned off
           * because the failure it prevents is two championships sharing an
           * ID, and the cost of preventing it twice is nothing. No id crosses
           * to the browser, so nothing on the review screen moves.
           *
           * `stampCreated` re-stamps `Created`/`Updated` at import. That is
           * the behaviour §5.5 asks for: a championship should carry the
           * moment it was made, not the moment its preview was built — and
           * those are different moments, since a preview can sit on screen for
           * as long as someone reads it. `now` is passed only so the stamp
           * comes from the same injectable clock the rest of the request uses;
           * it does not touch the schedule, which was generated during the
           * preview and is imported exactly as it was reviewed.
           *
           * `championshipId` is not optional: `importChampionship` throws an
           * `AcsmWriteError` when ACSM does not redirect to the new
           * championship, rather than returning without one.
           */
          const { championshipId } = await importChampionship(s.acsm, held.result.championship, {
            now: ctx.now(),
          })

          // Spent only once it is confirmed created. An import that failed is
          // one worth retrying with the same championship; an import that worked must
          // never run twice.
          ctx.newChampionships.destroy(planId, s.id)
          return {
            championshipId,
            name: held.result.championship.Name ?? "",
            rounds: events(held.result.championship).length,
          }
        } catch (e) {
          // Kept, not spent: every refusal above is one the person can act on
          // — tick the acknowledgement, or fix what gridmom is complaining
          // about and build again. Wedging it would make them redo a
          // preview they are looking at.
          ctx.newChampionships.release(planId, s.id)
          throw e
        }
      },
    )

    app.post<{ Params: { planId: string }; Body: { acknowledgeWarnings?: boolean } }>(
      "/plans/:planId/apply",
      {
        schema: {
          params: {
            type: "object",
            required: ["planId"],
            properties: { planId: { type: "string", minLength: 1, maxLength: 200 } },
          },
          body: {
            type: "object",
            additionalProperties: false,
            properties: { acknowledgeWarnings: { type: "boolean" } },
          },
        },
      },
      async (req): Promise<ApplyResponse> => {
        const s = requireSession(ctx, req)
        const { planId } = req.params

        // Acquired, not merely read. Two /apply requests for the same plan
        // could both pass a plain lookup before either wrote anything, and both
        // would then POST the same event form — two full-form replaces racing
        // over one entry list, from a double-click or a retried request. The
        // plan was only destroyed after the write, which is too late to stop
        // the second one starting.
        const taken = ctx.plans.acquire(planId, s.id)
        if (taken.kind === "not-found") {
          throw new ApiError(
            404,
            "no-such-plan",
            "That preview has expired, or it was already pushed. Nothing was written. Open the " +
              "round again and redo the change — the fresh preview will show what it looks like now.",
          )
        }
        if (taken.kind === "in-flight") {
          throw new ApiError(
            409,
            "plan-in-flight",
            "This change is already being pushed. Nothing extra was written. Wait for it to " +
              "finish rather than pushing again — the round will show the result.",
          )
        }
        const plan = taken.plan

        try {
          const result = await applyFinalize(s.acsm, plan, {
            acknowledgeWarnings: req.body?.acknowledgeWarnings === true,
          })
          ctx.plans.destroy(planId, s.id)
          return {
            eventSaved: result.eventSaved,
            scheduleSaved: result.scheduleSaved,
            changes: plan.changes,
          }
        } catch (e) {
          // A plan that can never succeed is dropped, so the obvious retry gets
          // "take a fresh look" rather than the same refusal a second time.
          // Both of these are terminal for *this* plan: the entry list has
          // moved on, or half the write already landed and re-applying would
          // re-post a format that is already applied.
          //
          // Everything else keeps the plan. A refusal for unacknowledged
          // warnings is the normal path to ticking the box and pushing again,
          // and making the person rebuild the preview to do that would be a
          // reason to stop reading the warnings.
          if (e instanceof EntryListChangedError || e instanceof PartialWriteError) {
            ctx.plans.destroy(planId, s.id)
          } else {
            // Released rather than left in flight: this plan is still
            // applicable, and a refusal that permanently wedged it would be
            // worse than the race it came from.
            ctx.plans.release(planId, s.id)
          }
          throw e
        }
      },
    )
  }
}

/**
 * Ends every lease a session holds, across all three stores.
 *
 * One function rather than three calls at each of the two sites that need it,
 * because the failure mode is a store somebody forgot: the plan stays resident
 * with a parsed entry list in it, unreachable and unswept until its TTL. That
 * has already happened once — `newChampionships` was added and this was not
 * updated.
 */
export function dropPlansFor(ctx: ApiContext, sessionId: string): void {
  ctx.plans.dropForSession(sessionId)
  ctx.newChampionships.dropForSession(sessionId)
  ctx.reorders.dropForSession(sessionId)
}

/**
 * The session behind this request, or a 401 that says which kind of nothing it
 * was.
 *
 * "You were never logged in" and "you were, an hour ago" want different words
 * on screen and the same status code, so the distinction is in `code` rather
 * than in the status. An expired cookie is also cleared on the way out: leaving
 * it means the browser keeps presenting a handle to a jar that no longer
 * exists, and every subsequent 401 looks like a bug rather than a timeout.
 */
function requireSession(ctx: ApiContext, req: FastifyRequest): StoredSession {
  const id = req.cookies[SESSION_COOKIE]
  const found = ctx.sessions.get(id)
  if (found) return found

  throw new ApiError(
    401,
    id ? "session-expired" : "not-authenticated",
    id
      ? "Your champctl session has expired. Log in again — nothing was lost, and the round is " +
          "still where you left it."
      : "Log in to champctl with your ACSM username and password.",
  )
}

function setSessionCookie(ctx: ApiContext, reply: FastifyReply, id: string): void {
  reply.header(
    "set-cookie",
    `${SESSION_COOKIE}=${id}; ${sessionCookieAttributes(ctx.sessionTtlMs, {
      secure: ctx.secureCookies,
    })}`,
  )
}

export function clearSessionCookie(ctx: ApiContext, reply: FastifyReply): void {
  // Max-Age=0 rather than an expiry in the past: same effect, and it can't be
  // wrong about the client's clock.
  reply.header(
    "set-cookie",
    `${SESSION_COOKIE}=; ${sessionCookieAttributes(0, { secure: ctx.secureCookies })}`,
  )
}

/**
 * Whether a login failure was ACSM saying "wrong credentials".
 *
 * ACSM answers a bad password with 200 and the login form again, which is why
 * `AcsmAuthError` carries the status at all. A 5xx is the manager failing, a
 * 429 is its own rate limiter, and anything that isn't an `AcsmAuthError` never
 * got an answer — a timeout, a refused connection, DNS. None of those is an
 * attempt worth counting.
 */
function isRejectedCredential(e: unknown): boolean {
  if (!(e instanceof AcsmAuthError)) return false
  // Undefined status means login() decided the response was a rejection
  // without a status to point at, which is still a rejection.
  if (e.status === undefined) return true
  return e.status === 200 || e.status === 401 || e.status === 403
}
