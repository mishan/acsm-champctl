# Recording races: champctl-spectator

`champctl-spectator record` joins the game server as a car, parks out of the
way, and records every other car for as long as the server runs. Each session
becomes a journal; when it ends, an `.acreplay` is written beside it that
Assetto Corsa plays like any replay. The same journals feed incident analysis:
which collisions happened, what each car was doing, and a suggested call for
the stewards.

Status: built and tested against a stock `acServer` and ACSM 2.4.15 on a
disposable server, including a staged collision. Not yet run against a
league's server.

It doesn't need to run on the game server's machine, and usually won't. What
it does need from wherever it runs is set out below: a slot to join, copies of
some car and track files, and the server's plugin feed.

---

## 1. A spectator car for the recorder

The recorder joins as a car, so it needs an entry-list slot. Give it a
**spectator car of its own** in the championship, beside any stream car:

- ACSM leaves spectator cars out of points and grid decisions.
- Spectator cars are exempt from **Car Update Filtering**; an ordinary entry
  would be sent distant cars less often.
- Lock the slot to a GUID that is the recorder's alone. That is what stops a
  driver taking it, and what lets the recorder take it: it joins with `--guid`
  and `--car`, and the server gives it the slot locked to that GUID.

champctl's emitter keeps every spectator car and parks them past the entry
slots in order, and gridmom checks each one's pit box and model.

**champctl won't save that championship's form while it has two spectator
cars.** Livery approvals and anything else written through ACSM's championship
form are refused, saying so: how ACSM lays out the form's rows with more than
one spectator car hasn't been measured, and a guess would give drivers each
other's cars. Edit that championship in ACSM itself, or record from a
championship with one spectator car.

## 2. Car and track files

To join, the recorder answers the server's checksum request: MD5s of a list of
files, which must match the server's own copies. It also reads each car's
physics data to place its wheels in replays, and each track's racing line to
analyze incidents. So it needs copies of some AC files, laid out as they are in
an AC install, under the folder you pass as `--ac-root`.

**Nobody can fetch these for you.** ACSM doesn't serve car or track files, even
to an admin, and the machine champctl runs on is usually not the game server.
Whoever runs champctl copies them in, from an AC install that has the league's
content (any driver's will do: Content Manager installs the same files the
server checksums), or from the game server if its owner will copy them.

### What to copy

| File | Needed for | If it's missing |
|---|---|---|
| `system/data/surfaces.ini` | joining | the recorder can't join and says which file it wanted |
| `content/tracks/<track>/[<layout>/]data/surfaces.ini` | joining | same |
| `content/tracks/<track>/models[_<layout>].ini` | joining | same |
| any `content/tracks/<track>/*.kn5` the server lists | joining, only if the server has them | same |
| `content/cars/<recorder's car>/data.acd` | joining, if the server has one | the server kicks the recorder: see below |
| `content/cars/<model>/data.acd`, or its `data/` folder | wheel positions in replays | that car is drawn with a Nissan R32's wheels, and the log names it |
| `content/tracks/<track>/[<layout>/]ai/fast_lane.ai` | incident analysis | `incident` refuses, naming the path it looked for |

Every track the league races, every car on its grids. A car's `data.acd` is a
few hundred KB, so even a few hundred cars is around 100 MB.

From a Windows AC install, PowerShell's `robocopy` copies just these files and
keeps the folder layout:

```powershell
$ac  = "C:\Program Files (x86)\Steam\steamapps\common\assettocorsa"
$out = "$env:USERPROFILE\champctl-ac"
robocopy "$ac\system\data"    "$out\system\data"    surfaces.ini
robocopy "$ac\content\cars"   "$out\content\cars"   data.acd suspensions.ini /S
robocopy "$ac\content\tracks" "$out\content\tracks" surfaces.ini models*.ini fast_lane.ai /S
```

`suspensions.ini` picks up the few cars that ship a `data/` folder instead of
`data.acd`. Track `.kn5` files are large and most servers don't checksum them,
so they're left out; add `*.kn5` to the tracks line if the recorder reports the
server asking for one. Then
copy `$out` to the machine champctl runs on, for example with Windows' own
`scp`:

```powershell
scp -r "$env:USERPROFILE\champctl-ac" you@champctl-host:/srv/champctl/ac
```

