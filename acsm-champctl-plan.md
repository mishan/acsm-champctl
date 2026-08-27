# acsm-champctl — Design & Plan

Working name. Championship creation, validation and stats for Assetto Corsa
Server Manager. Built for BATL, intended to be publicly usable by any league.

Working document. Everything marked **[verify]** is an assumption that needs
checking against the live ACSM before code depends on it.

---

## 1. What this is for

BATL runs a monthly championship on Assetto Corsa Server Manager, one race per
week. Two jobs currently take more knowledge than they should:

1. **Creating the championship.** Whoever sets it up has to know (or copy from a
   previous championship) a large set of league defaults buried across ~130
   fields per event.
2. **Finalizing each race.** Format, race length and quali timing are voted on
   by the racers, often the day before or the morning of. Someone then edits a
   live championship by hand under time pressure.

The second job is the frequent one and the risky one. The tool's center of
gravity is there, not in creation.

A third job barely happens today and should: **checking a championship for
mistakes before people show up to race.** The current championship has three
duplicate pit box assignments in the upcoming event's entry list, which is the
kind of thing nobody looks for until it bites.

---

## 2. Components

| Component | Runs as | Touches ACSM | Credentials |
|---|---|---|---|
| Web UI + backend | Node/TS service, separate host for now | Read + write | User's own, per session, never stored |
| Sanity checker | Library + CLI, also called by the other two | Read only | None (Public Access) |
| Discord bot | Separate process, same SQLite file | Read only | None, ever |
| Archive + stats | Ingest job plus public dashboards | Read only | None (Public Access) |

The credential split is deliberate. Only the interactive web UI can write to
ACSM, and only using the credentials of the person clicking the button. The bot
proposes; a human applies.

**Stack:** Node + TypeScript, SQLite (better-sqlite3), React + Vite, Luxon for
timezone maths, discord.js. One repo, three entry points.

**League defaults ship as a profile, not as code.** BATL's baseline lives in
`profiles/batl.json`; another league drops in their own. Anything that can't be
expressed in a profile is something that got hardcoded and shouldn't have —
useful as a design check throughout. BatlCtrl survives as the name of the BATL
deployment.

---

## 3. ACSM integration

### 3.1 Reads — documented API

Public Access is enabled on `ac.batlracing.com`, so these need no credentials:

- `GET /api/championships/list.json` — **build-dependent, so never assumed.**
  404 on 2.4.5 and on `ac.batlracing.com` itself, logged out or in, while
  `/api/results/list.json` beside it answers 200. The archive walked this
  endpoint, so it could not enumerate a single championship on the server it
  was built for. On the premium 2.4.15 harness it *does* answer, 200 with
  `{"championships":[…]}` — and with **lowercase keys**, `id` and `name`,
  where the export and the HTML scrape both use `ID` and `Name`. champctl read
  only the capitalised spelling, so on a build that has this endpoint every
  entry lost its id: the web UI's clone list was empty, `gridmom list` printed
  `?` per row, and the archive reported "no ID field" for the whole server.
  `HttpAcsmReader.listChampionships` normalises both spellings now.
  Championships are otherwise listed only by the server-rendered
  `/championships` page, which Public Access serves without credentials;
  `walkChampionshipIds` reads them from there.
- `GET /championship/{id}/standings.json`
- `GET /api/results/list.json?q=&page=&sort=`
- `GET /results/download/{filename}.json`
- `GET /race-control/penalties-log.json`
- `GET /healthcheck.json`

Rate limit is 5 requests per 20 seconds; the docs recommend staying under twice
a minute. Cache everything, and never poll on a timer tighter than that.

**Championship export works while logged out.** Confirmed against the live
manager. That is a bigger deal than it sounds, because the export is not just
configuration — completed events carry their full results inline at
`Events[].Sessions[].Results`:

- `Cars` — entrants with GUID, model, skin, ping range
- `Result` — finishing order with `GridPosition`, total time, penalties, DQ flag
- `Laps` — every lap with sector splits, tyre compound, cuts, track conditions
- `Events` — collisions with impact speed and world position
- `Penalties`, plus track, session type and date

