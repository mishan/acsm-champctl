# Sign-ups: how ACSM accepts and rejects them

What the web UI's sign-up queue (`src/signups/queue.ts`) is built on, and why
it refuses some of what ACSM's own buttons would do.

Measured 2026-10-28 on the local Docker harness running **premium v2.4.15**
(`/healthcheck.json` → `"Version":"v2.4.15"`), the same build BATL runs. Nothing
was sent to ac.batlracing.com. Source references are to the public
`JustaPenguin/assetto-server-manager` master (v1.7.9, commit 766b11d). Premium
is closed source, and its binary keeps no
handler symbols, so the premium behavior below comes from harness measurements.
Where premium differs from 1.7.9, that is noted.


## 1. The request

```
GET /championship/{championshipID}/entrant/{GUID}?action=accept|reject|delete
Referer: <where to send the 302>
Cookie: <logged-in session>
```

- Route: `router.go:249`, in the `WriteAccessMiddleware` group (`router.go:197`).
  The handler is `modifyEntrantStatus` (`championships_handler.go:918-981`). The
  links are rendered by `views/pages/championships/signed-up-entrants.html:134-146`,
  and on 2.4.15 the `/entrants` page renders the same three links (measured).
- **GET only.** A POST returns **405** (measured).
- **No CSRF token.** It's a plain link. Auth is the session cookie alone.
  Logged out, it returns **302 → `/`** and changes nothing (measured).
- `{GUID}` is the response's `GUID`, matched exactly, with no normalization
  in the handler. `paths.ts:136` `entrantStatusPath` already builds this path.
  Add `?action=` yourself.

**Responses on 2.4.15 (measured):**

