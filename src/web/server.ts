/**
 * The champctl web service: an HTTP face on the finalize engine (plan §5.2).
 *
 * `buildServer` returns a Fastify instance without listening, so tests drive it
 * through `app.inject()` and the CLI is the only thing that opens a socket.
 * Every collaborator it needs — the reader, the session factory, the clock — is
 * an option with a real default, which is what lets a test exercise the actual
 * login, the actual cookie jar and the actual write path over a stub `fetch`
 * rather than a mock of champctl's own code.
 *
 * ## What this service is trusted with
 *
 * It forwards a league admin's ACSM username and password, and holds the
 * resulting cookie for an hour. Three consequences, all enforced here:
 *
 * - **HTTPS is the deployment assumption** (plan §3.3), so the session cookie
 *   carries `Secure` unless someone explicitly turns it off, and turning it off
 *   logs a warning naming what it costs.
 * - **A cross-site POST must not be able to ride the session.** `SameSite=Lax`
 *   is the actual guard and it is on the cookie; the `Origin` check below is
 *   the second lock, cheap and worth having on something holding admin rights.
 * - **Nothing about a failure reaches the browser unless champctl wrote the
 *   sentence.** See `errors.ts`.
 */

import { existsSync } from "node:fs"

import cookie from "@fastify/cookie"
import staticFiles from "@fastify/static"
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify"

import { AcsmAuthError } from "../acsm/session.js"
import { describeError } from "./errors.js"
import { apiContext, apiRoutes, clearSessionCookie, type ApiContextOptions } from "./routes.js"
import { SESSION_COOKIE } from "./sessions.js"

export interface ServerOptions extends ApiContextOptions {
  /**
   * Directory holding the built client. Omit to run the API alone, which is
   * what the tests do and what a deployment serving the assets from a CDN or a
   * reverse proxy would do.
   */
  clientRoot?: string
  /** Passed through to Fastify. `false` in tests, so output stays readable. */
  logger?: FastifyServerOptions["logger"]
  /**
   * Trust `X-Forwarded-For` for `request.ip`.
   *
   * Off by default, and that default is a security decision rather than
   * laziness: `request.ip` is the key the login throttle counts against. With
   * this on and nothing trustworthy in front, a client sets its own key and
   * gets a fresh allowance per attempt. With it off behind a proxy, every login
   * in the world shares one bucket and the first five failures lock out the
   * league. Neither is safe by accident — set it to match the deployment.
   */
  trustProxy?: FastifyServerOptions["trustProxy"]
}

