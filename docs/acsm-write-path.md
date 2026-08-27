# ACSM write path — what the source actually says

Read off `JustaPenguin/assetto-server-manager` at `master` (v1.7.9, the public
build). Everything here needs re-confirming against the premium build BATL
runs, which is exactly what `docker/` is for — but source beats guessing, and
three of these findings change what the client has to do.

Re-check all of this after any ACSM upgrade.

---

## 0. Which version answers which question

BATL runs **2.4.5**. The public source above is **1.7.9**. Those are far enough
apart that a harness built from a 1.7.x zip settles some questions and not
others, so it's worth being explicit about which.

**Server Manager does not update itself.** Its own release notes describe
upgrading as: back up the database, download the release, replace the binary.
The auto-update in the config is `steam.force_update`, and that updates the
*Assetto Corsa dedicated server* via steamcmd — a different program. A harness
built from a 1.7.8 zip stays 1.7.8 however long it runs.

A 1.7.x harness **does** settle:

- Whether champctl's own machinery works end to end — login, cookie jar, form
  parse, mutate, POST, re-export, diff. This is most of the risk in the client,
  and none of it is version-specific.
- The shape of the round-trip: which fields ACSM rewrites on import, whether
  UUIDs are preserved, whether `PracticeEntryListType` really gets rewritten.
- Whether duplicate pit boxes lose entrants on import (§3). `AddInPitBox` is
  old, load-bearing code; a change there between 1.7 and 2.4 would be
  surprising.
- That the safety rails fire — ragged payloads refused, results-bearing imports
  refused.

A 1.7.x harness **cannot** settle, because the answer is what changed:

- **Whether `EntryList.EntrantID` is rendered on the championship event form**
  (§2). This is the headline question, and 1.7.9 is exactly the version where
  the answer is "no". Getting "no" from a 1.7.8 harness tells you nothing about
  2.4.5 — it just reproduces what the source already says.
- Whether the three premium read endpoints exist and what they return (§6).
  1.7.x predates them.
- Any field added to the event form between 1.7 and 2.4, which is the main way
  a hand-built payload would silently drop settings.

So: run 1.7.8 now to prove the tooling, and treat every §2 and §6 answer it
gives as provisional until 2.4.5 is in the harness. `npm run recon:forms`
records the version it captured against, so a 2.4.5 run produces a diff rather
than a replacement.

---

## 1. The entry list is parsed strictly by position

`RaceManager.BuildEntryList` (`race_manager.go`) walks a single index `i` across
every `EntryList.*` form key:

```go
for i := start; i < start+length; i++ {
    model := r.Form["EntryList.Car"][i]
    skin  := r.Form["EntryList.Skin"][i]
    ...
    e.Name = r.Form["EntryList.Name"][i]
    e.Team = r.Form["EntryList.Team"][i]
    e.GUID = NormaliseEntrantGUID(r.Form["EntryList.GUID"][i])
```

So the repeated keys are not just ordered-and-significant, they are *parallel
arrays*. Every `EntryList.*` key must appear the same number of times, in the
same order. Drop one value from one key and every entrant after it takes on
another entrant's data — no error, no warning.

Note the unguarded indexing on `EntryList.Car`, `Skin`, `Name`, `Team`, `GUID`,
`Ballast`, `Restrictor`, `FixedSetup` and `InternalUUID`: a short array there is
an index-out-of-range panic in ACSM, not a validation message.

**Consequence for champctl:** build the POST body by round-tripping the rendered
form, never by assembling it from the JSON export. This is the plan's §3.2
read-modify-write rule, and the source is why it isn't optional.

Counting those keys against each other catches a *short* array but not an
absent one: drop a key entirely and the nine that remain still agree, so there
is nothing to disagree with. `REQUIRED_ENTRY_LIST_FIELDS` in `src/acsm/form.ts`
lists the keys named above, plus `EntryList.EntrantID` from §2, and a POST
carrying entrants without all of them is refused.

## 2. Omitting `EntryList.EntrantID` silently renumbers every pit box