| case | status | Location | saved? |
|---|---|---|---|
| accept OK | 302 | `<Referer>?current-entrant-guid=<GUID>` | yes |
| accept, no free slot | 302 | same | yes (`Updated` bumped); status stays `Pending Approval` |
| accept, already accepted | 302 | same | yes (`Updated` bumped), otherwise no-op |
| reject / delete | 302 | same (delete: a neighbor's GUID) | yes |
| GUID not in Responses | **400** | — | **no** (1.7.9 saved and 302'd) |
| unknown `action` | **400** | — | no |
| no Referer | 302 | `/championship/{id}/entrant/?current-entrant-guid=…` (junk) | yes |
| sign-ups disabled | 404 (source, `:927`) | — | no |
| logged out / lapsed session | 302 | `/` | no |

**The status code can't tell success from failure.** A 302 means success,
"no slot", or "already accepted" alike. The only difference is a flash
message shown on the next page ("The entrant was successfully accepted!" /
"There are no more slots available for the given entrant and car. Please
check the Championship configuration." / "This entrant has already been
accepted."). champctl should:
- send `redirect: "manual"`,
- treat a Location of `/` as an auth failure,
- then **re-read the logged-in export** and check the response's `Status` and
  the class slot.

`AcsmSession` has no "GET that writes, manual redirect" method yet. `getText`
follows redirects (`session.ts:513`, `#request`).

## 2. What accept does

Source: `championships_handler.go:940-960` calls
`AddEntrantFromSessionData(championship, entrant, overwriteSkinForAllEvents=true,
takeFirstFreeSlot=SignUpForm.HideCarChoice)` (`championship_manager.go:1498-1540`).
After that it calls `UpsertChampionship`.

**The save.** The handler loads the championship struct from the store,
mutates it in memory, and calls `store.UpsertChampionship` (`store_bolt.go:355`,
which sets `Updated`). It **is** a whole-championship save, but **not** a form
round-trip, so none of the 2026-10-06 failure modes apply (spectator row, `Info`
blanked, ClassIDs zeroed). The export diffs before and after each action show only
the expected fields changing. It also:
- pushes to ACSR if `ACSR` is on (`championship_manager.go:61-72`),
- adds the driver to the autofill list (`:1527-1537`).

Concurrency risk: if another writer runs a load-modify-save of the same
championship (a championship-form POST from a page rendered earlier), the last
save wins.

**Slot choice** (`HideCarChoice=false`, BATL's setting, `championships.go:848-900`):
1. Any class slot already holding this GUID is cleared (Name, GUID).
2. The class is found by car via `FindClassForCarModel`. If that fails, the result
   is a 500 (source; not measured).
3. The first empty slot (no Name, no GUID) whose `Model ==` the chosen car.
4. Otherwise, the first empty slot with `Model == any_car_model`. The slot's
   `Model` becomes the chosen car (measured: CAR_2 `any_car_model` →
   `ks_ferrari_488_gt3`).
5. `AssignToFreeEntrantSlot` sets **Name, GUID, Model, Skin** (and Team, if
   non-empty). The slot's `PitBox` and `InternalUUID` stay as they were. So
   the pit box is whatever that `CAR_n` slot had. "First" means Go map order
   over `CAR_n` keys, which is effectively random.
6. No slot: returns false. The handler flashes an error and **saves anyway**.

**Event entry lists:** accepting **does not add the driver** to any event's
`EntryList`. Name and GUID stay empty there (measured). Only `Skin` is written,
on `event.EntryList.FindEntrantByInternalUUID(classEntrant.InternalUUID)` for
every event. What that hits depends on the UUIDs:
- **Class and event UUIDs join** (as in the August 2.4.15 export in
  `fixtures/live/glickenhaus.json`: 27-31/32 shared): the matching event slot
  gets the new skin. That's correct, and race time uses the class Name/GUID
  through `CombineEntryLists`. For an `any_car_model` slot, the event entrant's
  Model stays `any_car_model`, so `CombineEntryLists` (which also matches on
  Model) ignores it.
- **Class entrants with nil UUIDs** (BATL's October championship, per
  docs/acsm-champ-form.md §4.1): if any event entrant also has a nil UUID,
  **an arbitrary other driver's event Skin is overwritten** with the newcomer's
  skin. Measured in championship A:
  `Events[0].EntryList.CAR_0.Skin "ev0_skin_0" -> "fan_skin"` (CAR_0 is
  "Seated Driver"), then `-> "audi_skin"` on the next accept. This is the
  `OverwriteAllEvents` nil-UUID trap from docs/acsm-champ-form.md §4.1, and
  ACSM's own Accept triggers it. It has no effect at race time, because
  `CombineEntryLists` skips nil class UUIDs. But it corrupts the stored export
  that gridmom reads. If every event entrant has a real UUID, the miss returns
  `&Entrant{}` and nothing happens (measured: round 2 untouched).

**Hazards measured on 2.4.15:**
- **A failed accept can unseat a driver.** Take a seated driver whose pending
  response asks for a different car with no free slot. Step 1 clears their
  seat, step 6 finds nothing, and the save persists the cleared seat. The
  response stays Pending, and the only signal is a 302 with an error flash.
  Measured in championship B: `CAR_0.Name "Seated Driver" -> ""`, `GUID -> ""`.
- **Accepting a seated driver's pending response for the same car** puts them
  back in their own slot and overwrites the class `Skin` with the response's
  skin (`seated_skin -> seated_new`).
- **HideCarChoice=true** (`AddEntrantInFirstFreeSlot`): the driver takes any
  empty slot in any class, ignoring model, in random map order. Measured with
  no `Car` posted: an `any_car_model` slot's Model became `""` and the event
  skins became `""`. The 2.4.15 form still renders a Car select in this mode,
  so a browser would post one. That path wasn't measured further.

## 3. Reject, delete, un-accept

- **reject** (`:962-964`): `Status = "Rejected"` (the record is kept), plus
  `ClearEntrant(GUID)`. That blanks **Name, GUID, Team** on the first class
  slot holding that GUID and leaves Model, Skin and PitBox alone.
  `championships.go:452-465`. Event lists are untouched.
  - Rejecting a pending response needs no grid change (measured).
  - **Rejecting an accepted driver un-accepts them.** There is no guard: the
    slot frees up, and the status goes Accepted → Rejected (measured, A8). The
    slot keeps the departed driver's Skin. An `any_car_model` slot keeps the
    car it was converted to rather than reverting.
  - **Rejecting a pending response from a driver who is already seated**
    (put there by champctl or the champ form) **removes them from the grid**
    (measured, B4: `CAR_4 Other Seated` cleared). Their name stays in the
    event lists.
- **Re-accepting a rejected response works**, and it takes a slot again
  (measured, A10).
- **delete** (`:965-967`): removes the response and calls `ClearEntrant`.
  On 2.4.15 the saved Responses also come back re-sorted newest-first
  (measured), so key responses by GUID, never by index.
- A driver re-submitting the public form replaces their response by GUID and
  resets it to `Pending Approval` (source `championship_manager.go:1771-1783`).
  On 2.4.15 the form **404s once the entry list has no free slot** (measured).

## 4. Reading pending responses

- **Logged-out export:** `SignUpForm.Responses: null` (measured on the harness;
  matches `types.ts:253-258`).
- **Logged-in export** (`GET /championship/{id}/export` with the session) carries
  the full array, so use it. `session.getJson(exportPath(id))` already does
  this (`write.ts:67`, `liveries/apply.ts:474`). Don't use the cached public
  `AcsmReader`. Shape on 2.4.15 (measured):
  ```json
  {"Created":"2026-10-29T00:06:37.057309321Z","Name":"…","GUID":"7656119…",
   "ClassID":"<class uuid>","Team":"","Email":"","Car":"ks_ferrari_488_gt3",
   "Skin":"fan_skin","Questions":{"<question text>":"<answer>"},
   "Status":"Pending Approval"}
  ```
  `Status` values are exactly `"Pending Approval"`, `"Accepted"`, `"Rejected"`
  (`championships.go:1653-1658`; all three measured). `ClassID` is premium-only
  (it isn't on the champctl `SignUpResponse` type, though `Unknowns` lets it
  through). `Questions` is keyed by the question text from
  `SignUpForm.ExtraFields`.
- `/championship/{id}/entrants` (HTML, 200 logged in, 302 → `/` logged out)
  and `/entrants.csv` (logged in: columns
  `Created,Name,Team,GUID,Email,Car,Skin,Status`, then the extra fields, then the
  3 ACSR columns) work too, but the export is the structured one. Both 404
  when sign-ups are disabled (`:822`).
  `/championship/{id}/registrations` is a 404 on 2.4.15.
- 2.4.15 `SignUpForm` keys: `Enabled, AskForEmail, AskForTeam, HideCarChoice,
  ExtraFields, RequiresApproval, AllowDuplicateSkinChoices,
  RequireRegistrationWithSteam, DynamicClassSize, RegistrationDeadline,
  Responses`.

## 5. What champctl already has

- `src/acsm/paths.ts:18-19,136` — `entrantStatusPath` (no `?action`).
  It's re-exported from `write.ts:455` and has no caller.
- `src/acsm/types.ts:233-260` — `SignUpResponse` and `SignUpForm`. `Status` is
  typed `"Accepted" | "Rejected" | string`, with no `"Pending Approval"`.
- `src/acsm/view.ts:75-82` — `signUpResponses` and `acceptedSignUps`.
- `src/gridmom/checks/entry.ts:594-660` — `signup.exceeds-slots` and
  `signup.no-slot`. `entry.ts:663-690`: an empty slot pinned to a model instead
  of `any_car_model`.
- `src/emit/championship.ts:519-522` — new championships get `Responses: []`.
- `scripts/recon/forms.ts:200-220` captures the status links into
  `fixtures/recon/entrant-status-links.json`. It currently holds `links: []`
  because the recon seed had no responses.
- `src/web/plans.ts:10-16` and docs/development.md:360 — the finalize
  fingerprint guard exists because an approval can land between preview and
  push.
- **Side finding:** `types.ts:252` `RegistrationClosesAt`, read by
  `gridmom/checks/championship.ts:196` and `racers/watch.ts:277`, doesn't
  exist on 2.4.15. The field there is `RegistrationDeadline`, which
  `liveries/apply.ts:528` already reads. So `champ.signup-deadline` can't fire
  on BATL.

## 6. Open questions

- Premium's exact slot logic for `DynamicClassSize=true` and for multi-class
  `ClassID`. The 2.4.15 response carries `ClassID`, and premium may pick the
  class from it rather than from the car. Not measured: single class only.
- `HideCarChoice=true` with a Car posted, as a browser would send it.
- Whether premium still sends ACSR / autofill on accept. That's source-only
  (1.7.9), and the harness has ACSR off.
- Whether `FindClassForCarModel` failing (car in no class) is still a 500 on
  2.4.15.
- ~~Whether BATL's championships have nil-UUID event entrants~~ — they do,
  every one: October and November 2026 have nil UUIDs on all 30 and 29 class
  slots and all 120 and 116 event entries. So every Accept, ACSM's own button
  included, writes the new driver's skin onto event entries. Race nights don't
  read them; gridmom does.

## Harness commands run

```sh
npm run harness:up                              # premium v2.4.15 image
set -a && . docker/.env && set +a && npm run harness:provision   # "Already provisioned"
curl POST /login (cookie jar)                   # 302 → /
curl -F ChampionshipFile=@seed{A,B,C,D}.json POST /championship/import   # 4 test championships
curl POST /championship/{id}/sign-up            # anonymous sign-ups (Name, GUID, ClassID, Car, Skin)
curl GET /championship/{id}/entrant/{guid}?action=…   # then the flash and a logged-in export
npm run harness:down                            # stopped; volumes kept, test championships remain in them
```

Test championships, all named `signup-recon …` and left in the harness volume:
- A, nil class UUIDs; round 1 has nil event UUIDs, round 2 real ones.
- B, class and event UUIDs joined.
- C and D, HideCarChoice.