So one unauthenticated HTTP request per championship yields a complete season:
config, entry list, results, laps and incidents. No correlation against the
results-file endpoints needed. This makes both the sanity checker and the stats
archive read-only, credential-free, and cheap.

### 3.2 Writes — form-driven

There is no write API. Writes mean driving the HTML forms with a cookie jar.
**Recon done — and simpler than expected: there is no CSRF token.** Login is a
plain `POST /login` with `Username`, `Password`, `RememberMe`; the session lives
in the `_acsm_data` cookie (signed, gorilla/securecookie style). `current-server`
holds the selected server index. No token scraping step is needed.

Re-verify this after any ACSM upgrade — a version that adds CSRF would break
every write silently.

Two distinct write paths, and they are not equally safe:

- **Create championship** — `POST /championship/import`, `multipart/form-data`,
  a single file part carrying the championship JSON. **Confirmed working** with
  a generated file. No CSRF token, no companion form fields: the request's
  content-length exceeded the JSON by 222 bytes, which is multipart framing and
  nothing else. The only detail still to read off the page is the file input's
  `name` attribute.
- **Edit one event** — `POST /championship/{champID}/event/submit` with
  `Editing={eventID}` and `action=saveChampionship`. This is the path used
  weekly.

**Important correction: this is a full-form replace, not a patch.** The POST
carries the entire event, including every entrant as repeated
`EntryList.*` keys. The browser preserves the entry list only because it
resubmits what the form was rendered with. A client that hand-builds a payload
will delete whatever it omits.

So the safe pattern is read-modify-write over the form itself:

1. `GET /championship/{champID}/event/{eventID}/edit?server=0`
2. Parse every input, select and checkbox into an ordered multimap (cheerio).
3. Mutate the handful of keys the vote decided.
4. POST the whole map back.

Use the form as the source of truth for writes and the JSON export as the source
of truth for reads and validation. Mapping the export's ~130 JSON fields onto
~200 form fields by hand is exactly where the bugs would live.

Two details that will bite an implementer:

- **Repeated keys are ordered and significant.** `EntryList.EntrantID`,
  `Cars`, `WeatherSessions` and `LegalTyres` all appear multiple times.
  `URLSearchParams` handles this; a plain object does not.
- **`EntryList.EntrantID` is the pit box.** There is no `PitBox` field in the
  form. The duplicate pit boxes gridmom found (3, 16, 27) appear here as
  duplicate `EntrantID` values, alongside gaps at 10, 19 and 22 — so the fix is
  reassigning three `EntrantID` values into the gaps.

**Hard rule:** never re-import over a championship that has any event with a
non-zero `StartedTime`. The emitter should refuse, not warn. Losing three weeks
of results to a convenience feature is the worst outcome this tool can produce.

### 3.3 Auth

Prompt for ACSM username and password. Backend performs the login, keeps the
resulting cookie jar server-side only (memory or Redis) with a 1–2 hour TTL,
and hands the browser a random session ID as an httpOnly/Secure/SameSite=Lax
cookie. Nothing is persisted to disk. Permissions are whatever ACSM says they
are — if the user can't write championships there, the write fails there.

The tool must be served over HTTPS, since it is forwarding admin credentials
between hosts.

### 3.4 Recon checklist (do this first)

Open devtools against the live manager and "Copy as cURL" for:

1. ~~The login POST~~ — done. `POST /login`, three fields, no CSRF.
2. ~~The **edit-event** POST~~ — done. Full-form replace, see above.
3. ~~The championship import POST~~ — done. `POST /championship/import`,
   multipart, one file part.
4. **The schedule-event POST.** Confirmed as a separate endpoint — scheduling
   is part of managing an event, distinct from championship settings. Still
   needs capturing; it is the one remaining unknown in the write path.