```go
// The pit box/grid starting position
if entrantIDs, ok := r.Form["EntryList.EntrantID"]; ok && i < len(entrantIDs) {
    e.PitBox = formValueAsInt(entrantIDs[i])
} else {
    e.PitBox = i
}
```

`EntryList.EntrantID` is the pit box, as the plan says. But the `else` branch is
the part that matters: **when the key is missing, the pit box becomes the loop
index.** A client that omits it doesn't leave pit boxes alone — it reassigns
every entrant to its position in the list.

**Measured on 1.7.9: the field IS rendered, 24 times for 24 entrants.** Pit
boxes round-trip; a form save does not renumber them.

I had predicted the opposite from the template condition:

```html
{{ if and (not $.IsChampionship) (not $.IsSpectatorCar) }}
    <input type="number" name="EntryList.EntrantID" ...>
{{ end }}
```

That reading was wrong. `$.IsChampionship` is false on the *event* edit page —
the flag for that context is `$.IsChampionshipEvent`, which the same template
uses separately to make Name, Team and GUID readonly. `IsChampionship` marks the
championship-level class entrant list instead. So the condition excludes the
class list, not the event form.

Two things worth keeping from being wrong about it:

- The `else` branch above is still real and still dangerous. Any client that
  omits the key renumbers every pit box, whether or not the form renders it.
  champctl round-trips whatever the form gives it, so this is safe by
  construction rather than by luck.
- **Still unverified on 2.4.5.** 1.7.9 renders it; that is one data point about
  a build BATL doesn't run. `npm run recon:forms` reports the count, so a run
  against 2.4.5 settles it.

## 3. Duplicate pit boxes delete entrants

`EntryList.AddInPitBox` (`entrylist_ini.go`), which `BuildEntryList` calls for
every entrant:

```go
// AddInPitBox adds an Entrant in a specific pitbox - overwriting any entrant
// that was in that pitbox previously.
func (e EntryList) AddInPitBox(entrant *Entrant, pitBox int) {
    pitBoxKey := fmt.Sprintf("CAR_%d", pitBox)
```

So `CAR_n` **is** the pit box, and two entrants sharing one overwrite each other
— last write wins, the other is gone.

That reframes the duplicate pit boxes gridmom found. They aren't only "an unfair
race": the next time anyone saves that event form, three drivers are silently
deleted from the entry list. gridmom says so now.

It also explains how an export can contain duplicates at all. The export's map
key and the entrant's own `PitBox` field can disagree, because an *imported*
championship writes the map directly without going through `AddInPitBox`. BATL's
Suzuka event has entrants sitting in map slots 10, 19 and 22 whose `PitBox`
values are 3, 16 and 27. Check the `PitBox` field, not the key — which is what
`entry.duplicate-pit-box` does.

## 4. Repeated bare checkboxes — not the bug this said it was

`EntryList.OverwriteAllEvents` and `EntryList.TransferTeamPoints` are rendered as
plain checkboxes with no hidden partner field, once per entrant, and read
positionally:

```go
if r.Form["EntryList.OverwriteAllEvents"] != nil &&
   i < len(r.Form["EntryList.OverwriteAllEvents"]) &&
   formValueAsInt(r.Form["EntryList.OverwriteAllEvents"][i]) == 1 {
```

**Corrected.** This section used to conclude that the feature cannot work: a
browser omits unchecked boxes, so ticking the box on the 12th entrant sends one
value at index 0 and ACSM applies it to the *first* entrant.

That is true of a plain browser and false of this one. ACSM installs a global
submit handler that rewrites **every** checkbox before the form is serialised —
checked becomes `value="1"`, unchecked is replaced by a hidden `0`:

```js
$("form").submit(function () {
  $(this).find('input[type="checkbox"]').each(function () {
    t.is(":checked") ? t.attr("value", "1")
                     : (t.after().append(t.clone().attr({type: "hidden", value: 0})),
                        t.prop("disabled", true))
  })
})
```

So a real browser sends all N values, correctly paired, and the positional read
above is fed exactly what it expects. The `formValueAsInt(...) == 1` in that
snippet is the other half of the same story: ACSM's Go side has never been
given the browser default `on`, and reads it as false.

