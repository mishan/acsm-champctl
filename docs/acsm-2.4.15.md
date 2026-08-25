# What 2.4.x does differently

Measured against real 2.4.5 and 2.4.15 with the live suite, not read off the
source. Both behave identically on everything here, so this is BATL's build,
not a future one. Everything has a reproduction.

`docs/acsm-write-path.md` is still the reference for the write path in
general. This is the delta; §5 is the one that mattered, and it corrects §4 of
that document.

## 1. It will not start without a licence

```
level=fatal msg="Failed to validate license"
  error="open ACSM.License: no such file or directory"
```

Before it opens a port, so `/healthcheck.json` doesn't answer either.
`ACSM.License` is per-purchase and is not in the release zip. See
`docker/README.md`.

## 2. Steam is optional — there *is* a content-free mode

The old claim that steamcmd always runs and blank credentials only change how
it fails is wrong for 2.4.x. On a host with no steamcmd installed at all:

```
level=warning msg="Could not find or install Assetto Corsa Server using
SteamCMD. Creating barebones install."
```

Then `AssettoIsInstalled: true`, 178 stock cars, **0 tracks**, no `acServer`.
Enough for import, forms and the round trip — championship import validates
neither track nor car names — and not enough to start a session.

This is what makes the harness CI-runnable, and it removes the Steam account
from the requirements.

## 3. A first-run wizard blocks every page

2.4.x redirects *every* authenticated request to `/intro/checks` until the
wizard is finished: `/`, `/championships`, `/championship/import`, all of it.
Nothing in 1.7.9 does this, so nothing in the suite expected it, and it
presents as the thoroughly misleading

> No form posting to /championship/import on the import page. Is this account
> allowed to import?

Fetching `/intro/server-options` and posting its form back unchanged completes
it. `npm run harness:provision` does that, along with the forced password
change. No CSRF token anywhere in the sequence.

## 4. Importing a championship segfaults the bolt store

Repeatable, whole process gone:

```
fatal error: fault   [signal SIGSEGV: segmentation violation]
BoltStore.UpsertChampionship -> UpsertData -> addAuditEntry
  -> audit.DiffJSON -> tidwall/pretty.Pretty
```

Triggered once the imported championship has scheduled events. The faulting
address is an mmap-backed bolt page, so the audit diff appears to read the
previous value after bolt has remapped the file underneath it.

`server.audit_logging: false` does **not** avoid it — that entry is written at
the store layer regardless of the flag. The `json` store has no such path, and
the harness uses it for that reason.

Not yet reproduced outside this host. Worth confirming in Docker before
reporting upstream, but worth knowing either way: a league on boltdb is one
championship import away from the same crash.

## 5. Checkboxes are "1"/"0", not "on" — and this destroyed events

The one that mattered. It presented as "the form is populated by JavaScript and
champctl can never drive it", which was wrong; the form is fully
server-rendered. What is not standard is how checkboxes are submitted.

ACSM installs a global submit handler that rewrites every checkbox before the
browser serialises the form:

```js
$("form").submit(function () {
  $(this).find('input[type="checkbox"]').each(function () {
    t.is(":checked") ? t.attr("value", "1")
                     : (t.after().append(t.clone().attr({type: "hidden", value: 0})),
                        t.prop("disabled", true))
  })
})
```

So its Go side has only ever been handed an explicit `1` or `0`. It reads the
browser default `on` as false. champctl echoed the form back the way a browser
would, `Race.Enabled=on` came back false, and a single finalize took the event
from three sessions to none:

```
BEFORE sessions: ["PRACTICE","QUALIFY","RACE"]
AFTER  sessions: []
```

`applyFinalize` reported `eventSaved: true` throughout. The blast radius was
every checked box on the form, not just sessions — a finalize turned off every
enabled boolean on the event.

`parseForm` now emits `1`/`0` for every checkbox, checked or not, exactly as
ACSM's own handler does. `test/live/flows.live.test.ts` pins it, and that test
fails with `expected [] to deeply equal [ 'PRACTICE', 'QUALIFY', 'RACE' ]`
without the fix.

**No headless browser is needed.** Two related things fell out:

