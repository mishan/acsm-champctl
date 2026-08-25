# acsm-champctl

Championship creation, validation and stats for Assetto Corsa Server Manager.
Built for BATL, intended to be usable by any league.

See [`acsm-champctl-plan.md`](acsm-champctl-plan.md) for the full design. This
README covers what exists today.

## Status

- **Phase 1 — gridmom**, the sanity checker, plus the read-only client it needs.
  Done.

- **Phase 1b — the archive.** Every championship export the league has ever run,
  kept verbatim, on a nightly schedule. Read-only by construction.

- **Phase 2 — the write path.** Foundations are in: an authenticated session, an
  ordered-multimap form parser, the import safety rules, and a Docker test
  harness so the write path can be verified against a throwaway ACSM rather than
  by hand.

- **Phase 3 — finalize a race.** The engine is in: the flow with a diff preview
  and the stale-entry-list guard, plus the server-side session store.

- **Phase 4 — create a month.** The engine is in too: the month emitter,
  template-and-overlay with a grid cap and clone-last-month.

Neither Phase 3 nor Phase 4 has an HTTP server or UI on top of it yet.

The read client and the write session are separate types on purpose. The bot and
the archive import only `AcsmReader`, which has no way to authenticate — that
makes "the bot never holds write credentials" a property of the code.

```
src/
  acsm/        types, read client, session (write), form parser, diff,
               rate limiter, response cache, import safety rules
  archive/     verbatim export store + the ingest run
  content/     installed-content index (interface + snapshot impl)
  pits/        track pit table, acsm | scan | manual precedence
  profile/     league profile schema + loader
  gridmom/     the checker: findings model, check registry, formatters
  finalize/    race format, schedule maths, plan + apply (phase 3)
  emit/        template merge, month generation, clone (phase 4)
  web/         server-side session store for the UI
  cli/         the command-line entry points, over a shared args module
docker/        throwaway ACSM for recon and live tests
scripts/recon/ form and round-trip recon against the harness
docs/          what the ACSM source actually says about the write path
profiles/      league baselines — batl.json ships here
```

## Quick start

Needs Node `>=22.13.0`. That floor is `node:sqlite`, which the archive uses:
it exists from 22.5 but only without `--experimental-sqlite` from 22.13. Node 20
is no longer supported — it has no `node:sqlite` at all.

```sh
npm install
npm test
npm run gridmom -- check --file fixtures/synthetic/suzuka-duplicate-pitboxes.json
```

`npm run lint`, `npm run format:check` and `npm run typecheck` are what CI
enforces, alongside the tests on Node 22.13 and 24. `npm run format`
applies the formatting if a change has drifted from it.

Against a live manager (no credentials needed — Public Access is enabled):

```sh
npm run gridmom -- list
npm run gridmom -- check <championship-id>
```

## Test harness

`docker/` runs a throwaway ACSM so the write path can be verified without
touching a league's server. See [`docker/README.md`](docker/README.md) — read the
safety note first, because the recon scripts create and delete championships.

```sh
npm run harness:up
set -a && . docker/.env && set +a

npm run recon:forms        # snapshot every form champctl drives
npm run recon:roundtrip    # import, export, diff
npm run test:live          # assertions those answers should hold to
npm run harness:reset      # back to an empty manager
```

`npm test` never needs the container; the live suite has its own config and
skips without `CHAMPCTL_LIVE_URL`.

`test/live/flows.live.test.ts` drives the finalize and month flows end to end —
that the format lands where ACSM actually reads it, that the schedule really is
a second request, that the stale-entry-list guard fires against a list changed
by another session, and that a generated month imports and comes back intact.
Those are the assertions a scripted `fetch` cannot make.

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

## Archive

`champctl-archive` keeps a copy of every championship export the league has ever
run (plan §8.1). ACSM is the only place that history exists, so the sooner this
starts running the less of it can be lost.

```sh
npm run archive -- run       # fetch every championship, store what changed
npm run archive -- status    # what's in the archive already
npm run archive -- run --db /srv/champctl/archive.db
```

Read-only by construction — it holds an `AcsmReader`, which has no credentials
and no write methods. That is what makes it the one job safe to point at a
league's production manager on a schedule.

Exit codes follow gridmom's contract: `0` nothing changed, `1` something was
archived, `2` at least one championship failed, `3` the run itself failed. A
failure outranks a success, so a night that archived thirty and lost one still
exits 2. One bad championship never aborts the rest — the point of a nightly
job is that the archive gets no worse.

**Bodies are stored verbatim**, as `BLOB`s — not parsed and re-serialised, and
not decoded to text. `JSON.stringify` reorders integer-like keys, turns `1.0`
into `1`, and normalises escapes; a UTF-8 decode strips a byte-order mark and
replaces anything malformed. None of that matters for reading a championship,
and all of it matters for an archive whose job is to still be trustworthy after
the source is gone. Stats tables are a projection on top, expected to be rebuilt
from scratch whenever a definition changes or two driver identities get merged.