**Consequence for champctl**, and it is much broader than these two keys:
`parseForm` emits `1`/`0` for every checkbox on the page. Echoing a form back
the browser-standard way turned off every box that was on — measured on 2.4.5,
a single finalize took an event from three sessions to none while reporting
success. See `docs/acsm-2.4.15.md` §5.

champctl still strips these two per-entrant keys before POST, which is
unchanged behaviour and safe: absent reads as false for everyone. Sending them
faithfully is now possible and would preserve a genuinely ticked one, and wants
measuring against a live manager before it changes.

## 5. Endpoints confirmed present in the public build

From `router.go`:

| Endpoint | Method | Notes |
|---|---|---|
| `/login` | POST | `Username`, `Password`, `RememberMe`. No CSRF token. |
| `/healthcheck.json` | GET | Outside every auth group — the right readiness probe. |
| `/championship/{id}/export` | GET | Read access. The whole read side depends on this. |
| `/championship/import` | GET/POST | Write access, multipart. |
| `/championship/{id}/event/submit` | POST | Write access. The weekly path. |
| `/championship/{id}/event/{eventID}/edit` | GET | Renders the form to round-trip. |
| `/championship/{id}/event/{eventID}/schedule` | POST | **Recon item 4, found.** Scheduling is its own endpoint, so a quali time change is two requests. |
| `/championship/{id}/entrant/{entrantGUID}` | GET | **Recon item 5, found — and it's a GET, not a POST.** |
| `/championship/{id}/entrants` | GET | The sign-up queue. `.csv` variant too. |
| `/content/tracks/{track}/ui/ui_track.json` | GET | **Recon item 6, found.** |
| `/content/tracks/{track}/ui/{layout}/ui_track.json` | GET | Per-layout. The `acsm` pit-count source. |

## 6. Endpoints NOT in the public build

`/api/championships/list.json`, `/championship/{id}/standings.json` and
`/race-control/penalties-log.json` appear nowhere in the public `router.go`,
while BATL's manager serves all three. That is good evidence BATL runs the
premium build, and it means:

- The harness on the public image cannot exercise `AcsmReader.listChampionships`
  or `standings`. Those stay verified against live BATL only.
- Any league on the public build gets a champctl that can check a championship
  by ID but can't discover them. `gridmom list` should fail with something
  better than a JSON parse error there.

## 7. The Assetto Corsa server is a Windows-only depot

Worth writing down because it's counter-intuitive and cost an afternoon.

Appid 302550 ("Assetto Corsa Dedicated Server", type `Tool`) publishes exactly
one depot, 302551, and its config says `oslist: windows`. There is no Linux
depot. The Linux `acServer` binary ships *inside* the Windows one.

So anything downloading it on Linux has to ask for the Windows platform.
Server Manager's own installer does exactly that (`server_install.go`):

```go
"+@sSteamCmdForcePlatformType windows",
fmt.Sprintf("+login %s %s", login, password),
"+app_update " + assettoServerSteamID,   // 302550
```

Ask for Linux instead and you get `Couldn't find any depots to download for app
302550`, which reads like a permissions problem and isn't.

Two consequences for the harness:

- `docker/steam-login.sh` passes the same `@sSteamCmdForcePlatformType windows`.
- `docker/steam-login-qr.sh` passes `-os windows` to DepotDownloader, and
  `chmod +x` afterwards — DepotDownloader writes default permissions, so the
  Linux binary arrives without its executable bit and Server Manager would
  conclude nothing is installed.

Also note the account needs to own Assetto Corsa. Anonymous gets:

```
ERROR! Failed to install app '302550' (No subscription)
```

## 8. Login: judge the redirect, not the cookie

`AccountHandler.login` (`accounts.go`) does exactly three things with a POST:

```go
case err == ErrInvalidUsernameOrPassword:
    AddErrorFlash(...)                                    // falls through, renders login.html, 200
case err == ErrAccountNeedsPassword:
    http.Redirect(w, r, "/accounts/new-password", 302)
default:                                                  // success
    http.Redirect(w, r, "/", 302)
```

