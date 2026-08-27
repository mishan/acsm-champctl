#!/usr/bin/env node
/**
 * champctl-serve — the web UI's process (plan §5.2, phase 3).
 *
 * Everything dangerous is behind a login the *user* performs; this process
 * holds no ACSM credentials of its own and never reads
 * `CHAMPCTL_USERNAME`/`CHAMPCTL_PASSWORD`. That is deliberate and worth stating
 * out loud, because the other write CLI does read them: a long-running service
 * with an admin password in its environment is one exposed endpoint away from
 * being an admin password anyone can spend, and "the user's own credentials,
 * per session, never stored" is the whole security model of the web UI
 * (plan §2).
 *
 * Two defaults here are refusals rather than preferences, and both can be
 * overridden by someone who has thought about it:
 *
 * - **Binds to localhost.** A service that forwards admin credentials should
 *   not appear on every interface because someone ran it to have a look.
 * - **Session cookies carry `Secure`.** Which means the login will not work
 *   over plain `http://` until `--insecure-cookies` says so, in as many words.
 */

import { existsSync } from "node:fs"
import { resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { HttpAcsmReader } from "../acsm/client.js"
import { SqliteCache } from "../acsm/cache.js"
import { loadProfile } from "../profile/load.js"
import { ContentCache } from "../web/content-cache.js"
import { contentStore } from "../web/content-store.js"
import { buildServer } from "../web/server.js"
import { loadPits, runCli, UsageError } from "./args.js"

export { UsageError }

const USAGE = `champctl-serve — the champctl web UI

Usage:
  champctl-serve [options]

Options:
  --port <n>            port to listen on (default: 3000, or $PORT)
  --host <addr>         address to bind (default: 127.0.0.1)
  --profile <id|path>   league profile (default: batl)
  --pits <path>         track pit table (default: data/track-pits.json)
  --base-url <url>      override the profile's ACSM base URL
  --client <dir>        built client to serve (default: dist/client)
  --no-cache            bypass the on-disk response cache
  --trust-proxy         read X-Forwarded-For for the client address. Set this
                        only behind a proxy you control: it is the key the
                        failed-login throttle counts against.
  --insecure-cookies    send the session cookie without Secure, so a browser
                        will keep it over plain HTTP. Development only — the
                        session stands in for an ACSM admin login.
  --unthrottled-reads   drop the polite delay champctl puts between its reads.
                        Only against a manager you can throw away: the delay
                        exists so champctl is a good citizen on a league's
                        production Server Manager.
  -h, --help            this

champctl-serve holds no ACSM credentials. Each person logs in through the UI
with their own, the cookie jar stays server-side for an hour, and nothing is
written to disk.

Exit codes:
  0  shut down cleanly
  3  a usage mistake, or the server couldn't start
`

interface Args {
  port: number
  host: string
  profile: string
  pits?: string
  baseUrl?: string
  client?: string
  cache: boolean
  trustProxy: boolean
  insecureCookies: boolean
  unthrottledReads: boolean
  help: boolean
}

export function parseArgs(argv: readonly string[]): Args {
  // `port` is filled in after the loop, from $PORT, and only if nothing asked
  // for `--help`. Reading the environment up here made `PORT=nonsense
  // champctl-serve --help` exit non-zero with a complaint about the
  // environment instead of printing the help that would explain it — the one
  // command that has to work when everything else is misconfigured.
  let explicitPort: number | undefined

  const args: Args = {
    port: DEFAULT_PORT,
    host: "127.0.0.1",
    profile: "batl",
    cache: true,
    trustProxy: false,
    insecureCookies: false,
    unthrottledReads: false,
    help: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    /**
     * The next argument, refusing one that looks like another option.
     *
     * `champctl-serve --host --port 3000` would otherwise set the host to
     * "--port" and then fail on "3000" with "Unknown option 3000" — a message
     * about the wrong argument entirely, for a mistake made two arguments
     * earlier. The other CLIs already refuse this; serve was the one that
     * didn't.
     *
     * A leading "-" followed by a digit is a negative number rather than a
     * flag, and is allowed through so it reaches the check that has something
     * useful to say about it.
     */
    const next = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new UsageError(`${a} needs a value`)
      if (v.startsWith("-") && !/^-\d/.test(v)) {
        throw new UsageError(
          `${a} needs a value, but the next argument is ${JSON.stringify(v)}, which looks like ` +
            `another option. If that is genuinely the value, there is no way to say so yet.`,
        )
      }
      return v
    }
    switch (a) {
      case "-h":
      case "--help":
        args.help = true
        break
      case "--port":
        explicitPort = port(next(), a)
        break
      case "--host":
        args.host = next()
        break
      case "--profile":
        args.profile = next()
        break
      case "--pits":
        args.pits = next()
        break
      case "--base-url":
        args.baseUrl = next()
        break
      case "--client":
        args.client = next()
        break
      case "--no-cache":
        args.cache = false
        break
      case "--trust-proxy":
        args.trustProxy = true
        break
      case "--unthrottled-reads":
        args.unthrottledReads = true
        break
      case "--insecure-cookies":
        args.insecureCookies = true
        break
      default:
        // A leading dash makes it an option someone got wrong; anything else
        // is a stray word. champctl-serve takes no positional arguments, so
        // calling `champctl-serve batl` an "unknown option" sends the reader
        // looking for a flag they never typed.
        throw new UsageError(
          a.startsWith("-")
            ? `Unknown option ${a}`
            : `champctl-serve takes no arguments, only options, so it doesn't know what to do ` +
                `with ${JSON.stringify(a)}. A league profile is \`--profile ${a}\`.`,
        )
    }
  }

  // After the loop, and skipped entirely for --help: an explicit --port wins
  // over the environment, and a broken $PORT is not a reason to refuse to
  // explain what the flags are.
  args.port = explicitPort ?? (args.help ? DEFAULT_PORT : envPort())
  return args
}