5. **The sign-up approve/reject POST** — see §5.3.
6. ~~Whatever XHR the event form uses to populate track/layout info~~ — done,
   and there is no XHR. The event edit form renders a `<select
   name="TrackLayout">` server-side carrying **every** track's layouts as
   `{track}:{layout}`, with `{track}:<default>` for a track that has none.
   Measured on 2.4.15: `<default>` is never mixed with real layouts.

   Nowhere else has them. `/tracks` lists tracks only; the track page builds
   `track-layout-wrapper` from JavaScript; `ui/meta_data.json` has a `layouts`
   key that was `{}` for a track the form said had three; and
   `/content/tracks/{id}/ui/` is a browsable directory whose contents are empty
   on `ac.batlracing.com` — `npm run recon:layouts` is the script that asked.

   So layouts cost a login, which is why `web/layouts.ts` reads them on the
   caller's session rather than in the credential-free content walk. Pit box
   counts are still not in there; they remain the `scan` source (§4.5).

---

## 4. Data model

### 4.1 Template + overlay

Do not model ACSM's championship schema. It is a large undocumented Go struct
that will drift across versions. Instead:

```
golden template (a real exported BATL championship)
  → league defaults          (the BATL baseline)
    → championship overrides        (car, tracks, name, schedule)
      → event overrides      (format, race length, quali timing — the voted bits)
        → emit
```

Deep merge, then regenerate every UUID so an import creates a new object rather
than colliding with an existing one.

Anything not explicitly modelled flows through untouched. That property is what
makes this survive ACSM upgrades.

**Regression test:** ingest a real export, re-emit with no overrides, diff.
Should be byte-identical modulo IDs. When an ACSM upgrade changes the schema,
this test tells you before a Wednesday does.

### 4.2 Race format

A tagged union, because both forms are legitimate and voted on:

```ts
type RaceLength =
  | { kind: "laps";    laps: number }
  | { kind: "minutes"; minutes: number }

type RaceFormat = {
  length: RaceLength
  reversedGridPositions: number   // 0 = single race, 5 = BATL default for 2x20
  mandatoryPit: boolean           // a league rule, not a server setting — see below
  extraLap: boolean
  note?: string                   // "voted 22 laps, 8/25" — audit trail
}
```

**`mandatoryPit` maps to `RacePitWindowStart`** — the lap the pit window opens,
set to `1` by BATL convention. Confirmed by Shoebacca and borne out across two
championships:

| | Format | `RacePitWindowStart` |
|---|---|---|
| Imola (RSS 4) | 1x40, mandatory pit | 1 |
| Suzuka (RSS 4) | 2x20 | 0 |
| All five Legends events | 2x20 | 0 |

So the field tracks the format exactly, and the emitter writes it from
`mandatoryPit` rather than leaving it alone.

One loose end: `RacePitWindowEnd` is `0` even when the window opens at lap 1.
Whether that reads as "never closes" or "no window at all" decides whether the
stop is server-enforced or an honour system. Testable against any completed
1x40: if a driver finished without pitting and took no penalty, it is not being
enforced. Worth knowing, but the emitter writes the same values either way.

If BATL ever wants harder enforcement, the `MandatoryLongPit*` family
(`Enabled`, `MinimumNumberOfLongPits`, `Duration`, `PenaltyWindow`,
`PenaltyType`) sits in the payload fully configured and switched off.

Presets (`1x40`, `2x20`) are just named starting points. Every field stays
editable, since the whole point is that the racers change them.

### 4.3 Session timing

Scheduling has one anchor and derives the rest. ACSM's `Scheduled` field is
**practice start**, not quali start — Suzuka is scheduled `19:00 -07:00` with a
60 minute practice ahead of an 8PM quali.

```
Scheduled = qualiStart − practiceDuration
```

The UI takes an anchor (usually quali start) plus durations and shows the
resulting chain:

```
practice 60m → quali 20m → race → Scheduled: 18:40 -07:00
```

Quali start is per-event, not a constant. A Nürburgring round might run quali
from 7:00 to 8:20, which moves both the start and the duration.

Championship level holds the default weekday and time (Wednesday, quali 20:00
`America/Los_Angeles`). Per-event overrides carry a reason field for holidays.
Compute in local wall-clock time and convert — November crosses a DST boundary
and the stored offset differs either side.

### 4.4 Entry list generation

**Multi-model championships are solved by a sentinel, not by preallocation.** Unclaimed
slots carry `Model: "any_car_model"`, and ACSM overwrites that with the driver's
chosen car when a sign-up is accepted. Confirmed from the October 2025 Legends
championship: five slots sat at `any_car_model` during round one and had become
a Nissan GT-R, two 911s, a Capri and a Pantera by round two.

