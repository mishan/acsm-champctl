/**
 * `champctl-upload` — serves the one-time upload links
 * (docs/discord-livery-upload.md §3).
 *
 * Deliberately thin, and deliberately unable to do anything else. It reads no
 * credentials from the environment and has no flag that would take any, because
 * the whole reason this is not part of `champctl-serve` is that
 * `champctl-serve` has a login and this faces the internet.
 */

import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { DEFAULT_LIMITS } from "../liveries/pack.js"
import { SqliteSubmissionQueue } from "../liveries/queue.js"
import { SqliteTokenStore } from "../liveries/upload-token.js"
import { createUploadServer } from "../upload/server.js"

const USAGE = `champctl-upload — takes livery uploads from one-time links.

Usage:
  champctl-upload [options]

Options:
  --port <n>       port to listen on (default: 8477)
  --host <addr>    address to bind (default: 127.0.0.1)
  --store <path>   queue database, shared with champctl-liveries
                   (default: data/liveries/liveries.db)
  --auto-apply     say uploads will be applied on a timer rather than by an
                   admin. Changes what drivers are told, nothing else.
  -h, --help       this

Bind to localhost and put a TLS terminator in front of it. The token travels in
the URL, so the link champctl hands out has to be https — champctl-bot refuses
to mint one that isn't.

This process holds no ACSM credentials and no Discord token, and there is no
option to give it either. It validates uploads and writes them to the queue;
\`champctl-liveries --drain\` is what talks to the game server.
`

export class UsageError extends Error {}

export interface Args {
  port: number
  host: string
  store?: string
  autoApply: boolean
  help: boolean
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { port: 8477, host: "127.0.0.1", autoApply: false, help: false }
  let i = 0
  const next = (flag: string): string => {
    const value = argv[++i]
    if (value === undefined) throw new UsageError(`${flag} needs a value.`)
    return value
  }

  for (; i < argv.length; i++) {
    const arg = argv[i] as string
    switch (arg) {
      case "--port": {
        const port = Number(next(arg))
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new UsageError(`--port must be a port number, not ${JSON.stringify(argv[i])}.`)
        }
        args.port = port
        break
      }
      case "--host":
        args.host = next(arg)
        break
      case "--store":
        args.store = next(arg)
        break
      case "--auto-apply":
        args.autoApply = true
        break
      case "-h":
      case "--help":
        args.help = true
        break
      default:
        // Named explicitly rather than ignored: `--username` here would be
        // somebody assuming this process can write to ACSM, and the error is
        // the place to say that it cannot.
        throw new UsageError(
          `Unknown option ${JSON.stringify(arg)}. champctl-upload takes no credentials — it ` +
            `queues uploads and champctl-liveries --drain applies them.`,
        )
    }
  }
  return args
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(USAGE)
    return 0
  }

  const store = args.store ?? resolve(process.cwd(), "data/liveries/liveries.db")
  const tokens = await SqliteTokenStore.open(store)
  const queue = await SqliteSubmissionQueue.open(store)

  const server = createUploadServer({
    tokens,
    queue,
    limits: DEFAULT_LIMITS,
    autoApply: args.autoApply,
  })

  await new Promise<void>((ready) => server.listen(args.port, args.host, ready))
  process.stderr.write(
    `champctl-upload listening on ${args.host}:${args.port}, queue ${store}\n` +
      `No ACSM credentials in this process. Run champctl-liveries --drain to apply.\n`,
  )

  // Held open until something stops it. Closing the databases on the way out
  // matters: SQLite leaves a -wal beside the file, and a queue whose write-ahead
  // log was never checkpointed is a queue the drain reads short.
  await new Promise<void>((done) => {
    const stop = () => {
      server.close(() => {
        tokens.close()
        queue.close()
        done()
      })
    }
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
  })
  return 0
}

export async function run(argv: readonly string[]): Promise<void> {
  try {
    process.exitCode = await main(argv)
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`${e.message}\n\n${USAGE}`)
      process.exitCode = 3
      return
    }
    process.stderr.write(`champctl-upload couldn't run: ${e instanceof Error ? e.message : e}\n`)
    process.exitCode = 3
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await run(process.argv.slice(2))
}
