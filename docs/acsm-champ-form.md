# The championship form, and custom liveries

`/championship/{id}/edit`, posting to `/championships/new/submit`. The other
form champctl writes, and the one a livery change belongs on, because it is the
only write that reaches every round.

`champctl-liveries` drives it. `src/acsm/championship-form.ts` is the parser and
`src/liveries/apply.ts` the writer; this document is why they do what they do.

Everything below marked **source** is read off `JustaPenguin/assetto-server-manager`
at `master` and needs confirming against the build BATL runs. Everything marked
**measured** has a run behind it — §4 is measured against BATL's own manager,
premium **2.4.15**, one championship: 1 class, 29 entrants, 5 rounds.

---

## 1. What the weekly flow does by hand

```
Day of race week 1
  Ask Oleg to run the livery script
  Reassign liveries to anyone who submitted one, restart the looping practice server
  Zip the uploaded liveries, put the zip on Google Drive, link the pack
  Set the lap count from the practice times
```

The last line is `champctl-finalize`. The middle two are what this is for. The
livery script uploads a zip of skins to the server and restarts ACSM; the
reassignment is a person clicking through the entry list.

## 2. Upload: `POST /car/{car}/skin`

**Source.** `CarsHandler.uploadSkin` parses a 32 MB multipart form and hands
`r.MultipartForm.File` — *every* file part, whatever the field is called — to
`CarManager.UploadSkin`, which writes each one to

```
content/cars/{car}/skins/<filepath.Dir(header.Filename)>/<filepath.Base(header.Filename)>
```

Three things follow.

- **The skin folder is a path prefix on the part's filename**, not a field of
  its own. A part named `filename="MISHA_42/livery.dds"` creates
  `skins/MISHA_42/`. This is how a browser's `webkitdirectory` upload arrives,
  and it is the whole interface.
- **`filepath.Dir` is not sanitised**, so a filename containing `..` writes
  outside the skins directory. champctl must never send one, and a zip that
  contains one is a zip to refuse rather than clean up.
- **Upload adds, it never replaces.** Re-uploading a skin folder merges into
  whatever is there. Stale files from a previous submission survive. Deleting
  first is `POST /car/{car}/skin/delete` with `skin-delete=<folder>`.

`CarManager.LoadCar` reads the skins directory off disk on every call, so an
uploaded skin appears in the entry-list dropdown immediately. No search-index
rebuild — `/search-index` is for car metadata, not skins.

The handler redirects to `r.Referer()`, so send a `Referer` or the `Location` is
empty. It is a 302 either way, which is the only success signal: failure is a
500, and a 200 means something else answered.

## 3. Reassignment happens at championship level, and here is why

**Source.** `ChampionshipEvent.CombineEntryLists` builds the list ACSM actually
writes to `entry_list.ini`:

```go
entryList := championship.AllEntrants()
if cr.EntryList == nil { return entryList }
for _, entrant := range entryList {
    for _, eventEntrant := range cr.EntryList {
        if entrant.InternalUUID != uuid.Nil &&
           entrant.InternalUUID == eventEntrant.InternalUUID &&
           entrant.Model == eventEntrant.Model {
            entrant.OverwriteProperties(eventEntrant)
            break
        }
    }
}
```

and `OverwriteProperties` is six fields, not one:

```go
func (e *Entrant) OverwriteProperties(other *Entrant) {
    e.FixedSetup, e.Restrictor, e.SpectatorMode, e.Ballast, e.Skin, e.PitBox = ...
}
```

So the class entrant is the base and **the event entrant wins on `Skin`**. A
skin set on the class list alone is invisible to every round that has an entry
list of its own, which is every round champctl has ever written.

ACSM's own answer is the per-entrant `EntryList.OverwriteAllEvents` checkbox on
the championship form. On save (`championship_manager.go`):