**Repeat it when the league adds a car or a track, or a mod updates.** A file
that differs from the server's copy fails the checksum, and the recorder logs:

> kicked because a checksum didn't match: the car and track files under the AC
> root differ from the server's

which means: copy that car's or track's files again, from an install that
matches the server.

## 3. The plugin feed, for collisions

The recorder sees every car by joining, but game clients are never told when
two *other* cars touch: each driver's game reports its own contacts to the
server, and only the server knows. The server passes them on to **UDP plugins**,
programs it streams events to (Real Penalty and KissMyRank work this way).
Without one, races are still recorded, but there are no collisions to analyze.

ACSM 2.4.8 and later can feed several plugins side by side. In **Server
Options → UDP Plugins**, add one:

- **Send Address**: the public address of the machine champctl runs on, and a
  port, e.g. `203.0.113.7:12001`. The server sends events here.
- **Listen Address**: e.g. `0.0.0.0:12000`. The server takes commands here.

On the machine champctl runs on, let UDP 12001 in from the game server, and
pass the recorder:

```
--plugin-listen 0.0.0.0:12001 --plugin-server <game server>:12000
```

The recorder ignores anything not from the game server, since a forged packet
would be a collision nobody had. It takes the server's address from
`--plugin-server`; add `--plugin-from <address>` when the events come from a
different one, such as a server in a Docker container sending from the
container's. The command direction is optional: the recorder uses it only to
ask for more frequent car updates. If the game server's firewall doesn't let
it reach port 12000, collisions still arrive.

The events cross the internet unencrypted. They carry car positions and
contacts, nothing sensitive.

## 4. Running it

```sh
CHAMPCTL_SPECTATOR_PASSWORD=… champctl-spectator record \
  --server <game server>:9600 \
  --ac-root /srv/champctl/ac \
  --car <the spectator slot's model> --guid <the slot's GUID> \
  --out /srv/champctl/recordings \
  --plugin-listen 0.0.0.0:12001 --plugin-server <game server>:12000
```

- The join password comes from the environment, not the command line, where
  anyone on the machine could read it.
- It rejoins on its own when ACSM moves to the next event, and gives up on a
  server that goes quiet for 15 s, which is how an event restart can look.
- The car parks 1000 m above the track's origin, clear of anything that could
  drive into it; `--park x,y,z` puts it elsewhere.
- Each session's journal is kept; a replay is written next to it when the
  session ends, its wheels placed from `--ac-root`'s car data.

## 5. Using the recordings

```sh
champctl-spectator replay <journal> [--out <file>] [--cars <ac-root>/content/cars] [--interval <ms>]
champctl-spectator incidents <journal>
champctl-spectator incident <journal> <n> --ac-root <dir> [--svg out.svg] [--prompt] [--rules rules.txt]
champctl-spectator mcp --journals <dir> --ac-root <dir> [--rules rules.txt]
```

- `replay` writes the replay `record` would have, at the game's own 18 frames a
  second unless `--interval` says otherwise, in milliseconds between frames.
- `incidents` lists a session's collisions, numbered.
- `incident` measures one (who was ahead, when they overlapped, who braked
  where, who moved across whom, where the cars touched) and ends with a
  suggested call from fixed rules, naming the rule and its numbers, or
  "unclear". The thresholds are the profile's `incidentThresholds`. The
  decision stays with a steward.
- `--prompt` prints the incident written up for any chat model, for a second
  opinion. champctl itself calls no model.
- `mcp` serves the journals to a steward's MCP client, over stdin and stdout.
  For Claude Code:

  ```sh
  claude mcp add champctl-spectator -- champctl-spectator mcp --journals <dir> --ac-root <dir>
  ```

  It reads journals from the machine it runs on, so a steward using it from
  home needs the journals copied to them.

## Limits

- **Steering** in replays uses the network's steering byte as degrees, as
  AssettoServer's own replay writer does. One real recording will confirm it.
- **The contact point** a collision reports is read as AC's own axes, not yet
  checked against a real game's report.
- **Replays have no track objects, wing movement or sun angle.** The game
  accepts them without; time of day may differ from the race.
- **The position list in a replay updates once a lap**, when the leader
  crosses the line, as in replays the game writes.
