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
  emit/        template merge, championship generation, clone
  web/         the HTTP service: Fastify routes, session and plan stores,
               error translation, and the wire types the client shares
  cli/         the command-line entry points, over a shared args module
client/        the React finalize screen, built by Vite into dist/client
docker/        throwaway ACSM for recon and live tests
scripts/recon/ form and round-trip recon against the harness
docs/          what the ACSM source actually says about the write path
profiles/      league baselines — batl.json ships here
```

**The web UI is a second front end over the same engine, not a second
implementation.** `src/web/routes.ts` reads a request, calls `planFinalize` or
`applyFinalize`, and shapes the answer — exactly the relationship
`src/cli/finalize.ts` has to the same two functions. The diff a browser renders
is `plan.changes`, the same array the CLI prints. Anything that would have to be
reimplemented to serve HTTP is a sign the engine is missing something, and
`withOverrides` is where that already happened once: "only the fields you name
change" was CLI code until the UI needed the same rule.

**The read client and the write session are separate types on purpose.**
`AcsmReader` has no way to authenticate; `AcsmSession` holds a cookie jar. The
bot and the archive import only the reader, which makes "the bot never holds
write credentials" a property of the code rather than a promise.

## Gates

```sh
npm run typecheck     # tsc --noEmit, twice: server, then client
npm run lint          # biome lint
npm run format:check  # biome format, checking only
npm test              # vitest run
npm run build         # tsc for dist/, then vite for dist/client
```

CI runs all of these, plus the tests on Node 22.13 and 24. `npm run format`
applies formatting; `npm run lint:fix` applies the fixable lint rules.

`npm test` never needs a container.

Typecheck and build are each two invocations because the client compiles under
different `lib` and `jsx` settings — same strictness, DOM instead of Node. Both
halves are in the one script, so a client that doesn't compile fails the gate
rather than the deploy.

For working on the UI, `npm run serve` runs the API and `npm run dev` runs Vite
on 5173 proxying `/api` to it. The proxy leaves `changeOrigin` off deliberately:
that keeps the `Host` matching the browser's `Origin`, so the server's
cross-origin check behaves the way it will in production instead of rejecting
every write in development.

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

The emitter is a merge chain:

```
golden template (a real exported championship)
  → league defaults    (the profile baseline)
    → championship overrides  (name, cars, tracks, schedule)
      → event overrides (format, race length)
        → emit
```

```ts
const { championship, grid, schedule, derived } = emitChampionship({
  template, profile, pits, spec,
})

grid.summary   // "Capped at 24 by suzuka."
derived        // what the emitter set rather than inherited
```

`cloneChampionship({ source, overrides })` is the same pipeline with the
previous championship as the
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

`test/live/flows.live.test.ts` drives finalize and championship creation end to end: that the
format lands where ACSM actually reads it, that the schedule really is a second
request, that the stale-entry-list guard fires against a list changed by another
session, and that a generated championship imports and comes back intact. Those are the
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
- **`EntryListType` and `PracticeEntryListType` are championship-level.** Not
  `RaceSetup`, where champctl kept them until a real export said otherwise —
  see plan §4.4. A field in the wrong place fails silently in both directions:
  ACSM drops what the emitter writes, and a check reading it back finds
  `undefined` and quietly does nothing.
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

**Anything the emitter doesn't model flows through from the template.**
That's what makes it survive ACSM upgrades: the merge handles values rather than
fields. Arrays replace rather than merge, because `Events` is an ordered list
where position is the round number — index-wise merging would leave the previous championship's
round 5 attached to a three-round championship.

**What the emitter sets rather than inherits** is exactly the list of bugs the
round-trip diff caught: `Created` stamped rather than carried, `RaceSetup.Cars`
derived from the class car list plus the spectator model *only when the
spectator car is on*, `ExportSecondRaceToACSR` forced off when ACSR is off, and
sign-up `ExtraFields` cleared when sign-ups are disabled. Results and entry
lists are cleared too, so the championship is importable and doesn't carry
the previous one's
drivers.

The regression test re-emits a template with no overrides and diffs the result,
allowing only an explicit list of expected changes. When an ACSM upgrade adds a
field the emitter doesn't know about, that test fails before a Wednesday does.

**The web UI holds the finalize plan server-side, and the push endpoint takes a
plan id and nothing else.** This is the design decision the whole HTTP layer
turns on, and the obvious alternative — the browser posts a lap count, the
server re-plans and applies — is broken in a way that looks fine.

`planFinalize` fingerprints the entry list as ACSM rendered it, and
`applyFinalize` re-fetches the form and compares before posting. That guard
exists because the event form is a full-list replace, so a sign-up approved
while a preview is open would be silently deleted by the save. Re-planning at
push time takes the fingerprint one round trip before comparing it, which means
the check is comparing a form against itself and the window it was built to
cover — the person's thinking time — isn't covered at all. The guard would still
be there, still be tested, and no longer guard anything.

Holding the plan buys two more things. What gets posted is what was previewed,
because there is no second set of fields to disagree with the first. And the
parsed form — every entrant's name, Steam GUID, car and pit box — never leaves
the process; `web/view.ts` builds the response by naming what goes out rather
than by deleting what doesn't, so a field added to `FinalizePlan` later is
absent from the API until someone decides otherwise.

**`web/wire.ts` may only import from leaves.** Every response shape lives there
and the client imports it directly, so the browser and the server cannot drift
about what a field is called. That only works while following the import doesn't
drag `node:crypto` and the write session into the client's typecheck, where it
fails on the difference between Node's `Uint8Array` and the DOM's `BlobPart`.
`Change` and `FormFieldChange` moved from `finalize/plan.ts` to
`finalize/format.ts` for exactly this reason — the types are needed in a browser
and `plan.ts` is not.

**Routes are authenticated unless they opt out**, via `config.public` on the
route rather than a list of protected paths somewhere else. A route added
without a thought about auth comes out protected. The inventory in
`test/web.test.ts` is maintained by hand and only catches a route that *was*
protected becoming public; the opt-out default is what covers the rest.

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
- **The client has no tests of its own.** `test/web.test.ts` drives the API end
  to end over a scripted ACSM, and the components are typed against the same
  `wire.ts` the server implements, so a renamed field fails the typecheck. What
  is not covered is the screen's own behaviour: the debounce, the abort on a
  superseded preview, the acknowledgement being retired when the plan changes.
  Those are stated in comments and checked by hand, which is not the same thing.
- **`champctl-serve` has no live test.** `test/live/flows.live.test.ts` drives
  finalize against the Docker harness through the engine; nothing drives it
  through HTTP. The engine is where the risk is, so this is a gap in coverage
  rather than in confidence — but the session and cookie handling in particular
  have only ever met a stub `fetch`.