```go
// look at each entrant to see if their properties should overwrite all event
// properties set up in the event entrylist. this is useful for globally
// changing skins, restrictor values etc.
for _, class := range championship.Classes {
    for _, entrant := range class.Entrants {
        if !entrant.OverwriteAllEvents { continue }
        for _, event := range championship.Events {
            eventEntrant := event.EntryList.FindEntrantByInternalUUID(entrant.InternalUUID)
            eventEntrant.OverwriteProperties(entrant)
        }
    }
}
```

One POST, every round updated. That is the write champctl wants to make.

## 4. What has to be settled before it can

### 4.1 Do the InternalUUIDs even join?

`FindEntrantByInternalUUID` returns `&Entrant{}` on a miss — not nil, not an
error. A class entrant that matches nothing in a round has its properties copied
into a throwaway struct and discarded, with no log line.

That collides head-on with this repo's own plan §5.5:

> `InternalUUID` is a per-list identity, NOT a join key — the class list and each
> event list use different UUIDs for the same driver. Line them up by the `CAR_n`
> map key instead.

Both cannot be true. If the plan is right, ticking `OverwriteAllEvents` reaches
no round at all and reports success doing it, which is the worst failure mode a
livery drop could have — nobody looks at a practice server until race night.

**Measured, and it is worse than either of them expected.** On BATL's manager,
all 29 class entrants come back with **no usable `InternalUUID` at all** — not a
different one, none — so the overlap with every round is zero:

```
classEntrants: 29, classEntrantsWithoutUuid: 29
matchedPerRound: [0, 0, 0, 0, 0], matchedEverywhere: 0
```

If that holds up, the consequences run well past liveries:

- **`CombineEntryLists` never applies an event's entry list.** Its guard is
  `entrant.InternalUUID != uuid.Nil` on the *class* entrant, so with nil UUIDs
  it never matches and returns `championship.AllEntrants()` untouched. The class
  list is what races, and the per-event lists are inert for these entrants.
- **A livery therefore only has to be set on the class list.**
  `OverwriteAllEvents` is unnecessary.
- **And it must not be set anyway.** `FindEntrantByInternalUUID` has no nil
  guard, unlike `CombineEntryLists` — it returns the first entrant whose UUID
  equals the one asked for, and with nil UUIDs on both sides that is a *real*
  event entrant, chosen by Go map order. Ticking the box for 29 drivers would
  copy 29 sets of properties onto arbitrary event entrants. Inert at race time,
  corrupt in the stored export, and gridmom reads the stored export.

One thing is not yet nailed down, and it inverts the answer if it goes the other
way: whether these entrants genuinely hold the nil UUID, or whether premium
2.4.15 simply **omits `InternalUUID` from the export JSON**. The OSS struct has
`ini:"-"` and no `json:"-"`, so OSS exports it — but premium is a different
build. The form settles it, because its 32 hidden `EntryList.InternalUUID`
inputs are rendered from the stored entrants: if those carry real UUIDs, the
export is hiding the field and everything above is wrong. `uuidCensus` counts
them without emitting any. **Re-run `recon:champ-form` and read that line before
building on this.**

A third possibility, if the values are rendered *empty* rather than nil: a save
would then give every entrant a fresh identity, because `BuildEntryList` starts
from `NewEntrant()` and only overwrites the UUID when `uuid.Parse` succeeds.

**What champctl does about it.** Not "assume the measurement holds". `planLiveries`
recomputes the join from the export on every run and reports, per driver, the
rounds whose own entry list would win. A preview with an unreachable round says
so in the loudest line it prints. So the tool is correct in both worlds: where
the UUIDs don't join it writes the class list and that is what races, and where
they do it says the write would not reach the race rather than reporting a
success that only happened in the database.

**And `OverwriteAllEvents` is not used.** It looks like the answer — its own
comment in ACSM says "useful for globally changing skins" — and on this data it
is a trap. `FindEntrantByInternalUUID` has no nil guard, unlike
`CombineEntryLists`:

```go
func (e EntryList) FindEntrantByInternalUUID(internalUUID uuid.UUID) *Entrant {
    for _, entrant := range e {
        if entrant.InternalUUID == internalUUID { return entrant }
    }
    return &Entrant{}
}
```

