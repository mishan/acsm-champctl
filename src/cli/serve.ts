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

import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { pathToFileURL } from "node:url"

import { HttpAcsmReader } from "../acsm/client.js"
import { SqliteCache } from "../acsm/cache.js"
import { loadProfile } from "../profile/load.js"
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
  help: boolean
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    port: envPort(),
    host: "127.0.0.1",
    profile: "batl",
    cache: true,
    trustProxy: false,
    insecureCookies: false,
    help: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    const next = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new UsageError(`${a} needs a value`)
      return v
    }
    switch (a) {
      case "-h":
      case "--help":
        args.help = true
        break
      case "--port":
        args.port = port(next(), a)
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
      case "--insecure-cookies":
        args.insecureCookies = true
        break
      default:
        throw new UsageError(`Unknown option ${a}`)
    }
  }
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

function envPort(): number {
  const raw = process.env["PORT"]
  return raw ? port(raw, "PORT") : 3000
}

export /**
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
 * `../client` from `dist/cli/serve.js` is `dist/client`. From `src/cli/` under
 * tsx it is `src/client`, which does not exist — a checkout is exactly where
 * `--client` or a build is expected anyway, and `registerClient` says so when
 * the directory isn't there.
 */
function clientRootFor(explicit: string | undefined): string {
  if (explicit) return resolve(process.cwd(), explicit)
  return fileURLToPath(new URL("../client", import.meta.url))
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
      reader: new HttpAcsmReader({ baseUrl, ...(cache ? { cache } : {}) }),
      pits: await loadPits(args.pits),
      clientRoot: clientRootFor(args.client),
      secureCookies: !args.insecureCookies,
      trustProxy: args.trustProxy,
      logger: true,
    })

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
