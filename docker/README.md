# ACSM test harness

A throwaway Assetto Corsa Server Manager in Docker, so the plan's §3.4 recon
list stops being manual devtools work and becomes something that reruns on every
ACSM upgrade.

## Safety

Read this bit.

The recon scripts and the live test suite **create, modify and delete
championships**. They are built for a container you can throw away, and both
refuse to run against a non-loopback host unless you set
`CHAMPCTL_I_KNOW_THIS_ISNT_LOCAL=yes`.

Never put a league's real credentials in `docker/.env`. Never point
`CHAMPCTL_LIVE_URL` at `ac.batlracing.com`. The container binds to `127.0.0.1`
by default, because it holds an admin account whose password is written down in
a file next to it.

The guard allows loopback and RFC1918 private addresses, so
`BIND_ADDR=0.0.0.0` plus a LAN IP works without ceremony. That is a speed bump
against pasting a public hostname, not a guarantee — a league could run ACSM on
a private address too. If you bind beyond loopback, check what else can reach
port 8772.

## Which version to run

BATL runs **2.4.5**. Any older zip is still worth running, but be clear about
what it settles. `docs/acsm-write-path.md` §0 has the full breakdown; the short
version:

- A 1.7.x harness proves **champctl's own machinery** — login, form parse,
  mutate, POST, re-export, diff — and the round-trip and safety-rail behaviour.
  That's most of the risk in the client, and none of it is version-specific.
- It **cannot** answer whether `EntryList.EntrantID` is rendered on the
  championship event form, or what the premium read endpoints return. 1.7.9 is
  the version the source says "no" for, so getting "no" from it tells you
  nothing about 2.4.5.

**Server Manager never updates itself.** Upgrading is: back up the database,
download the release, swap the binary. The auto-update in the config is
`steam.force_update`, which keeps the *Assetto Corsa dedicated server* current
via steamcmd — a different program. A container built from a 1.7.8 zip stays
1.7.8 however long it runs.

The recon scripts (a later change) record the version they captured against
and write `fixtures/recon/forms-<version>.json`, so a 2.4.5 run later produces
a diff rather than silently replacing a 1.7.x answer.

## Setup

The premium build isn't published as a Docker image, so build one from the
release zip you already have:

```sh
cp /path/to/server-manager-premium-*.zip docker/premium/
cp docker/.env.example docker/.env
npm run harness:build
npm run harness:up
```

`harness:build` is `docker compose build`, so re-run it after pulling changes
to `docker/` — compose won't rebuild on its own, and a stale image shows up as
a missing executable at run time rather than anything about the image.

Then provision the admin account. No browser needed — pick a password, put it
in `docker/.env` as `CHAMPCTL_LIVE_PASSWORD`, and run:

```sh
npm run harness:provision
```

Three steps, all scriptable, none with a CSRF token, measured on 2.4.15:

1. `POST /login` with `Username=admin&Password=servermanager` → 302
   `/account/new-password`. (`/account/`, singular — 1.7.9 uses `/accounts/`.)
2. `POST /account/new-password` with `Password` and `RepeatPassword` → 302
   `/account/settings`.
3. **The first-run wizard.** 2.4.x intercepts *every* authenticated page with a
   302 to `/intro/checks` until it is finished — `/`, `/championships`,
   `/championship/import`, all of it. Fetching `/intro/server-options` and
   posting its form straight back finishes it. This does not exist in 1.7.9,
   which is why nothing in the suite anticipated it, and it presents as a
   confusing "no form posting to /championship/import on the import page".

You can still do it in a browser if you prefer; the script is idempotent.

The public build needs no zip. Note the `--project-directory`, since these npm
scripts run from the repo root:

```sh
docker compose --project-directory docker --profile oss up -d   # :8773
```

It's worth having around — champctl should degrade sanely on the version most
other leagues run — but see the caveats below.

## The licence file is required

2.4.x refuses to start without one, before it ever opens a port:

```
level=fatal msg="Failed to validate license"
  error="open ACSM.License: no such file or directory"
```

`ACSM.License` is per-purchase and is **not** inside the release zip — it
arrives by email, or from emperorservers.com. Put it next to the zip:

```sh
cp /path/to/ACSM.License docker/premium/
```

`docker/premium/*` is gitignored in full, so it cannot be committed by
accident; `git check-ignore -v docker/premium/ACSM.License` shows which rule is
covering it.

## Steam credentials are optional on 2.4.x

**This section used to say they were required. That was wrong**, and it kept
the harness off CI for no reason.

Measured on 2.4.15, on a host with no steamcmd installed at all — so nothing
could have run it:

```
level=warning msg="Could not find or install Assetto Corsa Server using
SteamCMD. Creating barebones install."
```

after which `/healthcheck.json` reports `AssettoIsInstalled: true` and the 178
stock cars are in place. Server Manager falls back on its own. Championship
import doesn't validate track or car names, so that is everything the recon
scripts and the live suite need.