- **The "unpaired" entry-list checkboxes are not unpaired, and are not on this
  form.** `docs/acsm-write-path.md` §4 says a browser drops the unchecked ones,
  so one value arrives for N entrants and lands on the wrong one. True of a
  plain browser, false of this one — the handler gives every box a `0` or `1`
  first, so a browser sends all N correctly paired.

  It is also moot on 2.4.x: `EntryList.OverwriteAllEvents` and
  `EntryList.TransferTeamPoints` are rendered **zero** times on the event form
  for six entrants, and neither name appears anywhere on the page. They are on
  the championship *edit* form (`/championship/{id}/edit`), which champctl does
  not drive — and there they render **8 and 7 times for 6 entrants**, so that
  form needs reading properly before anything writes it. champctl still strips
  them from every POST, which on 2.4.x strips nothing, and remains right for
  1.7.9 where the event form does render them.
- **The schedule form lives on the championship page**, not at its own action.
  `GET /championship/{id}/event/{id}/schedule` is **405** on 2.4.x — that route
  is POST-only. champctl was fetching the action URL, so a finalize that moved
  quali failed *after* the event save had already gone through.

### What actually caused the "JavaScript-populated" symptom

Worth recording, because the false trail was expensive. The event form appeared
to render defaults — `Race.Laps` 0 against a stored 12, session times 15
against 60 and 20 — with every `.Enabled` unchecked.

That was the *fixture*, not the build. `fixtures/synthetic/recon-seed.json`
used the friendly session keys `Practice`/`Qualifying`/`Race`; ACSM looks up
its canonical `PRACTICE`/`QUALIFY`/`RACE` and, finding nothing, renders an
empty form. ACSM's own shipped championships use the canonical keys and their
forms render correctly. The fixtures now use canonical keys too.

That leaves a real hazard: **a championship written with friendly session keys
round-trips through the export intact while being invisible to ACSM's own
editor.** It looks fine in JSON and is blank in the UI. `emitMonth` inherits
its keys from the template, so a month built from a real BATL export is safe —
but nothing currently refuses a template that isn't.

### Pit boxes, for posterity

Not a problem worth solving. The form renders `EntryList.EntrantID` as the
row's position rather than the entrant's stored `PitBox`, and entrant order
varies between consecutive fetches of an unchanged page — Go map iteration,
randomised on purpose:

```
fetch 0: names=[P1,P2,P3,P4,P5,P6]  EntrantID=[0,1,2,3,4,5]
fetch 1: names=[P6,P1,P2,P3,P4,P5]  EntrantID=[0,1,2,3,4,5]
fetch 2: names=[P5,P6,P1,P2,P3,P4]  EntrantID=[0,1,2,3,4,5]
```

So any save renumbers pit boxes by whatever order the map produced — in the
ACSM UI as much as in champctl. BATL neither assigns nor promises pit boxes and
drivers do not expect to keep one, so this is noise rather than data loss.
`entryListFingerprint` ignores both the ordering and `EntrantID` deliberately,
and the live tests compare entrants by GUID rather than by position. Recorded
because it looks alarming, and because a league that *does* care about pit
boxes cannot use the event form at all on these builds.

One consequence worth carrying: the recon question "is `EntryList.EntrantID`
rendered" now answers yes without meaning what it used to. What matters is
whether it carries the stored pit box, and here it does not.

## 6. Schema drift against a 2.4.5-shaped fixture

`fixtures/synthetic/recon-seed.json` round-trips through 2.4.15 with ~515
differences, essentially all of them fields 2.4.15 adds (`CSPCarFlags`, `VIP`,
`IsPlaceHolder`, `RaceNumber`, `ClassID`, `BoP`, `DriverPenalties`) or drops
(`GuidsList`, `OverwriteAllEvents`, `TransferTeamPoints`).

None is a rewritten value, which is what the round-trip test is actually for,
so it now separates the two. Burying two real rewrites in 513 irrelevant
additions is how a real one goes unnoticed.

## 7. Answers to the standing recon questions, for 2.4.x

| Question | 1.7.9 | 2.4.5 and 2.4.15 |
|---|---|---|
| Import mechanism | textarea | file part named `ChampionshipFile` |
| `EntryList.EntrantID` rendered | yes | yes, but as list position, not `PitBox` (§5) |
| Checkbox submitted as | `on` | `1`/`0`, via a submit handler (§5) |
| `GET` on the schedule action | form | **405** — the form is on the championship page (§5) |
| Duplicate pit boxes delete entrants on import | — | no; all entrants survive |
| `/api/championships/list.json` | absent | **absent** — also on ac.batlracing.com |
| Listing championships | HTML | HTML, server-rendered; needs Public Access |
| CSRF token on login or forms | none | none |
| Forced password change path | `/accounts/new-password` | `/account/new-password` |
