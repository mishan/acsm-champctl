/**
 * `champctl-mcp`: champctl's reading side as an MCP server over stdin and
 * stdout, for Claude Code, Claude Desktop or any MCP client. It holds no ACSM
 * login, so nothing a model asks of it can change a championship.
 */

import { existsSync } from "node:fs"
import { pathToFileURL } from "node:url"

import { HttpAcsmReader } from "../acsm/client.js"
import { SqliteIncidentStore } from "../incidents/store.js"
import { SqliteClaimStore } from "../liveries/claims.js"
import { SqliteSubmissionQueue } from "../liveries/queue.js"
import { SqliteLiveryStore } from "../liveries/store.js"
import { serveTools } from "../mcp/server.js"
import { championshipTools, storeTools } from "../mcp/tools.js"
import { loadProfile } from "../profile/load.js"
import { recordingTools } from "../spectator/mcp.js"
import { defaultStorePath } from "../sqlite.js"
import { defaultProfile, loadPits, runCli, UsageError } from "./args.js"

const USAGE = `Usage: champctl-mcp [options]

Serves champctl to an MCP client over stdin and stdout: championships,
standings, GridMom's checks, liveries, incident reports, and the race
recordings. Read-only: it holds no ACSM login.

Options:
  --profile <id|path>   league profile (default: $CHAMPCTL_PROFILE, else batl)
  --base-url <url>      the league's Server Manager (default: the profile's)
  --pits <file>         track pit table (default: $CHAMPCTL_PITS, else none)
  --store <file>        the bot's store, for claims, liveries and incident
                        reports (default: $CHAMPCTL_STORE, else
                        data/liveries/liveries.db); left out if it isn't there
  --recordings <dir>    the race recorder's folder (default: $CHAMPCTL_RECORDINGS)
  --ac-root <dir>       copied car and track files, for measuring incidents
                        (default: $CHAMPCTL_AC_ROOT)

In Claude Code, on the host that runs champctl's containers:
  claude mcp add champctl -- docker compose -f <deploy>/compose.yml run --rm -T \\
    --no-deps --entrypoint champctl-mcp bot
`

export async function main(argv: readonly string[]): Promise<number> {
  const flags = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(USAGE)
      return 0
    }
    const value = argv[i + 1]
    if (!arg.startsWith("--") || value === undefined) throw new UsageError(`Unexpected ${arg}.`)
    flags.set(arg, value)
    i++
  }
  for (const f of flags.keys()) {
    if (
      !["--profile", "--base-url", "--pits", "--store", "--recordings", "--ac-root"].includes(f)
    ) {
      throw new UsageError(`Unknown option ${f}.`)
    }
  }

  const profile = await loadProfile(flags.get("--profile") ?? defaultProfile())
  const baseUrl = flags.get("--base-url") ?? profile.acsmBaseUrl
  if (!baseUrl) throw new UsageError("No ACSM base URL; set one in the profile or pass --base-url.")
  const storePath = flags.get("--store") ?? defaultStorePath()
  const stores = existsSync(storePath)
    ? {
        claims: await SqliteClaimStore.open(storePath),
        liveries: await SqliteLiveryStore.open(storePath),
        queue: await SqliteSubmissionQueue.open(storePath),
        incidents: await SqliteIncidentStore.open(storePath),
      }
    : undefined
  const recordings = flags.get("--recordings") ?? process.env["CHAMPCTL_RECORDINGS"]
  const acRoot = flags.get("--ac-root") ?? process.env["CHAMPCTL_AC_ROOT"]
  const options = {
    reader: new HttpAcsmReader({ baseUrl }),
    profile,
    pits: await loadPits(flags.get("--pits")),
    ...(stores ? { stores } : {}),
  }
  try {
    await serveTools({
      name: "champctl",
      version: "0.1.0",
      instructions:
        "A sim racing league's championships on Assetto Server Manager, and what champctl knows about them. Start with list_championships. Everything here is read-only. " +
        (recordings && acRoot
          ? "Recorded sessions: list_sessions, then list_incidents and get_incident; a suggested call is the rules engine's, a decision is a human steward's."
          : ""),
      tools: [
        ...championshipTools(options),
        ...storeTools(options),
        ...(recordings && acRoot ? recordingTools({ journals: recordings, acRoot }) : []),
      ],
    })
  } finally {
    if (stores) for (const s of Object.values(stores)) s.close()
  }
  return 0
}

export async function run(argv: readonly string[]): Promise<void> {
  await runCli({ name: "champctl-mcp", usage: USAGE, main }, argv)
}

// Run when executed directly, not when imported by a test.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await run(process.argv.slice(2))
}