**Snapshots are deduplicated by content**, so a nightly run over a finished
season doesn't write an identical copy every night forever. A snapshot appears
only when the export actually changed, which makes the snapshot list a change
history. `lastCheckedAt` separately records that the run happened, so "nothing
changed" stays distinguishable from "the job has been broken for a month".

**It's a SQLite database**, `data/archive/archive.db`, rather than a directory
of JSON files with an index beside them. The first version was the directory,
and every bug found in it was one bug in different clothes: a body and its index
entry are two writes that have to land together, and they kept not doing. A torn
index read as "no index" and started a fresh one; a shared temp file let one run
publish another's bytes; two overlapping runs each published an index missing
the other's snapshot; dedup trusted a hash whose body had been deleted. Those
each have a fix, and the fixes were turning into a hand-rolled transaction log.
A row in a transaction is the same guarantee, already written and already
tested. `--db` points somewhere else if you want it to.

Gitignored either way: league data, and personal data at that, since every
export carries driver names and Steam GUIDs. `.gitignore` keeps it out of the
repo and does nothing about the other accounts on the machine, so champctl
creates the directory `0700` and the database `0600` — including SQLite's
`-wal` sidecar, which holds pages not yet checkpointed and is archive content
in its own right. A directory that already exists is left as the operator set
it.

`--since` is parsed strictly as ISO 8601, and a bare date means UTC midnight
rather than the machine's, so the same cron line means the same thing
everywhere.

## Finalize a race

The weekly flow from plan §5.2, as a library: read the event, apply a voted
format, preview exactly what changes, push. Phase 3's engine — no HTTP server
or UI yet, which is where the rest of Phase 3 goes.

```ts
const plan = await planFinalize(session, {
  championship, championshipId, eventId,
  format: { length: { kind: "laps", laps: 18 }, reversedGridPositions: 5,
            mandatoryPit: true, extraLap: false },
  qualiStart: { date: "2026-09-09", time: "20:00" },  // optional
  profile, pits,
})

plan.changes      // "Race length: 40 minutes → 18 laps"
plan.formChanges  // the exact fields that will be posted
plan.gridmom      // checked against the championship as it *would* be
plan.blocked      // an ERROR; nothing overrides this

await applyFinalize(session, plan, { acknowledgeWarnings: true })
```

### CLI

```
champctl-finalize <championship-id> <round> [options]

  --laps <n> | --minutes <n>     race length
  --reversed <n>                 reversed grid positions (0 = single race)
  --pit / --no-pit               mandatory pit stop
  --extra-lap / --no-extra-lap
  --quali <date> <time>          move quali, league-local
  --push                         actually write; without it this only previews
  --yes                          skip the confirmation prompt
  --accept-warnings              push despite warnings. Never overrides errors.
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

Only the fields you name change — `--laps 18` means "make it 18 laps", not
"and reset everything I didn't mention". Exit codes: `0` previewed or pushed,
`1` nothing to do, `2` gridmom blocked it or the entry list changed underneath,
`3` champctl failed.

Credentials come from `CHAMPCTL_USERNAME` / `CHAMPCTL_PASSWORD` and are needed
**even for a preview**: the preview reads the event *edit form*, which ACSM
only serves to a logged-in session, and that form is what makes the preview
honest about the fields it would post. For a credential-free look, use gridmom
— the export is public.

Planning performs no writes. Three things about applying are worth knowing:

**The entry list is fingerprinted at preview time and re-checked immediately
before the POST.** ACSM's event form replaces the whole entry list, so a
sign-up approved in ACSM while the preview is open would be silently deleted by
the save — plan §5.3 calls this the most likely way champctl could destroy data
while appearing to work. On a mismatch the write is refused and nothing is
sent. The window doesn't close entirely, since ACSM has no conditional write,
but it shrinks to one round trip and the failure is loud.

**It's two requests, not one.** The event submit form doesn't carry
`Scheduled`, so moving quali time is a second POST to the schedule endpoint.
The event save goes first: if it fails, the schedule is untouched and the event
is unchanged, which is at least coherent.

**gridmom runs against the would-be championship**, not the current one, so the
preview shows the problems this change is about to introduce rather than
yesterday's. That includes the schedule: a plan that moves quali is checked at
the time it would land, so moving a race onto a Saturday says so before it is
sent, and moving one out of the past stops complaining that it is in the past.

## Create a month

Phase 4's engine (plan §4.1, §5.1). A golden template plus overlays, out comes
a championship ready to import.

```
golden template (a real exported championship)
  → league defaults    (the profile baseline)
    → month overrides  (name, cars, tracks, schedule)
      → event overrides (format, race length)
        → emit
```

```ts
const { championship, grid, schedule, derived } = emitMonth({
  template, profile, pits,
  spec: {
    name: "September 2026",
    cars: ["rss_formula_hybrid_2021"],
    rounds: [{ track: "spa" }, { track: "suzuka", date: "2026-09-16" }],
    startDate: "2026-09-02",
    format: { length: { kind: "laps", laps: 18 }, reversedGridPositions: 5,
              mandatoryPit: true, extraLap: false },
  },
})