So a wrong password is a **200 with the login page**, not a 401, and success is
a **302**. That's the stable signal across versions.

The session cookie name is not. 2.4.5 calls it `_acsm_data`; the 1.7.x login
form doesn't even have the `RememberMe` field 2.4.5's does. champctl briefly
judged success by `_acsm_data` being set, which reported a perfectly good 1.7.8
login as `Login as admin failed`. Extra form fields are harmless — Go ignores
what it doesn't read — so sending `RememberMe` anyway is fine.

The 1.7.9 login form is exactly:

| Field | |
|---|---|
| `Username` | text |
| `Password` | password |

## 9. Import is a textarea in 1.7.9, a file upload in 2.4.5

`import-championship.html` at 1.7.9:

```html
<form method="post" action="/championship/import">
    <textarea id="import" name="import" placeholder="Paste your championship JSON here!"></textarea>
    <button type="submit">Save</button>
</form>
```

and the handler reads it with a single `r.FormValue("import")`. No file input,
no `multipart/form-data`. 2.4.5 takes a multipart upload instead — plan §3.2
confirmed that against BATL, measuring the request as 222 bytes over the JSON,
which is multipart framing.

Note `r.FormValue` reads `r.Form`, and Go puts multipart *files* in
`r.MultipartForm.File`, not `r.Form`. So a file upload to 1.7.9 isn't merely
unsupported, it silently reads as an empty string.

Failure is invisible from the response: on a bad import ACSM adds a flash and
re-renders the page with a **200**, so there is no status code to check. Only
the redirect to `/championship/{id}` means success.

So champctl reads the mechanism off the form rather than assuming
(`detectImportMechanism`): a file input means multipart with that field name, a
textarea means urlencoded with that field name, neither means say so loudly.

Two related traps:

- **Pick the form by action, not position.** Every ACSM page carries a navbar
  search form, so "the first form on the page" is that one. Taking it is why
  recon first reported `fileField=NOT FOUND` with
  `enctype=application/x-www-form-urlencoded` — it was describing the search box.
- The version is worth recording alongside any capture, since this is exactly
  the sort of thing that differs. `recon:forms` writes
  `fixtures/recon/forms-<version>.json`.

## 10. Session keys are `PRACTICE` / `QUALIFY` / `RACE`

`SessionType` is a Go string type, and its constants are not the friendly words
(`config_ini.go`):

```go
type SessionType string

const (
    SessionTypeBooking    SessionType = "BOOK"
    SessionTypePractice   SessionType = "PRACTICE"
    SessionTypeQualifying SessionType = "QUALIFY"
    SessionTypeRace       SessionType = "RACE"
)
```

Both `RaceSetup.Sessions` and the event's `Sessions` are
`map[SessionType]...`, so an unrecognised key is **not an error** — it just
never matches. champctl originally looked up `"Race"`, which meant every §6.3
format check quietly found nothing and passed. Silence, not a crash.

Read sessions through `session()` / `eventSession()` in `view.ts`, which resolve
either spelling. `sessionKeysUsed()` reports the literal keys an export used,
and recon prints them.

## 11. Seed round-trip work from a real export

`ImportChampionship` is one `json.Unmarshal` into the whole `Championship`
struct, so a single type mismatch anywhere rejects the entire import — and the
only feedback is a flash reading "Check your JSON formatting" on a 200.

That makes a hand-written fixture a poor seed: it encodes a guess at one
version's struct. An export from the server you're testing is the right shape
by construction. `seedChampionship()` copies an existing championship — ACSM
ships example ones — regenerates its UUIDs, strips results and switches off
anything that could contact a league. The synthetic fixture is only a fallback
for a genuinely empty server.

This is also what plan §4.1 asks for: ingest a real export, re-emit, diff.

## 12. Measured against 1.7.9

First real harness run, `npm run recon:forms` / `recon:roundtrip`. Everything
here is 1.7.9 and needs re-running on 2.4.5 before BATL depends on it.

**Session keys:** `PRACTICE`, `QUALIFY`, `RACE`. As §10 predicted, and the
reason gridmom's format checks were silently inert.