So the generator emits *N* slots at `any_car_model` and lets sign-ups resolve
them. No per-model counts, no `DynamicClassSize`, no `FullRestartPractice`. That
championship ran ten available cars across seven models actually driven with both of
those settings off.

**Entry list types.** BATL runs a *locked* race entry list with a *partially
locked* practice list, both fed by the sign-up form:

| Value | Meaning | BATL |
|---|---|---|
| 0 | Unlocked — anyone connects to any slot | |
| 1 | Locked — only defined GUIDs connect | `EntryListType` |
| 2 | Partially locked — defined GUIDs hold their slot, anyone takes a free one | `PracticeEntryListType` |

**Both are championship-level fields, not `RaceSetup` ones.** Measured on a real
2.4.5 export of a championship champctl created: five events, 129 `RaceSetup`
keys each, neither field on any of them, and exactly one of each on the
championship object. Go marshals every struct field, so absent from `RaceSetup`
means not on that struct rather than merely unset.

champctl had them on `RaceSetup` everywhere — the type, BATL's
`baseline.raceSetup`, the emitter, and `signup.no-slot`, which gated on
`ev.RaceSetup.EntryListType` and therefore never fired on any real
championship. Nothing errored: ACSM dropped the keys the emitter put in the
wrong place, the checker found `undefined` where it looked, and every synthetic
fixture was written to agree. The visible symptom was a clone of a
locked-practice championship staying locked however the profile was set.

That combination is deliberate and worth preserving in the profile: the race is
exactly the people who signed up, while practice stays open to drop-ins on any
unclaimed slot. It also explains the blank-name slots in the entry list — under
a locked race list nobody can use them on race night, but under a partially
locked practice list they are exactly what a drop-in connects to.

Two consequences for gridmom: an accepted sign-up missing from the entry list
means someone who cannot join the race, and the *claimed* slot count rather than
the total is what fills the grid.

**Entry list length is not the grid cap.** BATL deliberately oversubscribes: 30
slots and 29 accepted sign-ups against `MaxClients: 18`, on the assumption not
everyone shows. Two independent numbers:

- **entry list length** — how many people may hold a place in the championship.
  A league policy, not a track constraint.
- **`MaxClients`** — how many cars can be on track, capped by pit boxes.

The pit-count requirement drives `MaxClients` only. Sizing the entry list to the
smallest track would lock people out of the championship for a constraint that
only applies on one night.

### 4.5 Track pit counts

The tool runs off-host, so `content/tracks/*/ui/*/ui_track.json` isn't
reachable. Table `track_pits(track, layout, pitboxes, source, verified_at)`
where source is `acsm` | `scan` | `manual`, manual always winning.

- **acsm** — whatever the event form's track XHR returns.
- **scan** — a one-off script run against a local AC install, emitting a JSON
  blob uploaded to the tool. Probably the most reliable source, since BATL runs
  mod tracks.
- **manual** — override, for when the ui file lies. It often does on mods.

Grid maths:

```
MaxClients ≤ min(pitboxes across selected tracks)
```

**Corrected: the spectator car is not subtracted.** This said
`− spectatorCars`, on the reading that a car on the grid needs a box. BATL,
who run a Ford Transit in every race for the stream, say it occupies nothing —
it is an observer, and their pits have clipping off besides. Subtracting for it
capped every generated championship one car below what the track allows.

Entry list length is set separately by league policy — see §4.4.

---

## 5. Flows

### 5.1 Create a championship

1. Name, car class, calendar month it covers.
2. Pick tracks, drag to order. Each becomes a race night.
3. Schedule generates from the weekday/time rule; per-row date override with a
   note.
