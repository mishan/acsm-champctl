# acsm-champctl

Championship creation, validation and stats for Assetto Corsa Server Manager.
Built for BATL, intended to be usable by any league.

See [`acsm-champctl-plan.md`](acsm-champctl-plan.md) for the full design. This
README covers what exists today.

## Status

**Phase 1 — gridmom** (the sanity checker) is implemented, plus the read-only
ACSM client it needs. Nothing here can write to a championship; the write path
is Phase 2 and lives in a separate client so that stays true.

```
src/
  acsm/        types, read-only client, rate limiter, response cache
  content/     installed-content index (interface + snapshot impl)
  pits/        track pit table, acsm | scan | manual precedence
  profile/     league profile schema + loader
  gridmom/     the checker: findings model, check registry, formatters
  cli/         gridmom CLI
profiles/      league baselines — batl.json ships here
```

## Quick start

```sh
npm install
npm test
npm run gridmom -- check --file fixtures/synthetic/suzuka-duplicate-pitboxes.json
```

Against a live manager (no credentials needed — Public Access is enabled):

```sh
npm run gridmom -- list
npm run gridmom -- check <championship-id>
```

## gridmom

A pure function from a championship export, the track pit table and the league
baseline to a list of findings. No network, no side effects — so the same code
runs inline in the web UI before a push, on demand from the CLI, and nightly
from the bot.

```ts
import { check } from "./src/gridmom/index.js"

const report = check(championship, profile, { pits, now: new Date() })
report.ok        // false when anything is an ERROR
report.findings  // [{ code, severity, message, location, data }]
```

Three severities, as in the plan:

| | |
|---|---|
| **ERROR** | Will produce a broken or unfair race. Blocks a push. |
| **WARN** | Probably wrong. A push needs an acknowledgement. |
| **INFO** | Differs from the league baseline. Never blocking. |

Findings are one plain sentence naming the thing and where it is. No severity
jargon in the prose — the Discord report has to be readable enough that people
don't mute it.

```
$ npm run gridmom -- check <id> --format discord --min WARN

**gridmom:** Suzuka's entry list has duplicate pit boxes at 3, 16 and 27.
There are gaps at 10, 19 and 22 to move them into. Also Nobody set the race
length for suzuka (round 1).
```

### CLI

```
gridmom check <championship-id>     check a championship on the league's ACSM
gridmom check --file <export.json>  check an export already on disk
gridmom list                        list championships on the league's ACSM

  --profile <id|path>   league profile (default: batl)
  --pits <path>         track pit table JSON (default: data/track-pits.json)
  --format <fmt>        text | json | discord   (default: text)
  --min <severity>      ERROR | WARN | INFO     (default: INFO, discord: WARN)
  --suppress <codes>    comma-separated finding codes or prefixes to hide
  --base-url <url>      override the profile's ACSM base URL
  --no-cache            bypass the on-disk response cache
  --now <iso>           pretend it is this time (for the schedule checks)
```

Exit codes are the contract for cron: `0` clean, `1` warnings, `2` errors,
`3` gridmom itself failed. A nightly job can decide whether to post without
parsing anything.

### Suppressing a finding

`--suppress` takes exact codes or dotted prefixes, so `--suppress format` hides
every format finding and `--suppress champ.repeated-track` hides just the one.
Useful for a league that genuinely runs the same track twice.

## League profiles

BATL's baseline is `profiles/batl.json`. Another league drops in their own and
passes `--profile ./my-league.json`.

Anything that can't be expressed in a profile is something that got hardcoded
and shouldn't have. That is the design check, and it already caught one: the
duplicate-race-number check needs `entryList.raceNumberFromSkin`, a regex for
how the league's skin folder names encode a number, because ACSM has no race
number field. Without it that check doesn't run — guessing at digits inside
arbitrary skin names finds a "duplicate" in every entry list.

## Track pit counts

`data/track-pits.json`, an array of records — see
[`data/track-pits.example.json`](data/track-pits.example.json). Three sources,
`manual` always winning, because mod tracks routinely lie in their ui file.

The file is gitignored: it's league data, not code. Without it the grid checks
degrade to a warning that the pit count is unknown rather than guessing.

## Design notes worth keeping in mind

- **The export is the read source of truth.** One unauthenticated request per
  championship yields config, entry list, results, laps and incidents.
- **`Scheduled` is practice start, not quali start.** `Scheduled = qualiStart −
  practiceDuration`. All schedule maths happens in league wall-clock time and
  is converted, because November crosses a DST boundary.
- **`RacePitWindowStart` is the mandatory-stop switch.** BATL sets 1 for a
  mandatory pit and 0 otherwise, so the format and the window have to agree.
- **`EntryList.EntrantID` in the edit form is `PitBox` in the export.** Same
  number, two names. The duplicate-pit-box fix is reassigning into the gaps.
- **`InternalUUID` is not a join key.** The class list and each event list use
  different UUIDs for the same driver; `CAR_n` is what lines them up.
- **Types are deliberately loose.** ACSM's championship schema is a large
  undocumented Go struct that drifts across versions, so we model only what we
  read and let everything else flow through. Don't tighten them.

## Not done yet

- **A real export fixture.** Everything here is tested against synthetic
  fixtures. `fixtures/import-roundtrip/` (plan §4.1) needs a real BATL export
  before the round-trip regression test can exist.
- **Content checks need a source.** `ContentIndex` is defined and wired in, but
  nothing populates it yet — that's the event form's track XHR (recon item 6).
- Phases 1b onward: archive ingest, write client, UI, bot.