**`EntryList.EntrantID`:** rendered, 24 for 24. See §2 — my prediction was
wrong.

**`EntryList.NumEntrants`:** a form-level count, one occurrence alongside the
24-long arrays. Not something the source reading turned up. It made
`checkEntryListShape` call every legitimate payload ragged, which would have
blocked every write.

The first fix was to exempt any `EntryList.*` field appearing exactly once.
That was wrong, and is no longer what the code does: a two-entrant payload that
has lost one value also leaves that key with a count of one, so the rule
exempted precisely the truncation the check exists to catch. It now fails
closed. Only the keys named in `NON_ARRAY_ENTRY_LIST_FIELDS` —
`OverwriteAllEvents`, `TransferTeamPoints`, `NumEntrants` — are exempt, and any
other `EntryList.*` key whose count disagrees with the rest blocks the POST,
whatever that count is.

The cost is that a **new** form-level scalar in a later ACSM build will block
writes until someone adds it to that list. That is the intended trade: wrong in
this direction costs a diagnosis, wrong in the other costs an entry list. If
you hit it, confirm the field really is form-level and not per-entrant before
adding it — §1 has what a ragged POST does to ACSM.

**Schedule form** (recon item 4, closed). Fields are hyphenated rather than
Go-style:

```
event-schedule-date
event-schedule-time
event-schedule-timezone
event-schedule-recurrence
```

posted to `/championship/{id}/event/{eventID}/schedule`. A separate request from
the event save, so changing a quali time is two writes (plan §5.2). Note
`recurrence` — scheduled events can repeat, which champctl doesn't model yet.

**Round trip:** faithful. Seven raw differences, all explained:

| | |
|---|---|
| `Created` `...58.140Z` → `...58.14Z` | Go trims trailing zeros from fractional seconds |
| `Events[n].Sessions` `{}` → absent | `json:",omitempty"` on an empty map |
| `ExportSecondRaceToACSR` `false` → absent | `omitempty` on a false bool |
| `Description` → absent | **1.7.9's `Championship` struct has no `Description` field.** Sent non-empty, dropped on unmarshal. |

The diff understands the first three now (`omitEmpty`, `timestampsAsInstants`),
so only real losses are reported. The `Description` drop is the interesting one:
it's how a field that doesn't exist in a given build shows up, and it's exactly
what the emitter needs to know before it writes anything.

**UUIDs preserved exactly**, confirming plan §5.4 on this build too. The
never-import-over-a-live-ID rule stays load-bearing.

**Not yet answered:**

- **Sign-up entrants page** — `/championship/{id}/entrants` 404s, because
  `exportAsReimportableCopy` disables `SignUpForm` on the copy. Self-inflicted;
  see §13.
- **Pit counts** — `/content/tracks/spa/ui/ui_track.json` returned `null`
  rather than 404, so ACSM served the route but had nothing to read.
- **`PracticeEntryListType` 2 → 1** (plan §5.4) — didn't reproduce here, but
  the seed came from this server, so it may already have been 1.

## 13. Odds and ends

- `formValueAsInt` maps the string `"on"` to `1`, so checkbox values arrive as
  `"on"` and anything unparseable becomes `0` rather than an error.
- `EntryList.Skin` accepts the sentinel `random_skin`, which ACSM resolves at
  submit time against the installed skins for that model. A client must not
  treat it as a literal skin folder.
- `NormaliseEntrantGUID` is applied to GUIDs on the way in, so a GUID that
  round-trips unchanged in the export may still differ from what was typed.
- `EntryList.InternalUUID` is a hidden field in the form, confirming it is
  per-list identity rather than a join key: the form carries whatever that list
  rendered.

## 14. `RaceExtraLap` is not a browser checkbox

It looks like one, and treating it as one silently inverts the setting.

The rule for a checkbox is that an unchecked box is *absent* from the
submission, so a client sets it by adding the key and clears it by removing
the key. Our form parser deliberately reproduces that (§4): it drops unchecked
boxes.