4. Format defaults applied per event, editable.
5. Review screen: computed grid cap with the binding track named ("capped at 24
   by Brands Hatch Indy"), plus full sanity check output.
6. Diff preview against the golden template.
7. Push.

"Clone the previous championship" should be the prominent path — it will be the most used.

### 5.2 Finalize a race (the weekly one)

1. Open the upcoming event.
2. Set race length, reversed grid, quali timing — usually from a poll result.
3. Sanity check runs automatically, inline.
4. Diff preview: exactly which fields change, old → new.
5. Push via the edit-event form. Nothing else in the championship is touched.

Target: under a minute, on a phone, from a Discord poll result.

Note this is two requests, not one: the event submit form does not carry
`Scheduled`. Changing quali time means an event save *and* a schedule save.

### 5.3 Approving sign-ups

Currently a trip into ACSM on its own. The data is already in the export:
`SignUpForm.Responses[]`, each carrying `Created`, `Name`, `GUID`, `Team`,
`Email`, `Car`, `Skin`, free-text `Questions` and a `Status` of Accepted,
Rejected or pending. Rejected records are retained rather than deleted.

A queue screen with approve/reject, and bulk approve for the usual case. The
archive earns its keep here: show each applicant's history next to the request —
rounds raced, finishes, whether they are new to the league — so the decision has
context that ACSM cannot offer.

**Approval mutates the entry list**, which makes it the one read-only-looking
action that changes the grid. Two things follow.

First, run the relevant checks *before* committing: is there a free slot, does
this exceed `MaxClients`, does the chosen skin collide where duplicates are
disallowed.

Second, and more important: **the event edit form is a full-list replace, so an
approval landing between form fetch and form POST will be silently reverted.**
Someone approves a driver in ACSM while the tool has an edit screen open, the
tool saves, and the new entrant vanishes with no error anywhere. Mitigation:
re-fetch the form immediately before POST and compare its entry list against the
one fetched when the screen opened. If it changed, refuse the write and reload.
This is the most likely way champctl could destroy data while appearing to work.

**Privacy note.** Sign-up responses are inside the export, and the export is
public. Names, Steam GUIDs, chosen cars and free-text answers are readable by
anyone without logging in. Nothing to fix in ACSM necessarily, but the archive
should strip `SignUpForm.Responses` before anything reaches a public dashboard,
and the `AskForEmail` option should stay off for that reason.

New recon item: capture the approve/reject POST.

### 5.4 Import test

`champctl-import-test-2027.json` is a first cut at the emitter: BATL's export
as template, fresh UUIDs throughout, two events dated March 2027, four anonymous
placeholder entrants at pit boxes 0–3, `MaxClients` 4. Discord, ACSR, the
sign-up form and the spectator car are all disabled so nothing can reach the
league, and no real Steam GUIDs remain in the file.

The second event carries `ReversedGridRacePositions: 5` so the round-trip covers
the 2x20 case too.

**Result: imported successfully.** That closes the create path — a
programmatically generated championship is accepted as-is.

**Round-trip diff: ACSM is very nearly faithful.** Re-exporting the imported
championship gives back what was sent, with four exceptions:

| Field | Sent | Returned |
|---|---|---|
| `Version` | 0 | 2 |
| `Updated` | template value | import time |
| `ScheduledServerID` | `""` | the server's UUID |
| `PracticeEntryListType` | 2 | 1 |

The first three are ACSM housekeeping and belong on the round-trip test's ignore
list. **The fourth is a silent value change and should not be allowlisted until
it is understood** — something in ACSM rejected "partially locked" for practice
and rewrote it. If that happens to a field that matters, the same mechanism will
quietly change a race.

**UUIDs are preserved exactly as sent.** Championship ID, class ID and both
event IDs came back unchanged. That makes the never-import-over-a-live-ID rule
load-bearing rather than precautionary: re-importing an unmodified export
overwrites the championship it came from. The emitter must generate fresh UUIDs,
and should refuse an import whose ID already exists on the server.

`Scheduled` survived intact with its `-08:00` offsets, as did `MaxClients`,
`ReversedGridRacePositions: 5`, and the per-event race length in both minutes
and laps.

### 5.5 Emitter bugs the diff exposed

All of these were in the generated file, not in ACSM:

- **`Created` was inherited from the template**, so the test championship claims
  to have been created a month before it existed. The emitter must set it.
- **`RaceSetup.Cars` still listed `ford_transit`** — the spectator car's model —
  despite the spectator car being disabled. `Cars` is a semicolon-joined string
  that must be *derived* from the class `AvailableCars` plus the spectator model
  when enabled, never inherited from the template.
- **`ExportSecondRaceToACSR` was true while ACSR was off.** Harmless here, but
  it is the kind of contradiction gridmom should catch.
- **`SignUpForm.ExtraFields` kept BATL's Discord-username question** on a
  championship with sign-ups disabled.

Note that entrant `InternalUUID`s legitimately differ between a class entrant
list and each event's entry list — checked against a real championship, where
none of the 30 slots share a UUID across the two. They are per-list identities,
not a join key, and `CAR_n` is what lines them up.

This whole exchange is the first fixture for the round-trip regression test in
§4.1 and should live in the repo as `fixtures/import-roundtrip/`.

---

## 6. Championship sanity checker — "gridmom"

The checker has a name and a voice, because the nightly Discord report is only
useful if people read it instead of muting it:

> **gridmom:** Suzuka has duplicate pit boxes at 3, 16 and 27. Also nobody set
> the lap count.

Nagging, specific, never mean. Findings should be phrased as one plain sentence
naming the thing and where it is — no severity jargon in the Discord output,
even though the underlying model has severities.

A pure function from a championship JSON (plus the track pit table and league
baseline) to a list of findings. No network, no side effects — which means it
can run in the web UI before a push, on demand against any championship, and
nightly from the bot.

Three severities:

- **ERROR** — will produce a broken or unfair race. Blocks push.
- **WARN** — probably wrong, needs a human to confirm. Push requires an
  acknowledgement.
- **INFO** — differs from the league baseline. Expected in a league that votes
  on everything; shown but never blocking.

### 6.1 Entry list and grid

| Check | Severity |
|---|---|
| Duplicate `PitBox` within a class entrant list or any event entry list | ERROR |
| `MaxClients` > pit boxes at that track | ERROR |
| `PitBox` value ≥ track pit count | ERROR |
| Entrant `Model` not in the class `AvailableCars` | ERROR |
| Event entry list differs from the championship class entry list | WARN |
| Duplicate race numbers | WARN |
| Duplicate skins, for a league that says it wants unique ones | WARN |
| Accepted sign-ups exceed available slots | WARN |
| Entry list length differs between events | WARN |
| Accepted sign-ups exceed total entry list slots | WARN |
| Accepted sign-up has no entry list slot (cannot join a locked race) | WARN |
| Unclaimed slot in a multi-model class not set to `any_car_model` | WARN |

The entry list is duplicated in five places — the class plus each event — so
cross-event comparison is doing real work here.

### 6.2 Schedule

| Check | Severity |
|---|---|
| `Scheduled` ≠ qualiStart − practice duration (report the computed value) | WARN |
| Event lands on a weekday other than the championship default, with no override note | WARN |
| Two events scheduled on the same night | WARN |
| Event scheduled in the past but never started | WARN |
| `ScheduledServerID` empty while other events have one | WARN |
| Scheduled time crosses a DST boundary relative to the rest of the championship | INFO |

### 6.3 Format

| Check | Severity |
|---|---|
| RACE session has both `Time` and `Laps` non-zero, or both zero | ERROR |
| Format has a mandatory pit but `RacePitWindowStart` is 0 | WARN |
| Format has no mandatory pit but `RacePitWindowStart` is set | WARN |
| `ReversedGridRacePositions` > 0 but `SecondRaceMultiplier` is 0 | WARN |
| Estimated race duration wildly off the intended target for the lap count | INFO |
| `RaceExtraLap`, quali length, etc. differ from league baseline | INFO |

The pit window pair is the mandatory-stop switch, so these two checks are really
one: does the pit window agree with the declared format? Getting them out of
step is the likeliest way a 1x40 quietly runs without its stop.

### 6.4 Content

| Check | Severity |
|---|---|
| Track or layout not installed on the server | ERROR |
| Car model not installed | ERROR |
| Skin missing for a model | WARN |
| Pit count for a selected track is unknown or unverified | WARN |
| A track with layouts has none set (`content.track-layout-unset`) | WARN |
| The layout set is not one the track has (`content.track-layout-unknown`) | WARN |

The two layout checks need the layout index, which costs a login (§3.4), so
they skip when nobody could read it. WARN rather than ERROR because a round in
this state still runs — BATL completed a practice session on one — but it runs
somewhere nobody chose, and ACSM shows no track image for it. Both shapes were
produced by champctl itself: the unset one by a clone made before the create
screen asked for a layout, the unknown one by every event save made before
`acsm/event-form.ts` (see `docs/acsm-write-path.md` §15). The repair is on the
round screen, which is where the warning appears.

### 6.5 Championship level

| Check | Severity |
|---|---|
| `IgnoreXWorstEvents` ≥ number of events | WARN |
| `Points.Places` shorter than `MaxClients` (drivers who can score nothing) | WARN |
| Same track appears twice in a championship | WARN |
| `ExportSecondRaceToACSR` set while ACSR is disabled | INFO |
| Tracks named in the description don't match the event list | INFO |
| `StartNextPracticeOnEventComplete` disabled | WARN |
| Sign-up form enabled with a registration deadline already past | INFO |
| ACSR gates enabled with no gate values configured | INFO |

### 6.6 Where it runs

- Inline in the web UI, before every push.
- On demand against any championship ID.
- Nightly from the bot, posting only ERROR and WARN into a Discord admin
  channel. A message at T-2 days saying "Suzuka has duplicate pit boxes at 3,
  16 and 27" is most of this tool's value for a fraction of the work.

---

## 7. Discord bot

**No ACSM credentials. Ever.** Reads go through the public API. Writes do not
happen — the bot produces a proposal, and a human applies it in the web UI
under their own login.

What it does:

- **Polls.** Posts the week's format vote (race length options, 1x40 vs 2x20),
  collects reactions or a native poll, closes on a deadline. On close it writes
  the result into the tool's database as a *pending proposal* and posts a link:
  "18 laps won — apply to Suzuka." Clicking it opens the finalize screen with
  the fields prefilled.
- **Announcements.** From the tool's own schedule table, not ACSM. Sign-up link,
  track, format, quali time.
- **Standings.** After a race, formatted standings from
  `/championship/{id}/standings.json`. ACSM's built-in Discord integration is
  already enabled on the championship, so this should complement it rather than
  duplicate event alerts.
- **Nightly sanity report** into an admin channel, in gridmom's voice.
- **Stat lookups** — `/stats @driver`, `/record <track>`, head-to-head, served
  from the archive in §8.
- **New sign-up alerts** into the admin channel, with a link into the approval
  queue. A link, not a button — the bot never holds write credentials.

The poll-to-proposal loop is the piece that makes the voting model cheap to
run. It turns "someone reads the poll, opens ACSM, remembers which of 130
fields to change" into one click plus a login.

---

## 8. Archive and stats

postaL's idea, and the export format makes it nearly free. ACSM shows standings
within a single championship and nothing across them. Every question a league
actually argues about — most wins, most championships, who has never finished
outside the points at Spa — needs history that ACSM does not keep.

### 8.1 Ingest

A job that walks `/api/championships/list.json`, fetches each championship
export, and stores the raw JSON verbatim, keyed by championship ID and fetch
time. Space the requests to stay under the rate limit; a nightly run of a dozen
requests is nothing.

**Keep raw JSON immutable and treat the stats tables as a projection.** When a
stat definition changes, or two driver identities get merged, re-derive from
scratch rather than migrating. Rebuilds should be a single command that takes
seconds.

This also gives you an offline copy of every championship the league has ever
run, which is worth having on its own the first time something gets deleted by
accident.

### 8.2 Driver identity

The one genuinely hard part. Drivers are keyed by Steam GUID in the results,
but display names change constantly, and `GuidsList` exists because a driver can
have more than one.

- Canonical `driver` table with a stable internal ID.
- `driver_guid` mapping table, many GUIDs to one driver.
- Names are display data attached to appearances, never a join key. Keep the
  history — "known as" is itself a fun stat.
- A small admin merge UI. It will be needed maybe twice a season, and doing it
  by hand in SQL is fine for v1.
- Exclude the spectator car from every stat.

### 8.3 What to compute

Straight from the embedded results, no extra sources:

**Career** — starts, wins, podiums, poles, fastest laps, championships won,
points scored, average finish, finish rate, DNFs, best and worst weekends.

**Per track** — lap record by car, average finish, appearances, who owns each
sector.

**Season** — points progression by round, positions gained and lost from
`GridPosition` versus finish, laps led if derivable, attendance streaks.

**Head-to-head** — two drivers, every race they both entered, who finished
ahead. This is the one people will actually use.

**Incidents** — collision counts and impact speeds per driver over time. Handle
with care; it is useful for stewarding and obnoxious as a leaderboard. Consider
admin-only.

**Fun** — most different skins used, longest streak of finishing in the same
position, worst qualifier who still won.

### 8.4 Dashboards

Public, read-only, no login, since the underlying data is already public. Same
Node service, separate route tree, or a static build regenerated after each
ingest. Driver pages, track pages, a season page, an all-time leaderboard.

### 8.5 Feedback into the tool

The archive is not only for dashboards. Having every past championship parsed
makes the creation and finalize flows smarter:

- "Last time at Mugello: 22 laps, 15 minute quali, average race 41 minutes" —
  shown inline when setting this week's format, and useful as the source of
  poll options.
- Estimated race duration for a proposed lap count, from actual historical lap
  times at that track in that car. Turns the §6.3 INFO check from a guess into
  a real number.
- Which tracks the league has already run this year, to avoid repeats.

## 9. Build order

Sequenced so value lands early and risk lands late.

**Phase 0 — Recon.** Capture the cURLs from §3.4. Export a championship.

**Phase 1 — Sanity checker (gridmom).** Pure function plus CLI. Read-only, zero risk to
production, and it already has a real bug to catch. Ship it as a cron job
posting to Discord before anything else exists.

**Phase 1b — Archive ingest.** Same read client, same zero risk. Start hoarding
exports immediately — every week you wait is a week of history you may not be
able to reconstruct later.

**Phase 2 — ACSM client, write path.** Login, CSRF, edit-event POST. Test
against a scratch championship. Prove it round-trips before building UI.

**Phase 3 — Finalize-a-race UI.** The weekly flow, mobile-first, with diff
preview. This is the first thing that saves anyone time. The sign-up approval
queue belongs here too — same write mechanics, same session, and it removes the
other recurring reason to open ACSM.

**Phase 4 — Create-a-championship UI.** Template, overlay, schedule generator, pit
table, clone-the-previous-championship.

**Phase 5 — Bot reads.** Announcements and standings.

**Phase 6 — Polls and proposals.** The loop that closes the whole thing.

**Phase 7 — Stats dashboards.** Driver and track pages on top of the archive,
plus the historical hints feeding back into the finalize flow.

Moving the service onto the ACSM host later means swapping the ACSM client and
the pit-count source for filesystem-backed implementations. Keep both behind
interfaces from day one so that's a config change, not a rewrite.

---

## 10. Open questions

- ~~How the 1x40 mandatory stop is configured~~ — answered:
  `RacePitWindowStart`, set to 1. Only the meaning of `RacePitWindowEnd: 0`
  remains open, and nothing in the emitter depends on it.
- ~~`SignUpForm.DynamicClassSize`~~ — moot. A ten-car championship ran fine with it
  off; `any_car_model` is the actual mechanism. Still unknown what it does, but
  nothing depends on the answer.
- ~~`FullRestartPractice`~~ — resolved. It stays off, and nothing needs it:
  `any_car_model` slots absorb late sign-ups regardless of chosen car. The only
  real limit is total slots.
- ~~`EntryListType` / `PracticeEntryListType` enum~~ — answered: 1 is locked,
  2 is partially locked, and both live on the championship rather than on
  `RaceSetup`. See §4.4.
- ~~Why `PracticeEntryListType` came back as 1 having been sent as 2 (§5.4)~~ —
  at least partly answered by the above: champctl was writing it onto every
  event, where ACSM has no such field to read. Whether the championship-level
  value is *also* rewritten is still open, and now testable against the
  harness by sending 2 in the right place.

---

## 11. Fix now, outside the tool

The Suzuka event's entry list has duplicate pit boxes at **3, 16 and 27**, and
the championship class list has duplicates at **9 and 10**. Whoever sets the
lap count this week is already in that form.
