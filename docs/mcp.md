# champctl-mcp

`champctl-mcp` serves champctl to an MCP client (Claude Code, Claude Desktop,
or anything else that speaks MCP) over stdin and stdout, so a model can answer
questions about the league with champctl's own reading of it instead of
scraping pages or running commands.

It's read-only. It holds no ACSM login, only the reader every other read-only
part of champctl uses, and a test fails if anything it serves can reach the
code that writes to Server Manager.

## Tools

| Tool | What it answers |
| --- | --- |
| `list_championships` | every championship, with its id |
| `get_championship` | classes, cars, grid size, and each round's track, schedule and whether it's been raced |
| `get_entry_list` | each slot's driver, GUID, team, car and skin |
| `get_standings` | by class: Server Manager's own where it serves them, else worked out from the results |
| `check_championship` | GridMom's findings, most serious first |
| `livery_status` | who's claimed their name, which liveries are applied, uploads queued or refused |
| `list_incident_reports` | `/incident` reports, newest first, with any decision |
| `list_sessions` | recorded sessions, round by round, with their collision counts |
| `list_incidents` | a session's collisions |
| `get_incident` | one collision measured, with a suggested call and a drawing |
| `list_track_skips` | a session's big cuts, and the time each gained |
| `get_rules` | the rules incidents are judged by, and what a recording can't show |

The livery and incident tools appear when the bot's store is there, and the
recording tools when `CHAMPCTL_RECORDINGS` and `CHAMPCTL_AC_ROOT` are set.

## Running it

Where champctl runs in Docker, the bot's container already has the profile,
the store, the recordings and the car and track files. In Claude Code, on that
host:

```sh
claude mcp add champctl -- docker compose -f /path/to/deploy/compose.yml \
  run --rm -T --no-deps --entrypoint champctl-mcp bot
```

From another machine, the same over SSH:

```sh
claude mcp add champctl -- ssh deploy-host docker compose -f /path/to/deploy/compose.yml \
  run --rm -T --no-deps --entrypoint champctl-mcp bot
```

Each session starts its own short-lived container, and it reads the same files
the bot does, so its answers are the bot's.

`champctl-spectator mcp` still serves the recording tools alone, for a steward
with a copy of the recordings and no access to anything else.