grid.summary   // "Capped at 24 by suzuka."
derived        // what the emitter set rather than inherited
```

`cloneMonth({ source, overrides })` is the same pipeline with last month as the
template and the spec read back out of it — the most-used path per §5.1, and
deliberately not a separate code path with its own bugs. It does *not* carry
last month's dates.

**Anything the emitter doesn't model flows through from the template.** That's
what makes this survive ACSM upgrades: the schema is a large undocumented Go
struct, so the merge handles values rather than fields. Arrays replace rather
than merging, because `Events` is an ordered list where position is the round
number — index-wise merging would leave last month's round 5 attached to a
three-round month.

**What it sets rather than inherits** is exactly the list of bugs the
round-trip diff caught (§5.5): `Created` stamped rather than carried from the
template, `RaceSetup.Cars` derived from the class car list plus the spectator
model *only when the spectator car is on*, `ExportSecondRaceToACSR` forced off
when ACSR is off, and sign-up `ExtraFields` cleared when sign-ups are disabled.
Results and entry lists are cleared too, so the month is importable and doesn't
carry last month's drivers.

**The grid cap names the track that set it** — "capped at 24 by Brands Hatch
Indy" tells you what to drop; "capped at 24" just invites an argument. An
unknown pit count is never treated as unlimited. Entry list length is a
*separate* number and is not sized down to the cap: BATL runs 30 slots against
`MaxClients: 18` on purpose, and shrinking it would lock people out of a
championship for a constraint that applies on one night (§4.4).

The §4.1 regression test re-emits a template with no overrides and diffs the
result, allowing only an explicit list of expected changes. When an ACSM upgrade
adds a field the emitter doesn't know about, that test fails before a Wednesday
does.

### CLI

```
champctl-month build --spec <spec.json> --template <export.json> [options]
champctl-month clone <championship-id> --name <name> --start <yyyy-mm-dd>

  --tracks <a,b,c>   override the track list
  --out <path>       write the championship JSON here
  --import           send it to ACSM. Without this, nothing is written.
```

```
$ champctl-month build --spec september.json --template last-month.json

September 2026 — 3 rounds

  1. spa                  quali 2026-09-02 20:00
  2. suzuka               quali 2026-09-09 20:00
  3. monza                quali 2026-09-16 20:00

  Capped at 24 by suzuka.

  Set rather than inherited:
    RaceSetup.Cars from the class car list
    Created and Updated stamped from now, not inherited
    every UUID regenerated, so importing creates rather than overwrites
```

This command creates championships, so the default is inert: it prints, and
writes nothing without `--out` or `--import`. An accidental extra championship
is recoverable, but only if you notice — and two championships with sign-ups
split across them is the sort of thing nobody notices until race night.
gridmom runs on the generated month, and an ERROR stops the import.

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

Fuller treatment in [`docs/acsm-write-path.md`](docs/acsm-write-path.md), read
off the ACSM source rather than guessed.

- **The export is the read source of truth.** One unauthenticated request per
  championship yields config, entry list, results, laps and incidents.
- **`EntryList.*` form keys are parallel arrays indexed by position.** Drop one
  value and every entrant after it takes on someone else's data. Build the POST
  by round-tripping the rendered form, never from the JSON export; `postForm`
  refuses a ragged payload rather than sending it.
- **Omitting `EntryList.EntrantID` renumbers every pit box** to its list index.
  Not "leaves it alone" — reassigns it.
- **Duplicate pit boxes delete entrants.** `AddInPitBox` overwrites on
  collision, so the next form save drops the losers. That's why the finding is
  an ERROR and why its message says what happens next.
- **An entry list is meant to be bigger than the grid.** 30 places against an
  18-car race is deliberate (plan §4.4); `MaxClients` caps the night, not the
  championship. So a pit box past the end of a track is only an ERROR once the
  event has actually run — before that it's the expected shape of an
  oversubscribed list.
- **`EntryList.OverwriteAllEvents` and `EntryList.TransferTeamPoints` are never
  sent.**
  ACSM renders them once per entrant with no hidden partner and reads them
  positionally, so omitting the unchecked ones shifts the rest onto the wrong
  people. `postForm` strips both; absent means "false for everyone".
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
  before the round-trip regression test can exist — the archive's first run
  produces one, it just needs sanitising before it can be committed.
- **Content checks need a source.** `ContentIndex` is defined and wired in, but
  nothing populates it, so the three checks that need it — `content.track-`,
  `content.car-` and `content.skin-missing` — cannot fire in production. The
  fourth reads the pit table rather than the content index and works today,
  emitting `content.pit-count-unknown` for a track the pit table has never
  heard of and `content.pit-count-unverified` for one taken on trust.
  `/content/tracks/{track}/ui/ui_track.json` is the endpoint; the harness needs
  AC content installed to exercise it. The
  three gated checks are tested against a stub index, so they will be right
  when a producer arrives rather than being written and verified at the same
  time as it.
- **The read-modify-write flow itself.** `session.ts` and `form.ts` are the
  pieces; the finalize-a-race operation that uses them is next, and the live
  suite is where it gets proven.
- Phases 3 onward: UI, bot.
