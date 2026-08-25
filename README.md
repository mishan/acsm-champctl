# acsm-champctl

Championship creation, validation and stats for Assetto Corsa Server Manager.
Built for BATL, usable by any league.

Four commands:

| | |
|---|---|
| `gridmom` | check a championship for the mistakes that ruin a race night |
| `champctl-archive` | keep a copy of every export the league has ever run |
| `champctl-finalize` | set a race's format and push it |
| `champctl-month` | create a month of racing from a template |

Working on champctl itself? See [AGENTS.md](AGENTS.md) and
[docs/development.md](docs/development.md).

## Install

Needs Node `>=22.13.0` — that floor is `node:sqlite`, which the archive and the
response cache use.

```sh
npm install
npm run gridmom -- check --file fixtures/synthetic/suzuka-duplicate-pitboxes.json
```

Installed, the four commands are on your `PATH` as `gridmom`,
`champctl-archive`, `champctl-finalize` and `champctl-month`. From a checkout,
`npm run gridmom -- <args>` is the same thing.

Every command takes `--profile` and `--base-url`; `--help` on any of them is
authoritative.

## gridmom

Checks a championship and says what's wrong in plain sentences. Reading a
championship needs no credentials — the export is public.

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

```
$ gridmom check <id>

gridmom — BATL August 2026

ERROR Suzuka's entry list has duplicate pit boxes at 3, 16 and 27. There are
      gaps at 10, 19 and 22 to move them into. Saving this event will drop 3
      drivers from the list.
      Events[0].EntryList  entry.duplicate-pit-box
ERROR Nobody set the race length for suzuka (round 1).
      Events[0].RaceSetup.Sessions.Race  format.race-length-missing

4 errors, 6 warnings, 2 notes. Fix the errors before pushing.
```

`--format discord` writes the same findings as one message a person can read:

```
**gridmom:** Nobody set the race length for suzuka (round 1). Also Imola
(round 2) is a 40-lap single race but the pit window never opens, so
there's no mandatory stop.
```

| | |
|---|---|
| **ERROR** | Will produce a broken or unfair race. Blocks a push. |
| **WARN** | Probably wrong. A push needs an acknowledgement. |
| **INFO** | Differs from the league baseline. Never blocking. |

Exit codes are the contract for cron: `0` clean, `1` warnings, `2` errors, `3`
gridmom itself failed. A nightly job can decide whether to post without parsing
anything.

`--suppress` takes exact codes, dotted prefixes or a check id, so `--suppress
format` hides every format finding and `--suppress champ.repeated-track` hides
one. For a league that genuinely runs the same track twice.

## champctl-archive

ACSM is the only place a league's history exists. This keeps a copy of every
championship export, deduplicated by content, in a SQLite database.

```sh
champctl-archive run       # fetch every championship, store what changed
champctl-archive status    # what's in the archive already
champctl-archive run --db /srv/champctl/archive.db --since 2026-08-01
```

Read-only by construction: it holds a reader with no credentials and no write
methods, which is what makes it the one job safe to point at a production
manager on a schedule.

Exit codes: `0` nothing changed, `1` something was archived, `2` at least one
championship failed, `3` the run itself failed. A failure outranks a success, so
a night that archived thirty and lost one still exits 2 — and one bad
championship never aborts the rest.

A snapshot is written only when the export actually changed, so the snapshot
list is a change history. `lastCheckedAt` separately records that the run
happened, which keeps "nothing changed" distinguishable from "the job has been
broken for a month".

The database is `data/archive/archive.db` by default and holds driver names and
Steam GUIDs, so it's gitignored and champctl creates it `0600` inside a `0700`
directory. A directory that already exists is left as you set it.

Run it nightly, from cron or a timer. The sooner it starts, the less history can
be lost.

## champctl-finalize

Set a race's format after the vote, preview exactly what changes, push.

```
champctl-finalize <championship-id> <round> [options]

  --laps <n> | --minutes <n>      race length
  --reversed <n>                  reversed grid positions (0 = single race)
  --pit / --no-pit                mandatory pit stop
  --extra-lap / --no-extra-lap
  --quali <date> <time>           move quali, league-local
  --push                          actually write. Without it this only previews.
  --yes                           skip the confirmation prompt
  --accept-warnings               push despite warnings. Never overrides errors.
  --json                          machine-readable plan
```

```
$ champctl-finalize 1111... 1 --laps 18 --pit

Round 1 of 1111...
  Race length: 20 laps → 18 laps
  Mandatory pit stop: no → yes

  Fields that will be posted:
    Race.Laps: 20 → 18
    RacePitWindowStart: 0 → 1

Preview only. Re-run with --push to apply.
```

Round is 1-based, as a league counts them. Only the fields you name change —
`--laps 18` means "make it 18 laps", not "and reset everything I didn't
mention".

Exit codes: `0` previewed or pushed, `1` nothing to do, `2` gridmom blocked it
or the entry list changed underneath, `3` champctl failed.

**Credentials come from `CHAMPCTL_USERNAME` and `CHAMPCTL_PASSWORD`, and are
needed even for a preview.** The preview reads the event *edit form*, which ACSM
only serves to a logged-in session, and that form is what makes the preview
honest about the fields it would post. For a credential-free look, use gridmom.