With nil UUIDs on both sides that returns a *real* event entrant — the first one
Go's randomised map iteration reaches. Ticking the box for 29 drivers would copy
29 sets of properties onto arbitrary event entrants: inert at race time, corrupt
in the stored export, and gridmom reads the stored export.

### 4.2 The extra rows — answered

**Measured, 2.4.15, BATL's manager.** 29 class entrants in one class, and the
form renders:

| key | count |
|---|---|
| `Car` `Skin` `Name` `Team` `GUID` `Ballast` `Restrictor` `FixedSetup` `InternalUUID` `OverwriteAllEvents` | 32 |
| `TransferTeamPoints` | 30 |
| `Spectator` | 2 |
| `EntrantID` | 0 |

Which is exactly this, in document order:

| index | row | submitted by a browser? | read by ACSM? |
|---|---|---|---|
| 0 | spectator-car `#entrantTemplate` | no — removed by JS | — |
| 1 | the spectator car | yes | yes, as index 0 |
| 2 | class `#entrantTemplate` | no — removed by JS | — |
| 3–31 | the 29 class entrants | yes | yes, as indices 1–29 |

`TransferTeamPoints` is 30 because the two spectator rows don't have it;
`Spectator` is 2 because only they do.

**Source, and this is the fourth departure of the kind in §15 of
acsm-write-path.md.** `manager.js`:

```js
let $tmpl = this.$parent.find("#entrantTemplate");
if (!$entrantTemplate && $tmpl.length > 0) {
    $entrantTemplate = $tmpl.prop("id", "").clone(true, true);
}
$tmpl.remove();
```

The template is copied for the "Add Entrant(s)" button and then **removed from
the DOM on load**. A browser therefore submits 30 rows where the server rendered
32. champctl runs no JavaScript, so it parses all 32 — and since ACSM reads
these as parallel positional arrays, keeping them shifts every entrant by two
and drops the last two off the end of `start+length`. `templateRowIndices`
reports them off ACSM's own id rather than off styling, because on this form the
template row is not hidden at all.

Then, **source**, from `HandleCreateChampionship`:

```go
previousNumEntrants := 0
if Premium() {
    entrants, _ := cm.BuildEntryList(r, previousNumEntrants, 1)   // index 0
    championship.SpectatorCar = *(entrants.AsSlice()[0])
    previousNumEntrants++
}
for i := range r.Form["ClassName"] {
    numEntrantsForClass := formValueAsInt(r.Form["EntryList.NumEntrants"][i])
    class.Entrants, _ = cm.BuildEntryList(r, previousNumEntrants, numEntrantsForClass)
    previousNumEntrants += numEntrantsForClass
}
```

So on premium **index 0 is the spectator car**, not an entrant, and each class
takes the next `EntryList.NumEntrants` rows. A writer has to drop the two
template rows and keep that ordering, or the spectator van becomes a driver.

`EntryList.Spectator` is **rendered and never read** — the line that would read
it is commented out in `BuildEntryList`:

```go
// Despite having the option for SpectatorMode, the server does not support it,
// and panics if set to 1
// SpectatorMode: formValueAsInt(r.Form["EntryList.Spectator"][i]),
```

`checkEntryListShape` refuses this form today on `EntryList.Spectator=2` and
`EntryList.EntrantID=0`. Both now have an explanation, and neither belongs in a
loosened check: `Spectator` is a rendered-but-unread field and `EntrantID` is
§4.4. The writer drops the template rows first, and the arity check then runs on
what actually goes out.

### 4.2a The skin select carries only the current skin

**Measured.** All 32 `EntryList.Skin` selects render **one** option each, except
the two template rows, which render none — on a manager with far more than one
skin installed per car.

**Source.** `populateEntryListSkinsAndSetups` in `manager.js` empties the
dropdown on load and rebuilds it from the chosen car, leading with
`<option value='random_skin'>`. The server renders only what is currently
selected.