`RaceExtraLap` does not behave that way. The recon capture shows the field
present **exactly once** on the rendered event form, while the seed
championship it was captured from has `RaceExtraLap: false`. Presence therefore
does not mean checked — the field carries its value rather than its existence.
Adding and removing the key would have written the opposite of what the person
asked for, in both directions, with no error.

So the finalize path writes it as `"1"` / `"0"` in place, via `setOne`, which
also refuses to touch a key that appears more than once. If a later build
renders it paired (a hidden `0` plus a checkbox `1`, giving a count of two)
that fails loudly rather than scrambling the form's arity.

Two things still unconfirmed, both cheap to settle on the harness:

- Whether the single field is a hidden input, a select, or something else.
  Only the count and the value were captured.
- The same question for the other boolean-looking scalars on that form —
  `ABSAllowed`, `TyreBlanketsAllowed`, `ForceVirtualMirror`. champctl doesn't
  write any of them yet, so nothing depends on the answer today, but anything
  that starts writing them needs to ask first.

The general lesson is worth keeping: **the count in a form capture tells you
the arity, not the encoding.** Pair it with a known value from the export
before deciding what a field means.

---

## 15. `Track` and `TrackLayout` cannot be round-tripped by the HTML rules

Measured on **2.4.15**, and this one had already destroyed data: every event
save champctl made rewrote the round's layout, and some of them rewrote the
track.

The event form renders both as `<select>`, and the browser rules our parser
correctly follows say a select with nothing marked `selected` submits its first
option. Both selects hit that case, for different reasons.

**`TrackLayout` never marks anything selected.** It is not really a control —
it is a data island for the page's JavaScript, carrying *every* installed
track's layouts as `{track}:{layout}`, with `{track}:<default>` for a track that
has none. On load, `loadTrackLayouts()` empties it and rebuilds it from the
chosen track's layouts alone, with bare values (`indy`, not
`ks_brands_hatch:indy`). A browser therefore never sends what the server
rendered. champctl runs no JavaScript, so it sent the first option:

```
before: ks_brands_hatch "indy"
posting TrackLayout = "ks_black_cat_county:layout_int"
after:  ks_brands_hatch "ks_black_cat_county:layout_int"
```

That is a layout belonging to a different track. ACSM stores it without
complaint; the visible symptom is the championship page losing the track's
layout image, and the race running at whatever the server falls back to.

The server does say which layout is current, in the only place it can without a
`selected` attribute: **a third segment on the value**,
`ks_highlands:layout_short:current`. `currentTrackLayout` in
`src/acsm/event-form.ts` reads it, and `findEventForm` applies it to every
event-form write.

Where champctl deliberately parts company with a browser: when the track has
layouts and none is marked current — an event whose stored layout is not one
this track has — the page's rebuilt dropdown would be *showing* the first
layout, and a browser would post that. champctl posts `""`. There is nobody
looking at a dropdown here to notice that Brands Hatch just became `indy`, so
guessing would write a plausible wrong answer into a race under cover of a save
about something else.

**`Track` marks nothing selected when the event's track isn't installed.** ACSM
renders one option per installed track, so an event on a removed or misspelled
track matches none of them. The first option then wins, and a finalize about lap
count moves the race to another circuit — measured, a `suzuka` event on a
manager without Suzuka came back as `ks_black_cat_county`, which is
alphabetically first and nothing more meaningful than that.

There is no correct value to post, so `findEventForm` refuses the write and says
why. `trackIsMissingFromServer` is the test: a `Track` select with no selected
option.

Two things follow for anything else on this form:

- **A fixture that renders these as inputs is a fixture that cannot fail.**
  That is precisely why the suite missed this for so long — `test/support/`
  rendered `<select name="TrackLayout"><option value="" selected>`, which
  submits `""` under any reading. `trackSelectHtml` and
  `trackLayoutSelectHtml` now reproduce the real shape, including that every
  other track sorts ahead of the event's own.
- **Ask whether the page's JavaScript rewrites a field before writing it.**
  This is the third measured departure from browser form rules, after the
  checkbox encoding (§4) and `RaceExtraLap` (§14). The pattern is the same
  every time: ACSM's form is not a browser-standard payload, it is whatever its
  own JavaScript produces.
