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

## Assetto Corsa content

steamcmd is installed in the image, because Server Manager looks for it on
`$PATH` at boot and complains when it's missing even with no credentials set.

Whether it actually downloads anything is up to `docker/.env`:

- **`STEAM_USERNAME` blank** (the default) — no content. The container boots in
  seconds. Import, export, the round trip and every form recon target work
  fine; only track pit counts don't, because
  `/content/tracks/{track}/ui/ui_track.json` has nothing to serve.
- **`STEAM_USERNAME` / `STEAM_PASSWORD` set** — Server Manager installs the
  Assetto Corsa dedicated server on first boot. It's free but needs an account
  that **owns Assetto Corsa**, and SteamGuard has to be off, since steamcmd
  can't prompt for a code from inside the container. Expect a few minutes;
  watch it with `npm run harness:logs`.

That gets you stock tracks only. BATL's mod tracks still need the `scan`
pit-count source (plan §4.5).

Note that `npm run harness:reset` removes the steamcmd volume too, so the next
boot re-downloads. Use `harness:down` + `harness:up` to keep the content and
just restart.

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