Benign for a round trip — the one rendered option *is* the current value, so
echoing it back preserves the skin — but it means the form cannot be used to
check that a skin name exists. A livery writer has to verify against
`/car/{car}` or the upload it just made. `EntryList.Skin` also accepts the
sentinel `random_skin`, which ACSM resolves at submit time, so it must never be
treated as a literal folder (acsm-write-path.md §13).

### 4.3 `postForm` strips the field we need to send

`stripUnpairedCheckboxes` drops `EntryList.OverwriteAllEvents` and
`EntryList.TransferTeamPoints` from every POST. That is right for the event form
and wrong here: this is the one write that has to send them. The change is
confined to the championship writer when it exists, not to `postForm`.

### 4.4 Pit boxes

**Source.** The event-form template renders `EntryList.EntrantID` only when
`not $.IsChampionship`, and `IsChampionship` marks the class list — so the
championship form is expected *not* to render it. `BuildEntryList`'s else branch
then sets `PitBox = i`, the loop index.

`OverwriteProperties` copies `PitBox`, so a ticked entrant pushes that index onto
every round. With one class that is a reshuffle BATL does not care about — it
neither assigns nor promises pit boxes (acsm-2.4.15.md §5). With two classes each
starting at index 0 it is two entrants claiming `CAR_0`, and `AddInPitBox`
overwrites on collision, so one of them is deleted at practice-start.

A writer should refuse a multi-class championship until somebody has measured
this. BATL runs one class plus the spectator van.

### 4.5 A whole-championship replace

The `new` in `/championships/new/submit` is ACSM's: one handler serves create
and edit, and an edit is a create carrying an existing ID. So a POST here
replaces the entire championship — classes, points, sign-up form, the lot — and
the entry-list fingerprint guard from `src/finalize/apply.ts` applies at least as
strongly as it does to an event save.

## 5. Restart: the practice endpoint, not the process one

**Source, and this one is easy to get wrong.**

`GET /championship/{id}/event/{eventID}/practice` → `StartPracticeEvent` →
`StartEvent(id, eventID, true)` → `FinalEventConfigurationFiles`, which rebuilds
the entry list from the *stored* championship and sets `raceSetup.LoopMode = 1`.
That is the looping practice server, and regenerating the entry list is exactly
what makes a reassigned livery take effect.

`GET /process/restart` does not do that. With a practice event running,
`serverProcess` falls through to `sah.process.Restart()`, and

```go
func (sp *AssettoServerProcess) Restart() error {
    raceEvent := sp.raceEvent            // captured when the session started
    return sp.Start(raceEvent, ...)
}
```

replays the config it already had. The skins would be on disk and unused.

## 6. Standing questions for the next run

| | |
|---|---|
| Are the rendered `EntryList.InternalUUID` values real, nil or empty? | **unanswered, and it decides everything** — §4.1 |
| Do class and event `InternalUUID`s join? | no — zero of 29, in all 5 rounds (§4.1) |
| What are the extra rows? | two `#entrantTemplate`s the JS removes, plus the spectator car (§4.2) |
| Is `EntryList.EntrantID` rendered on the class list? | no, as predicted (§4.4) |
| Is `EntryList.Skin` a select here, and does it carry the installed skins? | a select, carrying only the current skin (§4.2a) |
| Would `checkEntryListShape` pass this form as parsed? | no — `Spectator=2`, `EntrantID=0`, both explained (§4.2) |
| Does a skin upload appear in that select without a re-index? | source says yes (§2), unmeasured |
| Does a save preserve `SpectatorCar`, points and the sign-up form untouched? | unmeasured, and §4.5 says it is a full replace |

```sh
npm run recon:champ-form              # seed a throwaway, then read it
npm run recon:champ-form -- <id>      # read one that already exists, read-only
```

The second form writes nothing, which is what makes it the one to point at a
championship whose entry list has real history in it. `readEnv`'s disposable-host
guard still applies.
