# Race lap count from practice

Each race's lap count, worked out from that week's practice. The plan is for the
bot to propose it on race day and track staff to apply it with a button; so far,
champctl can read the practice and work out the count. The rule is the league's
own:

```
laps = race minutes ÷ fastest valid practice lap, rounded half up
```

## Where the laps come from

Not the championship export. Its `Sessions.PRACTICE` is only the race-night
practice. Each loop of a round's looping practice server writes its own results
file, listed newest first at `/api/results/list.json?page=N` (zero-based) and
served at `/results/download/<SessionFile>.json`. Both work logged out.

A file names its championship (`ChampionshipID`) but not its round, so a round's
files are the practice files for its championship, track and layout. The list
leaves `track_layout` out, rather than empty, for a track with no layout.

The window runs from the end of the previous round (`CompletedTime`) to this
round's practice start (`Scheduled`). A first round has no previous round in its
championship, so its window starts at the newest race session in the results
list. On a league night that is the previous race night, whichever championship
it belonged to; a midweek race on the same manager would cut the window short.
The same goes for a round whose previous round hasn't been raced. Paging stops at
the window's start. Reading 20 pages without reaching it is an error: a window read short is missing its oldest laps, and the
fastest may be among them.

List pages are never cached, since every new session shifts each row down a
page. Results files are cached like any other read, because they never change.

## Which laps count

- no cuts;
- in one of the round's cars (`RaceSetup.Cars`, or the championship's classes
  when the round names none), less the profile's `excludedCarModels`;
- a lap time above zero.

The fastest of those decides, whichever class set it: ACSM has one lap count for
the race and its reversed-grid second race, and for every class.

No trimming of fast outliers and no allowance for a mandatory pit stop: the rule
is the league's to change, not champctl's to second-guess.

## Race minutes

The round's own while it is still timed (`Race.Time` with `Laps` 0, which is
what the 1x40 and 2x20 presets write), otherwise the profile's
`lapCount.raceMinutes`. Staff will be able to change it on the proposal itself.

Measured on 2026-11-04 against Lime Rock: 13 practice sessions, 270 valid laps
from 11 drivers, fastest 54.694 s. 20 minutes gives 22 laps, the count set by hand
that week.

## Later

Prefilling from past races at the same car and track waits for a stats system,
which needs its own design.
