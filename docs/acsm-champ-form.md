# The championship form, and custom liveries

champctl drives the *event* form and nothing else. This is about the other one —
`/championship/{id}/edit`, posting to `/championships/new/submit` — because it
is where a livery change belongs, and because nobody has read it yet.

Everything below marked **source** is read off `JustaPenguin/assetto-server-manager`
at `master` and needs confirming against the build BATL runs. Everything marked
**measured** has a run behind it. Right now almost nothing is measured, which is
the point of `npm run recon:champ-form`.

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

`internalUuidJoin` in `scripts/recon/report.ts` counts the overlap off an
export, and `recon:champ-form` prints it. **This is the question that decides
whether the whole approach works**, and it needs answering against a real BATL
export, not a harness seed: the seed's class and event lists were written by the
same import, and a synthetic agreement proves nothing about a championship whose
entry list has been edited in the UI for six weeks.

### 4.2 The 8-against-6 count

**Measured, 2.4.15** (docs/acsm-2.4.15.md §5): on the championship form,
`EntryList.OverwriteAllEvents` renders **8** times and
`EntryList.TransferTeamPoints` **7** times for **6** entrants.

ACSM reads every `EntryList.*` key as a parallel positional array
(acsm-write-path.md §1), so until those two numbers have an explanation there is
no way to say which occurrence belongs to which driver — and getting it wrong
does not fail, it gives entrants each other's settings.

The hypothesis worth testing first is a hidden clone-me template row behind the
"add entrant" button, plus a spectator-car row. `describeControls` reports where
each occurrence sits and whether an ancestor hides it, which distinguishes that
from a seventh driver. Note that hidden is a *hint about why the count is what
it is*, never a reason to omit a value: `display: none` has no effect on form
submission, only `disabled` does.

`checkEntryListShape` currently refuses this form outright, and that refusal is
correct until the counts are explained. Whatever explains them belongs in
`NON_ARRAY_ENTRY_LIST_FIELDS` or in the writer — not in a loosened check.

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
| Do class and event `InternalUUID`s join? | **unanswered** — §4.1, and it decides everything |
| What are the 8th and 7th `OverwriteAllEvents` / `TransferTeamPoints` rows? | **unanswered** — §4.2 |
| Is `EntryList.EntrantID` rendered on the class list? | expected no (§4.4), unmeasured |
| Is `EntryList.Skin` a select here, and does it carry the installed skins? | unmeasured |
| Would `checkEntryListShape` pass this form as parsed? | unmeasured |
| Does a skin upload appear in that select without a re-index? | source says yes (§2), unmeasured |

```sh
npm run recon:champ-form              # seed a throwaway, then read it
npm run recon:champ-form -- <id>      # read one that already exists, read-only
```

The second form writes nothing, which is what makes it the one to point at a
championship whose entry list has real history in it. `readEnv`'s disposable-host
guard still applies.
