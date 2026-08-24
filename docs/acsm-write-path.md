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

Worse, in the public build the field is only rendered for custom races, not for
championship events:

```html
{{ if and (not $.IsChampionship) (not $.IsSpectatorCar) }}
    <input type="number" name="EntryList.EntrantID" ...>
{{ end }}
```

If the premium build does the same, then **every championship event save
renumbers the entry list 0..n-1**, and BATL's pit box assignments only survive
because nobody has saved that form. This is the single most important thing for
`docker/` to settle — `npm run recon:forms` answers it directly by reporting
whether `EntryList.EntrantID` appears in the championship event form.

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

## 4. Repeated bare checkboxes break alignment — an ACSM bug

`EntryList.OverwriteAllEvents` and `EntryList.TransferTeamPoints` are rendered as
plain checkboxes with no hidden partner field, once per entrant, and read
positionally:

```go
if r.Form["EntryList.OverwriteAllEvents"] != nil &&
   i < len(r.Form["EntryList.OverwriteAllEvents"]) &&
   formValueAsInt(r.Form["EntryList.OverwriteAllEvents"][i]) == 1 {
```

A browser omits unchecked boxes entirely. So ticking the box on the 12th entrant
sends a single value at index 0, and ACSM applies it to the *first* entrant.
The feature can only behave correctly when every box is ticked or none are.

**Consequence for champctl:** omit both keys entirely unless deliberately using
them, and never echo back what the form rendered. Omitted means "false for
everyone", which is the safe reading and the one the guard above produces.

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

## 7. Odds and ends

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
