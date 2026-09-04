# acsm-champctl

[![CI](https://github.com/mishan/acsm-champctl/actions/workflows/ci.yml/badge.svg)](https://github.com/mishan/acsm-champctl/actions/workflows/ci.yml)

Championship creation, validation and stats for Assetto Corsa Server Manager.
Built for BATL, usable by any league.

Six commands:

| | |
|---|---|
| `gridmom` | check a championship for the mistakes that ruin a race night |
| `champctl-archive` | keep a copy of every export the league has ever run |
| `champctl-finalize` | set a race's format and push it |
| `champctl-championship` | create a championship from a template |
| `champctl-serve` | the finalize and create-a-championship flows as a web UI, for people without a terminal |
| `champctl-bot` | say what gridmom found, what's on this week, and where everyone stands, in Discord |

Working on champctl itself? See [AGENTS.md](AGENTS.md) and
[docs/development.md](docs/development.md).

## Install

Needs Node `>=22.13.0` — that floor is `node:sqlite`, which the archive and the
response cache use.

```sh
npm install
npm run gridmom -- check --file fixtures/synthetic/suzuka-duplicate-pitboxes.json
```

Installed, the six commands are on your `PATH` as `gridmom`,
`champctl-archive`, `champctl-finalize`, `champctl-championship`,
`champctl-serve` and `champctl-bot`.
From a checkout, `npm run gridmom -- <args>` is the same thing.

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

## champctl-championship

A golden template plus overlays, out comes a championship ready to import.

```
champctl-championship build --spec <spec.json> --template <export.json> [options]
champctl-championship clone <championship-id> [options]

  --name <name>          override the championship name; a clone reuses last
                         championship's name without it
  --start <yyyy-mm-dd>   first race night; without it, the next occurrence
                         of the league's race weekday
  --tracks <a,b,c>       override the track list
  --out <path>           write the championship JSON here
  --import               send it to ACSM. Without this, nothing is written.
  --yes                  skip the confirmation prompt
  --json                 machine-readable summary
```

```
$ champctl-championship build --spec september.json --template previous.json

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
championship and an ERROR stops the import. Credentials for `--import` come from
`CHAMPCTL_USERNAME` / `CHAMPCTL_PASSWORD`.

`clone` is the usual path — the previous championship as the template, with its spec read back
out of it. It does not carry the previous championship's dates.

The grid cap names the track that set it: "capped at 24 by Brands Hatch Indy"
tells you what to drop. An unknown pit count is never treated as unlimited.
Entry list length is a separate number and is not sized down to the cap — 30
slots against an 18-car race is deliberate.

### The championship spec

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

## champctl-serve

The weekly flow with a face on it: open an event, set what the racers voted
for, read the diff, push. *Finalizing* is still the verb — it is what the job
is called and what `champctl-finalize` does — but the screen is built around
the event, which is what Server Manager calls the thing being changed, so
checking champctl's work against the manager means looking for the same word in
both. Same engine as `champctl-finalize`, so the preview and the write agree
with the CLI by construction rather than by resemblance.

It also creates a championship, the same way `champctl-championship clone`
does: pick the one to clone, name it, say when it starts, list the tracks in
order, and read the review before anything is created. Cloning rather than
uploading a template because a browser has no file on the server's disk, and
because a league's cars, class, format and entry-list slots are the same as
last time — what changes is the name, the date and the tracks. The track list
is dragged into order, with up and down arrows beside it for a keyboard.

**Rounds can be reordered after the fact too.** ACSM has no endpoint that moves
an event, and the only write that could rewrite the running order is an import
that overwrites the championship — refused outright once anything has been
raced. So champctl moves what a round *is* between the slots instead:

| | |
|---|---|
| **travels with the round** | the track, the layout, the race format |
| **stays with the race night** | the date, the quali time, the round's name, the entry list |

"Monza moves to week 1" means week 1 keeps being week 1, so the calendar and
the round numbers cannot end up disagreeing. A lap count voted for Monza is
about Monza, so it goes with it.

That makes a reorder several event saves with no transaction behind them. It
refuses to move a round that has already been raced — results belong to the
track they were set at — and if a save fails part way it names every round that
moved and every round that didn't, because "the reorder failed" sends someone
to the wrong end of a season.

```sh
champctl-serve                 # http://127.0.0.1:3000
champctl-serve --port 8080 --host 0.0.0.0
```

```
  --port <n>            port to listen on (default: 3000, or $PORT)
  --host <addr>         address to bind (default: 127.0.0.1)
  --profile <id|path>   league profile (default: batl)
  --pits <path>         track pit table (default: data/track-pits.json)
  --base-url <url>      override the profile's ACSM base URL
  --client <dir>        built client to serve (default: dist/client)
  --no-cache            bypass the on-disk response cache
  --trust-proxy         read X-Forwarded-For for the client address
  --insecure-cookies    development only; see below
```

**The server holds no ACSM credentials.** It never reads `CHAMPCTL_USERNAME` or
`CHAMPCTL_PASSWORD`. Each person signs in through the UI with their own, the
resulting cookie jar stays server-side for an hour, and the browser gets an
opaque handle. Nothing is written to disk, so a restart signs everyone out —
which is the right trade against an admin password that survives a redeploy.
Permissions are whatever ACSM says they are: if the person can't edit
championships there, the push fails there.

**Serve it over HTTPS.** It forwards admin credentials between hosts, so the
session cookie carries `Secure` and a browser will refuse to keep it over plain
`http://`. `--insecure-cookies` turns that off for local development and logs a
warning saying what it costs. Behind a reverse proxy, pass `--trust-proxy` —
`request.ip` is what the failed-login throttle counts against, and without it
every login in the world shares one bucket.

The screen is mobile-first, because the thing it is for is applying a Discord
poll result from a phone the evening before a race. It shows the same three
things the CLI prints — what changes, the exact fields that will be posted, and
gridmom against the event *as it would be* — and it refuses in the same places:
an error blocks the push outright, warnings need an acknowledgement, and an
entry list that moved while the preview was open refuses the write and asks you
to look again.

```sh
npm run serve      # the API and, if built, the client
npm run dev        # Vite on :5173, proxying /api to a champctl-serve on :3000
```

## champctl-bot

What champctl says in Discord.

```
champctl-bot report                       check every championship, post what's wrong
champctl-bot announce <champ-id> [round]  post the next round's details
champctl-bot standings <champ-id>         post the championship standings

  --profile <id|path>   league profile (default: batl)
  --channel <id>        override the channel this command posts to
  --min <severity>      ERROR | WARN | INFO     (default: WARN)   [report]
  --suppress <codes>    comma-separated finding codes or prefixes  [report]
  --all                 include championships already fully raced   [report]
  --source <where>      endpoint | export | auto  (default: auto) [standings]
  --dry-run             print what would be posted; talk to nobody
  --pits <path>         track pit table (default: data/track-pits.json)
  --base-url <url>      override the profile's ACSM base URL
  --no-cache            bypass the on-disk response cache
  --now <iso>           pretend it is this time, for the checks     [report]
  -h, --help            this
```

`report` posts to `discord.adminChannelId`; `announce` and `standings` post to
`discord.announceChannelId`. **Neither falls back to the other**, and that is a
safety rule rather than tidiness: gridmom quotes the entry list, so a report
that fell back to the announce channel would tell the whole league which three
drivers are about to be dropped from the grid.

```
$ champctl-bot report --dry-run

checked    BATL September 2026 (1111…) — 2 errors, 0 warnings
finished   BATL July 2026 (2222…) — every round has been raced
FAILED     Deleted (3333…) — 404 Not Found from /championship/3333…/export

**gridmom — BATL September 2026**
Suzuka's entry list has duplicate pit boxes at 3 and 16. There are gaps at 0
and 1 to move them into. Saving this event will drop 2 drivers from the list.
Also Nobody set the race length for suzuka (round 1).

**gridmom — Deleted**
I couldn't read this one: 404 Not Found from /championship/3333…/export

1 checked, 1 already run, 1 failed, 2 messages
```

**The bot holds no ACSM credentials, and there is no flag that would give it
any.** It reads through Public Access, the same way gridmom and the archive do,
and everything it can do to a league is say something in a channel. When the
poll and proposal flows arrive they will post a *link* into `champctl-serve`,
which a person opens under their own login — the bot proposes, a human applies.
`src/bot/` importing anything from the write path is a failing test, not a code
review note.

Exit codes match gridmom's, so a timer can decide whether to page anyone: `0`
nothing worth reporting, `1` warnings only, `2` at least one error or a
championship that couldn't be read, `3` the run itself failed. A championship
that fails never aborts the rest of the walk, and a failure outranks a clean
night — twelve clean championships and one that timed out exits `2`.

Three things worth knowing:

- **A championship whose every round has been raced is skipped.** Its findings
  can't be acted on — the duplicate pit boxes already dropped whoever they
  dropped — so posting them says nothing but "here I am again", nightly, for as
  long as the league keeps its history. That is how a report gets muted, and a
  muted report is worse than none, because everyone still believes it is
  watching. `--all` includes them.
- **Nothing is posted about a clean championship.** A silent channel means a
  clean server; whether the job ran is what the exit code is for.
- **A long report is split rather than dropped.** Discord refuses a message over
  2000 characters outright, so without splitting the championship with the most
  wrong with it is the one whose report goes missing.

Run it nightly, from cron or a timer, and point it at an admin channel: findings
quote the entry list, so they name drivers.

### announce

```
$ champctl-bot announce 1111… --dry-run

**BATL September 2026 — round 3: suzuka**
Quali 20:00 on Wednesday 2 September.
Format: 1x40.
Sign up: https://ac.batlracing.com/championship/1111…
-# All times PDT.
```

Without a round it takes the next one nobody has raced, so a weekly cron entry
needs no argument. An explicit round that has already been raced is refused —
it is nearly always a typo for the one beside it, and "this week at Suzuka"
about a race that happened is worse than an error.

**It announces quali start, which is not what the export stores.** `Scheduled`
is *practice* start, so repeating it would tell everyone to turn up an hour
early, weekly, in public. The time comes out of the same
`Scheduled = qualiStart − practice` maths `champctl-finalize` writes with.

Rounds are counted in running order, not by date. The event array *is* the
running order — a reorder moves what a round is between the slots while the
dates stay put — so re-sorting would make champctl and Server Manager disagree
about which round is round 2.

The format is named with the league's own shorthand when a profile preset
matches, since "1x40" is what the racers voted for and "40 minutes with a
mandatory stop" is the same thing in words nobody used.

It is one-shot and keeps no record of having run. Cron decides when a round is
announced; champctl does not decide it has already done it.


### standings

```
$ champctl-bot standings 1111… --dry-run

**BATL September 2026 — RSS Formula Hybrid**
 1. ada                  43
 1. bo                   43
 3. cy                   30
```

**Two sources, and the difference matters.** `standings.json` is ACSM's own
arithmetic, so it can never disagree with the page drivers look at — but it is
premium-only, absent from the public build entirely. The export carries results
inline on every build, so champctl can do the sums itself. `--source` picks;
`auto` prefers the endpoint.

Under `auto` champctl computes the export standings *as well*, purely to compare
them, and reports any disagreement to stderr — never to the channel. That is
what stops the fallback rotting: at a premium league the endpoint always
answers, so without this the computation would sit unexercised until the day it
was needed. A disagreement is a real finding either way round — either
champctl's sums are wrong, or ACSM changed how it scores.

**The export fallback refuses more than it computes, on purpose.** Four things
about ACSM's scoring have never been measured against a real manager, and each
would change every number in the table:

| | |
|---|---|
| more than one class | which position a class scores — the one in the class or the one on the road — is written down nowhere, and matching a class's entrants to results is unmeasured in its own right |
| `IgnoreXWorstEvents` | something is dropped; which rounds, and whether per driver or per championship, is written down nowhere |
| `CollisionWithDriver`, `CollisionWithEnv`, `CutTrack` | on the points table, and the incidents are in the export, but whether ACSM applies them automatically is unknown |
| the second race of a reversed-grid round | `SecondRaceMultiplier` says there is one; nothing knows what session key its results arrive under |

So it declines and names the reason rather than posting a table that is quietly
wrong. **BATL's own 2x20 is the last case**, which means at BATL the endpoint
is the only source today and the cross-check reports "not comparable" rather
than agreeing. `npm run recon:standings -- <base-url> <champ-id>` is what closes
these: it reads standings.json without credentials and prints its *shape* —
key paths and value types, no driver names — so the answer is safe to paste.

A message that says "Worked out from the championship export, not read from
Server Manager" is champctl's own arithmetic, and worth knowing before anyone
argues about a point.

**Setup.** Create an application at
<https://discord.com/developers/applications>, add a bot, invite it to the
server with **Send Messages** in the channel you want, and put its token in
`CHAMPCTL_DISCORD_TOKEN`. The channel id goes in the profile — right-click the
channel, "Copy Channel ID". No intents are needed and none are requested; a
report reads nothing from Discord.

```sh
CHAMPCTL_DISCORD_TOKEN=… champctl-bot report
```

The token is never a flag. A token on a command line is in your shell history
and in every `ps` listing on the box, so `--token` is an error that says so
rather than an option that quietly isn't there.

## Configuration

**League profile.** BATL's baseline is `profiles/batl.json`; another league
drops in their own and passes `--profile ./my-league.json`. It holds the ACSM
base URL, the race weekday and quali time, the timezone, and the defaults
gridmom compares against.

Two profile fields are load-bearing for a check rather than cosmetic, and both
turn one *on*:

`entryList.raceNumberFromSkin`, a regex for how your skin folder names encode a
race number. ACSM has no race number field, so without it the duplicate-race-
number check doesn't run — guessing at digits inside arbitrary skin names finds
a "duplicate" in every entry list.

`entryList.uniqueSkins`, if your league expects everyone to have their own. Off
by default, because most leagues share skins — not everyone has one — and this
check used to read ACSM's `AllowDuplicateSkinChoices` instead. That field is
`false` in every export anyone has looked at, which is Go's zero value rather
than a rule, so a normal entry list produced a screenful of errors that blocked
every push and buried the findings that mattered.

`excludedCarModels` is league furniture: cars that are always in the list and
never worth a finding. BATL's `ford_transit` runs in every race for the stream,
so naming it here stops both the car-list checks reporting it — whatever the
spectator car setting says, since `SpectatorCar.Model` is empty on a real BATL
export and there is nothing there to recognise the van by. Forgiven for being
present, never required to be.

`formats` is the league's own shorthand — BATL's `1x40` and `2x20` — offered as
one-tap starting points in the web UI. They live in the profile rather than in
the UI because they are league convention: another league's names and numbers
should be a config change, not a fork.

```json
"formats": [
  { "name": "1x40", "length": { "kind": "minutes", "minutes": 40 },
    "reversedGridPositions": 0, "mandatoryPit": true, "extraLap": false }
]
```

**Track pit counts.** `data/track-pits.json`, an array of records — see
[`data/track-pits.example.json`](data/track-pits.example.json). Three sources,
with `manual` always winning, because mod tracks routinely lie in their ui file.
The file is gitignored: it's league data, not code. Without it the grid checks
degrade to a warning that the pit count is unknown rather than guessing.

**Discord.** Channel ids as "Copy Channel ID" gives them — 17 to 20 digits, not
a name and not a link, both of which would otherwise fail at post time on a job
nobody watches. They live in the profile rather than the environment because a
channel id is league configuration, not a secret; the token is the secret and
stays in `CHAMPCTL_DISCORD_TOKEN`. `profiles/batl.json` deliberately ships
without either, since a committed channel id is a channel every fork posts into.

```json
"discord": {
  "adminChannelId": "1234567890123456789",
  "announceChannelId": "9876543210987654321",
  "announce": { "format": false, "signUp": false }
}
```

`announce` trims the parts of an announcement champctl says, because ACSM has
its own Discord integration and BATL already has it switched on — so some of
this is said twice by default. Which parts overlap depends on how that
integration is configured, which champctl cannot see, so the league decides
rather than champctl guessing. The four parts are `track`, `quali`, `format` and
`signUp`, all on unless named. An unknown key is an error rather than ignored: a
typo in an opt-*out* block is silent in the worst direction, since `"quail":
false` leaves quali on while reading, to whoever wrote it, as already off.

**Credentials.** `CHAMPCTL_USERNAME` and `CHAMPCTL_PASSWORD`, read from the
environment and never written to disk. Only the write *commands* need them —
`champctl-serve` deliberately does not read them at all, because a long-running
service holding an admin password in its environment is one exposed endpoint
away from being an admin password anyone can spend.

**Cache.** Responses are cached in `.cache/acsm/cache.db` for five minutes, so
re-running gridmom while fixing a pit box costs one request. It holds whole
response bodies — entry lists, so driver names and Steam GUIDs — and is created
`0600` inside a `0700` directory. `--no-cache` bypasses it.

## Status

gridmom, the archive, and the finalize and championship engines are done and driven by
their CLIs. Finalizing, creating a championship and reordering its rounds all
have a web UI. What's left:

- **No sign-up approval queue.** It needs the approve/reject POST captured
  first, which is the last unread request in §3.4.
- **Reordering is web-only.** The engine is in `src/reorder/`, and nothing on
  the command line reaches it — unlike every other engine here, which has a CLI
  as its first front end.
- **The bot only talks.** The nightly report, announcements and standings are
  there; the format poll and the poll-to-proposal loop are not, and neither are
  the `/stats` lookups, which want archive projections that don't exist yet.
  Nothing yet receives a Discord interaction — the gateway is connected and no
  handler is attached to it.
- **Standings from the export refuse more than they compute.** Drop-worst,
  penalty points and the second race of a reversed-grid round are all
  unmeasured, so the fallback declines rather than guessing — which means it
  declines on BATL's own 2x20. `npm run recon:standings` against a premium
  manager is what closes this, and until someone runs it the cross-check
  between the two sources has nothing to compare at BATL.
- **The nightly report has no memory.** It says the same thing every night until
  someone fixes it, which is gridmom's voice by design but also means there is
  nothing to lean on if a league wants "tell me once". A digest per championship
  in the archive database would do it.
- **Content checks have no source.** Three `content.*` checks need an index of
  what's installed on the server, and nothing populates one yet, so they can't
  fire. The pit-count check reads the pit table instead and works today.
- **No real export fixture.** Everything is tested against synthetic ones; the
  archive's first run produces a real one, it just needs sanitising first.

Full design in [`acsm-champctl-plan.md`](acsm-champctl-plan.md).

## License

MIT — see [LICENSE](LICENSE). champctl is deliberately public so another league
can run it with its own profile; nothing here is BATL-specific except
`profiles/batl.json`.

Assetto Corsa Server Manager itself is separate software under its own terms,
and none of it is redistributed here. The premium build and its licence key are
a per-purchase thing you supply yourself — see [`docker/README.md`](docker/README.md).