/**
 * A port number, rejected the same way the other CLIs reject a lap count.
 *
 * `Number("")` is 0 and `Number("8080x")` is NaN, and a `listen` call given
 * either binds *something*: 0 means "any free port", which starts a server
 * nobody can find. The same lesson as `--laps` with an unset shell variable.
 */
function port(raw: string, flag: string): number {
  if (!/^\d+$/.test(raw.trim())) {
    throw new UsageError(`${flag} needs a port number, not ${JSON.stringify(raw)}.`)
  }
  const v = Number(raw)
  if (v < 1 || v > 65535) {
    throw new UsageError(`${flag} needs a port from 1 to 65535, not ${v}.`)
  }
  return v
}

/** What `--port` and `$PORT` are both measured against. */
const DEFAULT_PORT = 3000

function envPort(): number {
  const raw = process.env["PORT"]
  return raw ? port(raw, "PORT") : DEFAULT_PORT
}

/**
 * Where the built UI lives.
 *
 * An explicit `--client` is relative to the working directory, because that is
 * what a path someone typed means.
 *
 * The default is relative to *this module*, not to the working directory.
 * champctl-serve installed globally is normally run from somewhere else
 * entirely, and its UI ships beside the compiled code under the installed
 * `dist/` — resolving `dist/client` against the caller's cwd looks right from
 * a checkout and silently starts API-only everywhere else, which surfaces as a
 * blank page rather than as anything about paths.
 *
 * `../client` from `dist/cli/serve.js` is `dist/client`, which is the deployed
 * case. Under tsx the same expression is `src/client`, which does not exist —
 * and `npm run serve` is exactly that, so the documented "the API and, if
 * built, the client" quietly meant API-only in a checkout however many times
 * you had run `npm run build`.
 *
 * So both are tried, nearest first, and *neither existing is the ordinary
 * state* — it is a checkout where nobody has run `npm run build` yet. What
 * gets returned then goes into `registerClient`'s warning, so it has to be a
 * path a build will actually create: from `dist/cli/serve.js` that is the
 * first candidate, and from `src/cli/serve.ts` it is the second. Returning
 * the nearest one unconditionally told a developer to look for `src/client`,
 * which nothing has ever produced.
 */