What a barebones install does **not** give you:

- **No `acServer` binary**, so no session can be started. Nothing in the recon
  or the live suite starts one.
- **No tracks at all.** Pit counts (plan §4.5) still need the `scan` source —
  already true with Steam credentials, since BATL runs mod tracks.

Set the credentials below if you want a server that can host a race. If you do,
the account must **own Assetto Corsa** — anonymous doesn't work:

```
$ steamcmd +login anonymous +app_update 302550 +quit
ERROR! Failed to install app '302550' (No subscription)
```

### QR sign-in — no password anywhere

```sh
npm run harness:steam-login-qr
```

Scan the QR code with the Steam mobile app. No password typed, no password in
`.env`, and nothing for Steam Guard to prompt about.

steamcmd can't do this — it only takes a username and password, and asks for a
Steam Guard code it has no way to receive when Server Manager runs it in the
background, which is what `exit status 4` usually is. So this route uses
[DepotDownloader](https://github.com/SteamRE/DepotDownloader), which speaks the
newer Steam auth protocol the QR sign-in is built on. It's installed in the
image alongside steamcmd.

It downloads appid 302550 straight into the volume Server Manager reads, so
afterwards Server Manager finds `acServer` already there and never runs
steamcmd. Then `npm run harness:up` comes straight up with no credentials
configured at all.

`-remember-password` persists the session in the `acsm-depotdownloader` volume,
so re-running it later to update the server won't need another scan.

### Or: username and password

```
STEAM_USERNAME=your-steam-account
STEAM_PASSWORD=...
```

in `docker/.env`. The entrypoint checks them before starting Server Manager, so
a bad login is a sentence in the logs rather than a number in the UI.

If the account has Steam Guard on, this needs one interactive login first, so
steamcmd can cache the credentials:

```sh
npm run harness:steam-login
```

That does the login and the `app_update 302550` download together. The cache
lives in `/home/assetto/steamcmd`, a named volume, so later non-interactive
logins succeed.

Either way, `npm run harness:reset` wipes those volumes and you'll need to
authenticate again. `harness:down` + `harness:up` keeps them.

### What you get

Stock content only. BATL's mod tracks still need the `scan` pit-count source
(plan §4.5), so `/content/tracks/{track}/ui/ui_track.json` will answer for
Spa and Silverstone but not for whatever mod track is on the schedule.

Expect a few minutes on the first download; the compose healthcheck allows for
it. `npm run harness:logs` to watch.

### Troubleshooting

**`executable file not found in $PATH`** when running `harness:steam-login-qr`
or `harness:steam-login`. The image is older than the tool being invoked.
`npm run harness:build`, then try again. Compose only rebuilds when asked.

**`Couldn't find any depots to download for app 302550`** — the login worked,
the platform filter didn't. Appid 302550 publishes one depot, tagged
`oslist: windows`; there is no Linux depot, and the Linux `acServer` binary
ships inside the Windows one. Both scripts here ask for Windows for that
reason, which is also what Server Manager's own installer does. See
`docs/acsm-write-path.md` §7.

**steamcmd exit codes**, as reported by Server Manager. Verified by running
them:

| Exit code | What it means |
|---|---|
| `0` | success |
| `4` | login failed — blank credentials, or a Steam Guard prompt it couldn't answer. See "Steam Guard" above. |
| `5` | invalid password, or no such account |
| `8` | install failed. `No subscription` means the account doesn't own Assetto Corsa. |
| `127` | steamcmd itself wasn't found or couldn't run — see below |

**"Likely you do not have steamcmd installed correctly", exit status 127.**

127 is "command not found", and it usually isn't steamcmd that's missing.
`steamcmd.sh` computes its own install root from `$0`:

```sh
STEAMROOT="$(cd "${0%/*}" && echo $PWD)"
STEAMEXE="${STEAMROOT}/linux32/${STEAMCMD}"
```

Invoke it through a *symlink* in `/usr/local/bin` and `$0` is the symlink's
path, so it looks for `/usr/local/bin/linux32/steamcmd`, doesn't find it, and
exits 127. The image installs a wrapper that `exec`s the absolute path instead,
which keeps `$0` pointing at the real script. If you hit this after changing
the Dockerfile, that's the first thing to check:

```sh
docker compose exec acsm steamcmd +quit          # should exit 0
docker compose exec acsm cat /usr/local/bin/steamcmd
```

If you're seeing it on an image built before this fix, rebuild:

```sh
npm run harness:down
npm run harness:build
npm run harness:up
```

**The UI never comes up.** `npm run harness:logs`. With Steam credentials set,
first boot downloads the AC server and can take several minutes; the compose
healthcheck allows for that.

**Login says the password is wrong.** The first login is
`admin` / `servermanager`, and ACSM immediately makes you change it. Whatever
you set then is what belongs in `CHAMPCTL_LIVE_PASSWORD`. If it's lost, put a
value in `accounts.admin_password_override` in `config.template.yml`, restart,
log in with it, and blank it again.

### Config templating

`config.template.yml` is committed with `__STEAM_*__` placeholders;
`entrypoint.sh` renders it into `config.yml` at boot from the environment. That
keeps Steam credentials in the gitignored `.env` rather than in a tracked file.
Values are quoted as YAML single-quoted scalars, so passwords containing `&`,
`$`, `\` or `'` survive intact.

The rendered `config.yml` holds the Steam password in plain text — Server
Manager reads it from nowhere else — so the entrypoint creates it `0600` before
writing, not after. Worth remembering if you `docker cp` anything out of
`/home/assetto/server-manager`.

`STEAM_FORCE_UPDATE` is the one value substituted *unquoted*, because
`steam.force_update` has to arrive as a YAML boolean rather than the string
`"false"`. So the entrypoint validates it before writing anything and refuses to
start on anything that isn't `true` or `false` — capitalisation and surrounding
spaces are forgiven, `yes` and `1` are not. Without that check a typo surfaces
much later as Server Manager failing to start, with nothing pointing back at
`.env`.

`CHAMPCTL_SELF_TEST=1 bash docker/entrypoint.sh` exercises the quoting and the
boolean parsing without starting anything.

The `oss` profile mounts `config.oss.yml` instead — a plain copy with blanks —
because the upstream image ships its own entrypoint and would never render the
template. Change one, change the other.

## Using it

The `recon:*` and `test:live` scripts arrive with the recon change, not this
one — until that lands, this section describes what the harness is *for*
rather than commands you can run today.

```sh
set -a && . docker/.env && set +a

npm run recon:forms        # snapshot every form champctl drives
npm run recon:roundtrip    # import, export, diff
npm run test:live          # the assertions those answers should hold to
```

`npm test` never touches the container.

Reset to a clean manager with `npm run harness:reset` — the volumes are named,
so `down -v` genuinely wipes it.

## What it can tell you

Once an Assetto Corsa server is in place, the recon work itself needs no
*content* — championship import doesn't validate track names, so the forms and
the round trip all answer against whatever the seed championship references.

Answers you get:

- **Whether `EntryList.EntrantID` is on the championship event form.** The big
  one. If it isn't, every save renumbers pit boxes to list position and BATL's
  assignments only survive because nobody has saved that form
  (`docs/acsm-write-path.md` §2). Measured on 1.7.9: it *is* rendered.
- **How this build takes an import** — 1.7.9 pastes JSON into a textarea, 2.4.5
  uploads a file, and guessing wrong fails silently.
- **Whether duplicate pit boxes delete entrants.** `AddInPitBox` overwrites, so
  this decides whether gridmom's ERROR means "unfair race" or "three people
  vanish next time anyone edits this".
- **The round-trip delta** — which fields ACSM rewrites on import, which it
  drops because its struct has no such field, and whether
  `PracticeEntryListType` really does get silently changed from 2 to 1.
- **The literal session keys** — `PRACTICE`/`QUALIFY`/`RACE` on 1.7.9, which
  gridmom has to match or its format checks find nothing.
- **The schedule endpoint's field names**, which is recon item 4.
- **The entrant approve/reject URL shape**, which is recon item 5 — and the
  router says it's a GET, not a POST.

Answers you don't get:

- **Pit counts.** `/content/tracks/{track}/ui/ui_track.json` needs the track
  installed. The Steam download gets stock content only, so BATL's mod tracks
  still need the `scan` pit-count source (plan §4.5).
- **Anything version-specific, if you're running an older zip than BATL.** See
  "Which version to run".
- **Anything about BATL's actual data.** This is an empty manager.
- **On the OSS profile: `/api/championships/list.json`, `standings.json` and
  `penalties-log.json`.** They aren't in the public build's router at all, which
  is the evidence that BATL runs premium (`docs/acsm-write-path.md` §6).

## Files

| File | What it is |
|---|---|
| `docker-compose.yml` | Premium service by default, `oss` profile for the public image |
| `Dockerfile.premium` | Builds an image from the release zip in `premium/` |
| `entrypoint.sh` | Renders the config at boot, then checks there's a server to run |
| `config.template.yml` | The premium service's config, with `__STEAM_*__` placeholders |
| `config.oss.yml` | The same thing with blanks, for the `oss` profile |
| `.env.example` | Copy to `.env`; holds the image names and harness credentials |

There is deliberately no tracked `config.yml`. The entrypoint writes one into
the container at boot from the template plus `.env`, which is what keeps the
Steam credentials out of git.

`premium/*.zip` and `.env` are both gitignored — the zip is licensed software
and the `.env` holds a password.