export function buildServer(options: ServerOptions): FastifyInstance {
  const ctx = apiContext(options)

  const app = Fastify({
    logger: options.logger ?? false,
    ...(options.trustProxy !== undefined ? { trustProxy: options.trustProxy } : {}),
    // ACSM ids are UUIDs and every body here is small. A low cap means a
    // request that is not champctl's is refused before it is parsed.
    bodyLimit: 64 * 1024,
    ajv: {
      customOptions: {
        /**
         * Reject an unknown field rather than deleting it.
         *
         * Fastify's default is `removeAdditional: true`, which strips anything
         * `additionalProperties: false` didn't allow and carries on. That is
         * the wrong direction for these endpoints. A client that posts a lap
         * count to `/apply` has misunderstood what apply does — it spends a
         * plan and takes no format at all — and quietly dropping the field
         * leaves it believing the opposite, with a successful-looking push
         * that ignored what it asked for. Refusing costs a diagnosis; guessing
         * costs an argument about what actually got sent.
         */
        removeAdditional: false,
      },
    },
  })

  if (!ctx.secureCookies) {
    app.log.warn(
      "Session cookies are being sent without Secure, so this server's session — which stands in " +
        "for an ACSM admin login — will travel in the clear over plain HTTP. Development only.",
    )
  }

  /**
   * An empty body with `Content-Type: application/json` means `{}`.
   *
   * Fastify's default parser answers FST_ERR_CTP_EMPTY_JSON_BODY, a 500, for a
   * POST that declares JSON and sends nothing. `/logout` takes no body, so
   * every logout failed *before the route ran* — and the client had already
   * dropped its cookie and shown the login screen, so the person saw a clean
   * sign-out and a reload signed them straight back in.
   *
   * Fixed here as well as in the client, which no longer sets the header on a
   * bodyless request. Two places for one bug because they are two bugs: the
   * client was describing a body it didn't send, and the server was refusing a
   * request that is perfectly meaningful. Any other caller — curl, a script —
   * would still have hit the second.
   */
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body: string | Buffer, done) => {
      const text = body.toString().trim()
      if (text === "") {
        done(null, {})
        return
      }
      try {
        done(null, JSON.parse(text))
      } catch (e) {
        const err = e as Error & { statusCode?: number }
        err.statusCode = 400
        done(err, undefined)
      }
    },
  )

  app.register(cookie)

  /**
   * Refuse a state-changing request whose `Origin` isn't ours.
   *
   * The cookie's `SameSite=Lax` already means a cross-site POST arrives without
   * a session and gets a 401, so this is the second lock rather than the first.
   * It is here because the thing behind the lock is a league's admin panel, and
   * because `Lax` is a browser behaviour rather than something this server can
   * observe.
   *
   * A *missing* `Origin` is allowed. Every browser sends it on a POST, so an
   * absent one is a non-browser client — curl, a test, a script — which had to
   * come by the session cookie some other way to get this far. Refusing it
   * would break those without closing anything a browser could exploit.
   */
  app.addHook("onRequest", async (req, reply) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return
    const origin = req.headers.origin
    if (!origin) return

    const host = req.headers.host ?? ""
    if (origin === `https://${host}` || origin === `http://${host}`) return

    await reply.code(403).send({
      error: {
        code: "cross-origin",
        message:
          `This request came from ${origin}, which isn't this server. champctl refuses ` +
          `cross-site writes because a session here is an ACSM admin login.`,
      },
    })
  })

  app.register(apiRoutes(ctx), { prefix: "/api" })

  /**
   * For a load balancer. Deliberately says nothing about ACSM: a health check
   * that reaches out to the league's manager turns every probe into traffic
   * against a rate-limited service, and turns "ACSM is down" into "champctl is
   * down and should be restarted", which helps nobody.
   */
  app.get("/healthz", async () => ({ ok: true }))

  // Annotated because Fastify 5 types the handler's first parameter as
  // `unknown` — correctly, since anything can be thrown. `describeError` takes
  // `unknown` and narrows; the annotation is only so `error.validation` can be
  // read here without a cast.
  app.setErrorHandler(async (error: FastifyError, req, reply) => {
    // Fastify's own schema rejection. Its messages are already specific about
    // which field and why ("body/laps must be <= 2000"), so the useful thing is
    // to pass one through with a sentence around it rather than replace it with
    // something vaguer.
    if (error.validation) {
      return reply.code(400).send({
        error: {
          code: "bad-request",
          message: `champctl couldn't read that request: ${error.message}.`,
        },
      })
    }

    const described = describeError(error)

    // ACSM rejected the cookie jar this session holds, so the champctl session
    // standing in for it is worthless from here on. Ending it means the next
    // request says "log in again" instead of failing the same way somewhere
    // deeper, and it doesn't leave a dead jar sitting in memory for an hour.
    const id = req.cookies[SESSION_COOKIE]
    if (id && error instanceof AcsmAuthError) {
      ctx.plans.dropForSession(id)
      ctx.sessions.destroy(id)
    }

    // Any 401 from a request that presented a cookie means that cookie is no
    // good — expired, swept, or belonging to a session ACSM has disowned.
    // Written as a property of the response rather than as a branch per cause,
    // so a new way of being unauthenticated doesn't have to remember to do
    // this. Leaving it set means the browser keeps presenting a handle to a jar
    // that isn't there, and every later 401 looks like a bug rather than a
    // timeout.
    if (id && described.status === 401) clearSessionCookie(ctx, reply)

    if (described.unexpected) req.log.error({ err: error }, "unhandled error")
    return reply.code(described.status).send(described.body)
  })

  registerClient(app, options.clientRoot)
  return app
}

/**
 * Serves the built client, with everything that isn't an API route falling
 * through to `index.html`.
 *
 * The fallback is what makes a deep link work: the finalize screen has its own
 * URL, and a reload of it is a request for a path no file matches. An API path
 * must never fall through — a mistyped endpoint answering 200 with a page of
 * HTML is a bug that reads as a client parse error somewhere far away.
 */
function registerClient(app: FastifyInstance, clientRoot: string | undefined): void {
  const notFound = {
    error: {
      code: "not-found",
      message: "No such endpoint.",
    },
  }

  if (!clientRoot || !existsSync(clientRoot)) {
    if (clientRoot) {
      app.log.warn(
        `No built client at ${clientRoot}, so champctl is serving the API only. ` +
          `\`npm run build\` produces it.`,
      )
    }
    app.setNotFoundHandler(async (_req, reply) => reply.code(404).send(notFound))
    return
  }

  app.register(staticFiles, { root: clientRoot })
  app.setNotFoundHandler(async (req, reply) => {
    if (req.method !== "GET" || req.url.startsWith("/api/")) {
      return reply.code(404).send(notFound)
    }
    return reply.sendFile("index.html")
  })
}
