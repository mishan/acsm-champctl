# Development

How champctl is put together, and why. For using it, see the
[README](../README.md); for the working rules, [AGENTS.md](../AGENTS.md).

## Layout

```
src/
  acsm/        types, read client, session (write), form parser, diff,
               rate limiter, response cache, import safety rules
  archive/     verbatim export store + the ingest run
  content/     installed-content index (interface + snapshot impl)
  pits/        track pit table, acsm | scan | manual precedence
  profile/     league profile schema + loader
  gridmom/     the checker: findings model, check registry, formatters
  finalize/    race format, schedule maths, plan + apply
  emit/        template merge, month generation, clone
  web/         server-side session store for the UI
  cli/         the command-line entry points, over a shared args module
docker/        throwaway ACSM for recon and live tests
scripts/recon/ form and round-trip recon against the harness
docs/          what the ACSM source actually says about the write path
profiles/      league baselines — batl.json ships here
```

**The read client and the write session are separate types on purpose.**
`AcsmReader` has no way to authenticate; `AcsmSession` holds a cookie jar. The
bot and the archive import only the reader, which makes "the bot never holds
write credentials" a property of the code rather than a promise.

## Gates

```sh
npm run typecheck     # tsc --noEmit
npm run lint          # biome lint
npm run format:check  # biome format, checking only
npm test              # vitest run
npm run build         # tsc -p tsconfig.build.json
```

CI runs all of these, plus the tests on Node 22.13 and 24. `npm run format`
applies formatting; `npm run lint:fix` applies the fixable lint rules.

`npm test` never needs a container.

## Using the pieces as a library

gridmom is a pure function of a championship export, the pit table and the
league profile. No network, no side effects — which is what lets the same code
run inline in a UI before a push, from the CLI, and nightly from a bot.

```ts
import { check } from "./src/gridmom/index.js"

const report = check(championship, profile, { pits, now: new Date() })
report.ok        // false when anything is an ERROR
report.findings  // [{ code, checkId, severity, message, location, data }]
```

Finalize is plan-then-apply. Planning performs no writes.

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

The month emitter is a merge chain:

```
golden template (a real exported championship)
  → league defaults    (the profile baseline)
    → month overrides  (name, cars, tracks, schedule)
      → event overrides (format, race length)
        → emit
```

```ts
const { championship, grid, schedule, derived } = emitMonth({
  template, profile, pits, spec,
})

grid.summary   // "Capped at 24 by suzuka."
derived        // what the emitter set rather than inherited
```

`cloneMonth({ source, overrides })` is the same pipeline with last month as the
template and the spec read back out of it — deliberately not a second code path
with its own bugs.

## Test harness

`docker/` runs a throwaway ACSM so the write path can be verified without
touching a league's server. Read the safety note in
[`docker/README.md`](../docker/README.md) first: the recon scripts create and
delete championships.

```sh
npm run harness:up
set -a && . docker/.env && set +a

npm run recon:forms        # snapshot every form champctl drives
npm run recon:roundtrip    # import, export, diff
npm run test:live          # assertions those answers should hold to
npm run harness:reset      # back to an empty manager
```

The live suite has its own config and skips unless *both* `CHAMPCTL_LIVE_URL`
and `CHAMPCTL_LIVE_PASSWORD` are set. Setting only one skips everything while
looking configured.

`test/live/flows.live.test.ts` drives finalize and month end to end: that the
format lands where ACSM actually reads it, that the schedule really is a second
request, that the stale-entry-list guard fires against a list changed by another
session, and that a generated month imports and comes back intact. Those are the
assertions a scripted `fetch` cannot make.

Re-run `npm run recon:forms` after any ACSM upgrade. It records the version it
captured against, so a later run produces a diff rather than a replacement.

## What the ACSM source actually says

Fuller treatment in [`acsm-write-path.md`](acsm-write-path.md), read off the
ACSM source rather than guessed. The load-bearing parts:

- **The export is the read source of truth.** One unauthenticated request per
  championship yields config, entry list, results, laps and incidents.
- **`EntryList.*` form keys are parallel arrays indexed by position.** Drop one
  value and every entrant after it takes on someone else's data. Build the POST
  by round-tripping the rendered form, never from the JSON export. `postForm`
  refuses a ragged payload, and refuses one missing a key outright — a key that
  isn't there has no count to disagree with, and most of them are indexed
  unguarded in ACSM.
- **Omitting `EntryList.EntrantID` renumbers every pit box** to its list index.
  Not "leaves it alone" — reassigns it.
- **Duplicate pit boxes delete entrants.** `AddInPitBox` overwrites on
  collision, so the next form save drops the losers. That's why the finding is
  an ERROR and why its message says what happens next.
