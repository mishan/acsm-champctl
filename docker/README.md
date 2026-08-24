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
`CHAMPCTL_LIVE_URL` at `ac.batlracing.com`. The container also binds to
`127.0.0.1` by default, because it holds an admin account whose password is
written down in a file next to it.

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

- **Pit counts.** `/content/tracks/{track}/ui/ui_track.json` exists but has
  nothing to serve without content installed. To exercise it, fill in the steam
  credentials in `config.yml` for one boot, or bind-mount a real content folder.
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
