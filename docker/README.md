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

`npm run recon:forms` records the version it captured against and writes
`fixtures/recon/forms-<version>.json`, so a 2.4.5 run later produces a diff
rather than silently replacing a 1.7.x answer.

## Setup

The premium build isn't published as a Docker image, so build one from the
release zip you already have:

```sh
cd docker
cp .env.example .env
cp /path/to/server-manager-premium-*.zip premium/
docker build -f Dockerfile.premium -t champctl/acsm-premium:local .
docker compose up -d
```

Then open <http://127.0.0.1:8772>, log in with **admin / servermanager**, and set
a real password when ACSM insists. Put that password in `docker/.env` as
`CHAMPCTL_LIVE_PASSWORD`.

The public build needs no zip:

```sh
docker compose --profile oss up -d   # http://127.0.0.1:8773
```

It's worth having around — champctl should degrade sanely on the version most
other leagues run — but see the caveats below.

## Steam credentials are required

There is no content-free mode. Server Manager runs steamcmd whenever
`install_path` has no executable in it, and blank credentials don't prevent
that — they just make it fail with `exit status 4`. An earlier version of this
harness tried a placeholder `acServer` to satisfy the check; Server Manager ran
steamcmd anyway.

Anonymous doesn't help either. Tested directly:

```
$ steamcmd +login anonymous +app_update 302550 +quit
ERROR! Failed to install app '302550' (No subscription)
```

So the account has to **own Assetto Corsa**. The dedicated server is a free
download, but only to owners.

Put the credentials in `docker/.env`:

```
STEAM_USERNAME=your-steam-account
STEAM_PASSWORD=...
```

The entrypoint checks them before starting Server Manager, so a bad login is a
sentence in the logs rather than a number in the UI.

### Steam Guard

steamcmd can't prompt for a Steam Guard code when Server Manager runs it in the
background — that's what `exit status 4` usually means. Rather than turning
Steam Guard off, log in once with a terminal attached:

```sh
npm run harness:steam-login
```

That does the login *and* the `app_update 302550` download in one go, into the
same volume Server Manager reads, so afterwards the container comes straight
up. The credential cache lives in `/home/assetto/steamcmd`, a named volume, so
later non-interactive logins succeed too.

`npm run harness:reset` wipes that volume and you'll need to run it again.
`harness:down` + `harness:up` keeps it.

### What you get

Stock content only. BATL's mod tracks still need the `scan` pit-count source
(plan §4.5), so `/content/tracks/{track}/ui/ui_track.json` will answer for
Spa and Silverstone but not for whatever mod track is on the schedule.

Expect a few minutes on the first download; the compose healthcheck allows for
it. `npm run harness:logs` to watch.

### Troubleshooting

**steamcmd exit codes**, as reported by Server Manager. Verified by running
them:

| | |
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
docker compose down
docker build -f Dockerfile.premium -t champctl/acsm-premium:local .
docker compose up -d
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

The `oss` profile mounts `config.oss.yml` instead — a plain copy with blanks —
because the upstream image ships its own entrypoint and would never render the
template. Change one, change the other.

## Using it

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

The container has **no Assetto Corsa content**: no steamcmd credentials, no
tracks, no cars. That's deliberate — it boots in seconds and everything the
recon needs works against arbitrary track names, because championship import
doesn't validate them.

Answers you get:

- **Whether `EntryList.EntrantID` is on the championship event form.** The big
  one. If it isn't, every save renumbers pit boxes to list position and BATL's
  assignments only survive because nobody has saved that form
  (`docs/acsm-write-path.md` §2).
- **Whether duplicate pit boxes delete entrants.** `AddInPitBox` overwrites, so
  this decides whether gridmom's ERROR means "unfair race" or "three people
  vanish next time anyone edits this".
- **The import form's file field name**, and whether import is still a single
  file part with no companion fields.
- **The round-trip delta** — which fields ACSM rewrites on import, and whether
  `PracticeEntryListType` really does get silently changed from 2 to 1.
- **The schedule endpoint's field names**, which is recon item 4.
- **The entrant approve/reject URL shape**, which is recon item 5 — and the
  router says it's a GET, not a POST.

Answers you don't get:

- **Pit counts, unless you configure Steam credentials.** See the content
  section above.
- **Anything version-specific, if you're running an older zip than BATL.** See
  "Which version to run".
- **Anything about BATL's actual data.** This is an empty manager.
- **On the OSS profile: `/api/championships/list.json`, `standings.json` and
  `penalties-log.json`.** They aren't in the public build's router at all, which
  is the evidence that BATL runs premium (`docs/acsm-write-path.md` §6).

## Files

| | |
|---|---|
| `docker-compose.yml` | Premium service by default, `oss` profile for the public image |
| `Dockerfile.premium` | Builds an image from a release zip in `premium/` |
| `config.yml` | Monitoring off, no steam credentials, fixed session key |
| `.env.example` | Copy to `.env`; holds the image name and harness credentials |

`premium/*.zip` and `.env` are both gitignored — the zip is licensed software
and the `.env` holds a password.