- **An entry list is meant to be bigger than the grid.** 30 places against an
  18-car race is deliberate; `MaxClients` caps the night, not the championship.
  So a pit box past the end of a track is only an ERROR once the event has run.
- **`EntryList.OverwriteAllEvents` and `EntryList.TransferTeamPoints` are never
  sent.** ACSM renders them once per entrant with no hidden partner and reads
  them positionally, so omitting the unchecked ones shifts the rest onto the
  wrong people. `postForm` strips both; absent means "false for everyone".
- **`Scheduled` is practice start, not quali start.** `Scheduled = qualiStart −
  practiceDuration`. All schedule maths happens in league wall-clock time and is
  converted, because November crosses a DST boundary.
- **`RacePitWindowStart` is the mandatory-stop switch.** 1 for a mandatory pit
  and 0 otherwise, so the format and the window have to agree.
- **`EntryList.EntrantID` in the edit form is `PitBox` in the export.** Same
  number, two names. The duplicate-pit-box fix is reassigning into the gaps.
- **`InternalUUID` is not a join key.** The class list and each event list use
  different UUIDs for the same driver; `CAR_n` is what lines them up.
- **Types are deliberately loose.** ACSM's championship schema is a large
  undocumented Go struct that drifts across versions, so we model only what we
  read and let everything else flow through. Don't tighten them.

## Design decisions with a history

**The archive stores bodies verbatim, as `BLOB`s** — not parsed and
re-serialised, not decoded to text. `JSON.stringify` reorders integer-like keys,
turns `1.0` into `1` and normalises escapes; a UTF-8 decode strips a
byte-order mark and replaces anything malformed. None of that matters for
reading a championship and all of it matters for an archive whose job is to
still be trustworthy after the source is gone. Stats tables are a projection on
top, expected to be rebuilt whenever a definition changes.

**The archive is SQLite rather than a directory of JSON files.** The first
version was the directory, and every bug found in it was one bug in different
clothes: a body and its index entry are two writes that have to land together,
and they kept not doing. A torn index read as "no index" and started a fresh
one; a shared temp file let one run publish another's bytes; two overlapping
runs each published an index missing the other's snapshot; dedup trusted a hash
whose body had been deleted. The fixes were turning into a hand-rolled
transaction log. A row in a transaction is the same guarantee, already written
and already tested.

**The response cache is SQLite for the same reason.** A file per entry needed a
unique temp name, a rename, a chmod and a sweep to expire anything — plumbing
for properties an upsert already has. It tore under concurrent use: `writeFile`
truncates before it writes, so a run reading a page while another rewrote it saw
neither body, and an unparseable entry reads as a miss. A cache that stops
caching looks exactly like a cold one.

**Anything the month emitter doesn't model flows through from the template.**
That's what makes it survive ACSM upgrades: the merge handles values rather than
fields. Arrays replace rather than merge, because `Events` is an ordered list
where position is the round number — index-wise merging would leave last month's
round 5 attached to a three-round month.

**What the emitter sets rather than inherits** is exactly the list of bugs the
round-trip diff caught: `Created` stamped rather than carried, `RaceSetup.Cars`
derived from the class car list plus the spectator model *only when the
spectator car is on*, `ExportSecondRaceToACSR` forced off when ACSR is off, and
sign-up `ExtraFields` cleared when sign-ups are disabled. Results and entry
lists are cleared too, so the month is importable and doesn't carry last month's
drivers.

The regression test re-emits a template with no overrides and diffs the result,
allowing only an explicit list of expected changes. When an ACSM upgrade adds a
field the emitter doesn't know about, that test fails before a Wednesday does.

**One forbidden-key list.** `FORBIDDEN_KEYS` in `acsm/write.ts` is the only one;
anything that rebuilds an object key by key imports it. `out[k] = value` where
the key is `__proto__` reparents the object rather than adding a field, and an
export is parsed JSON where `__proto__` survives as an ordinary own property.
Two copies of that list is one that gets updated and one that doesn't.

## Known gaps

- **`ContentIndex` has no producer.** The interface and three checks that use it
  exist and are tested against a stub, but nothing populates a real one, so
  those checks can't fire in production.
  `/content/tracks/{track}/ui/ui_track.json` is the endpoint; the harness needs
  AC content installed to exercise it. Either wire it up or delete it — a check
  that cannot run is worse than no check, because the report looks complete.
- **No real export fixture.** `fixtures/import-roundtrip/` needs a real BATL
  export before the round-trip regression test can cover the real schema. The
  archive's first run produces one; it needs sanitising before it can be
  committed.