Three things worth knowing:

- **The entry list is fingerprinted at preview time and re-checked immediately
  before the POST.** ACSM's event form replaces the whole entry list, so a
  sign-up approved while your preview is open would be silently deleted by the
  save. On a mismatch the write is refused and nothing is sent.
- **It's two requests.** The event submit form doesn't carry `Scheduled`, so
  moving quali is a second POST. The event save goes first: if it fails, the
  schedule is untouched.
- **gridmom runs against the championship as it *would* be**, so the preview
  shows the problems this change is about to introduce rather than yesterday's.
  Moving a race onto a Saturday says so before it's sent.

## champctl-month

A golden template plus overlays, out comes a championship ready to import.

```
champctl-month build --spec <spec.json> --template <export.json> [options]
champctl-month clone <championship-id> [options]

  --name <name>          override the month name; a clone reuses last
                         month's name without it
  --start <yyyy-mm-dd>   first race night; without it, the next occurrence
                         of the league's race weekday
  --tracks <a,b,c>       override the track list
  --out <path>           write the championship JSON here
  --import               send it to ACSM. Without this, nothing is written.
  --yes                  skip the confirmation prompt
  --json                 machine-readable summary
```

```
$ champctl-month build --spec september.json --template last-month.json

September 2026 — 3 rounds

  1. spa                  quali 2026-09-02 20:00
  2. suzuka               quali 2026-09-09 20:00
  3. monza                quali 2026-09-16 20:00  (moved)

  Capped at 24 by suzuka.

  Set rather than inherited:
    RaceSetup.Cars from the class car list
    league baseline applied to every round's RaceSetup
    RaceSetup.MaxClients 24 from suzuka's pit boxes
    Created and Updated stamped from now, not inherited
    every UUID regenerated, so importing creates rather than overwrites

  gridmom:
    [WARN] RSS Formula Hybrid pays points down to 15th but up to 24 cars can
           start, so the last 9 finishers can't score.

Nothing written. Use --out to save it, or --import to send it.
```

**This command creates championships, so the default is inert**: it prints, and
writes nothing without `--out` or `--import`. gridmom runs on the generated
month and an ERROR stops the import. Credentials for `--import` come from
`CHAMPCTL_USERNAME` / `CHAMPCTL_PASSWORD`.

`clone` is the usual path — last month as the template, with its spec read back
out of it. It does not carry last month's dates.

The grid cap names the track that set it: "capped at 24 by Brands Hatch Indy"
tells you what to drop. An unknown pit count is never treated as unlimited.
Entry list length is a separate number and is not sized down to the cap — 30
slots against an 18-car race is deliberate.

### The month spec

```json
{
  "name": "September 2026",
  "cars": ["rss_formula_hybrid_2021"],
  "rounds": [
    { "track": "spa" },
    { "track": "suzuka" },
    { "track": "monza", "date": "2026-09-16" }
  ],
  "startDate": "2026-09-02",
  "entryListSlots": 30,
  "format": {
    "length": { "kind": "laps", "laps": 18 },
    "reversedGridPositions": 5,
    "mandatoryPit": true,
    "extraLap": false
  }
}
```

Only `name`, `cars` and `rounds` are required. `format` applies to every round
unless a round overrides it; without `startDate`, rounds fall on the league's
race weekday starting from the next one. `className`, `description` and
`signUpsEnabled` are also accepted.

## Configuration

**League profile.** BATL's baseline is `profiles/batl.json`; another league
drops in their own and passes `--profile ./my-league.json`. It holds the ACSM
base URL, the race weekday and quali time, the timezone, and the defaults
gridmom compares against.

One profile field is load-bearing for a check rather than cosmetic:
`entryList.raceNumberFromSkin`, a regex for how your skin folder names encode a
race number. ACSM has no race number field, so without it the duplicate-race-
number check doesn't run — guessing at digits inside arbitrary skin names finds
a "duplicate" in every entry list.

**Track pit counts.** `data/track-pits.json`, an array of records — see
[`data/track-pits.example.json`](data/track-pits.example.json). Three sources,
with `manual` always winning, because mod tracks routinely lie in their ui file.
The file is gitignored: it's league data, not code. Without it the grid checks
degrade to a warning that the pit count is unknown rather than guessing.

**Credentials.** `CHAMPCTL_USERNAME` and `CHAMPCTL_PASSWORD`, read from the
environment and never written to disk. Only the write commands need them.

**Cache.** Responses are cached in `.cache/acsm/cache.db` for five minutes, so
re-running gridmom while fixing a pit box costs one request. It holds whole
response bodies — entry lists, so driver names and Steam GUIDs — and is created
`0600` inside a `0700` directory. `--no-cache` bypasses it.

## Status

gridmom, the archive, and the finalize and month engines are done and driven by
their CLIs. What's left:

- **No HTTP server or UI** on top of finalize and month yet, and no Discord bot.
- **Content checks have no source.** Three `content.*` checks need an index of
  what's installed on the server, and nothing populates one yet, so they can't
  fire. The pit-count check reads the pit table instead and works today.
- **No real export fixture.** Everything is tested against synthetic ones; the
  archive's first run produces a real one, it just needs sanitising first.

Full design in [`acsm-champctl-plan.md`](acsm-champctl-plan.md).