export function clientRootFor(explicit: string | undefined): string {
  if (explicit) return resolve(process.cwd(), explicit)

  const builtBeside = fileURLToPath(new URL("../client", import.meta.url))
  const builtFromSource = fileURLToPath(new URL("../../dist/client", import.meta.url))

  for (const candidate of [builtBeside, builtFromSource]) {
    if (existsSync(candidate)) return candidate
  }

  // Nothing built. Name the one `npm run build` would create: `dist/client`
  // either way, reached from wherever this module is running.
  return builtBeside.endsWith(`${sep}dist${sep}client`) ? builtBeside : builtFromSource
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(USAGE)
    return 0
  }

  const profile = await loadProfile(args.profile)
  const baseUrl = args.baseUrl ?? profile.acsmBaseUrl
  if (!baseUrl) {
    throw new UsageError(
      `No ACSM base URL. Set acsmBaseUrl in the ${args.profile} profile, or pass --base-url.`,
    )
  }

  const cache = args.cache
    ? await SqliteCache.open({ path: resolve(process.cwd(), ".cache/acsm/cache.db") })
    : undefined

  /**
   * The installed-content index reads through a reader of its own, at its own
   * pace.
   *
   * Both halves matter, and the second one is a number somebody has to sit
   * through. Sharing the interactive limiter meant a walk took every slot in
   * the window and the `/api/championships` request from the same screen
   * queued behind it — the championship list hung while champctl was being
   * polite about a dropdown. But keeping the interactive *rate* was just as
   * bad: five requests per twenty seconds is a quarter of a request a second,
   * and BATL's 504 cars are eleven pages of fifty, so reading them took over a
   * minute of somebody watching a field say "Reading what's installed".
   *
   * That rate is not protecting anything here. ACSM limits `/login` and
   * nothing else — measured on 2.4.15, eight rapid `GET /championships` and
   * eight `GET /healthcheck.json` all answered 200 while the sixth login in a
   * second got a 429. champctl's read limiter is self-imposed politeness for a
   * person clicking around a manager all evening, and this is one bulk read of
   * static pages that happens at boot and at most hourly after.
   *
   * Four a second, so eleven pages is under three seconds and a burst that
   * size is nothing a web server notices.
   */
  const contentReader = new HttpAcsmReader({
    baseUrl,
    ...(args.unthrottledReads
      ? { rateLimit: false as const }
      : { rateLimit: { limit: 4, windowMs: 1000 } }),
  })

  const content = new ContentCache({
    load: async () => {
      // Timed and logged, because how long this takes is a property of the
      // league's manager — how many cars they have installed, how far away it
      // is — and the only way anyone found out it was slow was by watching a
      // field say "Reading what's installed" for a minute.
      const startedAt = Date.now()
      const value = await contentReader.listContent()
      app?.log.info(
        `Read ${value.cars.length} cars and ${value.tracks.length} tracks from Server Manager ` +
          `in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
      )
      return value
    },
    // Kept across restarts, in the response cache's own database. Re-walking
    // `/cars` on every boot is minutes against a league's manager, and the
    // person who just restarted champctl is usually the person about to open
    // the screen. `--no-cache` opts out of this too, which is what that flag
    // means.
    ...(cache ? { store: contentStore(cache, baseUrl) } : {}),
  })

  // Everything after the cache is open runs inside try/finally, because the
  // cache is a SQLite handle with WAL state and only the clean shutdown path
  // used to close it. A pit table that won't load, a port already in use, or a
  // failure during drain all left the database open behind a process that was
  // on its way out — and the next start then inherits whatever that left.
  let app: Awaited<ReturnType<typeof buildServer>> | undefined
  try {
    app = buildServer({
      profile,
      baseUrl,
      content,
      reader: new HttpAcsmReader({
        baseUrl,
        ...(cache ? { cache } : {}),
        ...(args.unthrottledReads ? { rateLimit: false as const } : {}),
      }),
      pits: await loadPits(args.pits),
      clientRoot: clientRootFor(args.client),
      secureCookies: !args.insecureCookies,
      trustProxy: args.trustProxy,
      logger: true,
    })

    if (args.unthrottledReads) {
      app.log.warn(
        "Reading Server Manager without the usual delay between requests. That delay is how " +
          "champctl stays a good citizen on a league's production manager; only leave this on " +
          "against one you can throw away.",
      )
    }

    // Before listening, so the read is already going when the first request
    // arrives — and so a stored index from the last run is in hand rather than
    // being fetched while somebody waits on a dropdown.
    await content.warm()

    await app.listen({ port: args.port, host: args.host })
    await shutdownSignal()
    return 0
  } finally {
    // Fastify stops accepting and drains in-flight requests. A push that is
    // mid-POST to ACSM has already left this process; letting it finish is the
    // difference between a completed write and a half-finished one nobody has
    // a record of.
    //
    // Closing the app is itself allowed to fail without stranding the cache —
    // this is the shutdown path, and one broken close should not cost the
    // other.
    try {
      await app?.close()
    } finally {
      cache?.close()
    }
  }
}

/** Resolves on the first SIGINT or SIGTERM. */
function shutdownSignal(): Promise<void> {
  return new Promise((done) => {
    const stop = (): void => {
      process.off("SIGINT", stop)
      process.off("SIGTERM", stop)
      done()
    }
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
  })
}

/** Entry point for `bin/champctl-serve.js` and `npm run serve`. */
export async function run(argv: readonly string[]): Promise<void> {
  await runCli({ name: "champctl-serve", usage: USAGE, main }, argv)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await run(process.argv.slice(2))
}
