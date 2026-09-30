# Deploying champctl

How to run champctl for a league on a Docker host, behind a reverse proxy you
already have. For what each program does, see the [README](../README.md); for
the Discord side, [discord-bot-setup.md](discord-bot-setup.md).

Everything lives in `deploy/`: a `compose.yml`, and examples of the three files
you fill in. The image is built from the `Dockerfile` at the repo root. It is
unrelated to `docker/`, which is a throwaway ACSM for tests.

## What runs

| Service  | What it is                         | Holds                 | Started by                      |
| -------- | ---------------------------------- | --------------------- | ------------------------------- |
| `serve`  | the web UI                         | nothing               | `docker compose up -d`          |
| `bot`    | answers `/livery` in Discord       | the Discord token     | `--profile discord`             |
| `drain`  | puts queued liveries on the server | the ACSM account      | `--profile discord`             |
| `upload` | one-time upload links, the carset  | nothing               | `--profile discord`             |
| `report`, `announce`, `standings`, `archive` | one-shot jobs | per job      | cron, via `docker compose run`  |
| `cli`, `admin` | any other command, by hand   | nothing / ACSM account | `docker compose run`           |

The split in the "Holds" column is deliberate and is the reason there are four
long-running services rather than one. The web UI has no credentials of its
own: each admin signs in with their own ACSM account, and the session is held
in memory for an hour.

champctl talks to Server Manager only over HTTPS. It needs no access to the
ACSM host's filesystem and can run anywhere that reaches it. Its reads rely on
**Public Access** being on in Server Manager.

All state is in one named volume, `champctl-data`: the response cache, the
championship archive and the livery queue. Configuration is read-only, from
`deploy/config/`.

## Setting up

You need Docker with Compose v2, and a reverse proxy that terminates TLS.

```sh
git clone https://github.com/mishan/acsm-champctl.git
cd acsm-champctl/deploy

cp .env.example .env
mkdir config
cp ../profiles/batl.json config/profile.json
cp ../data/track-pits.example.json config/track-pits.json
```

- **`config/profile.json`** is the league profile. Start from the shipped one
  and edit it; if you run the Discord bot, this is where its `discord` block
  goes (see [discord-bot-setup.md](discord-bot-setup.md#4-configure-the-profile)).
- **`config/track-pits.json`** is the pit-box count per track, which gridmom
  checks grids against. It must exist: a configured pit table that can't be
  read stops champctl at start rather than letting every grid check pass
  without pit counts. See the README's Configuration section for the format.
- **`.env`** is read by Compose only, for the listen addresses below. Nothing in
  it reaches a container.

Then:

```sh
docker compose build
docker compose up -d
docker compose ps        # serve should be "healthy" within a few seconds
```

### The reverse proxy

`serve` listens on `127.0.0.1:3000` on the host. To put it somewhere else, set
`CHAMPCTL_SERVE_LISTEN` in `.env`, for example `10.0.0.5:3000` for a proxy on
another machine. Whatever can reach that port is trusted to say which client
address a request came from, because the failed-login throttle counts by it.

Three things the proxy has to do:

1. **Serve it over HTTPS.** The session cookie is `Secure`, so over plain HTTP a
   login won't stick.
2. **Pass the original `Host` header through, port included.** Every write is
   checked by comparing the browser's `Origin` with `Host`, and a proxy that
   rewrites `Host` makes every write fail with 403. Caddy keeps it by default;
   nginx needs `proxy_set_header Host $http_host` (not `$host`, which drops a
   non-default port).
3. **Set `X-Forwarded-For` to the client's address, replacing what the client
   sent.** champctl takes the first address in that header as the client, so a
   proxy that appends to a client-supplied one lets anyone pick a fresh address
   per login attempt and step around the failed-login throttle. Caddy replaces
   it by default; in nginx, use `$remote_addr` rather than
   `$proxy_add_x_forwarded_for`.

Caddy:

```
champctl.example.com {
	reverse_proxy 127.0.0.1:3000
}
```

nginx:

```nginx
server {
    listen 443 ssl;
    server_name champctl.example.com;
    # ssl_certificate ...

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## The Discord bot and liveries

Follow [discord-bot-setup.md](discord-bot-setup.md) for the Discord side: the
application, the token, the channel and role ids. It describes running each
process by hand; here Compose does that, and the mapping is:

- **The token** goes in `deploy/bot.env` (from `bot.env.example`).
- **The ACSM account** for the drain goes in `deploy/acsm.env` (from
  `acsm.env.example`). Make an ACSM account for champctl rather than using a
  person's, so its writes can be told apart and revoked separately.
- **The shared database** is already set up: all three services open
  `data/liveries/liveries.db` in the volume.
- **The championship to drain** is `CHAMPCTL_LIVERY_CHAMPIONSHIP` in `.env`.
  Change it and run `docker compose --profile discord up -d` when a new
  championship starts.

```sh
chmod 600 bot.env acsm.env

# Register the slash commands once, and again after an upgrade that changes them.
docker compose run --rm bot champctl-bot serve --register-only

docker compose --profile discord up -d
```

### The upload server

`upload` listens on `127.0.0.1:8477` (`CHAMPCTL_UPLOAD_LISTEN` in `.env`). It
needs its own public HTTPS name, because the one-time token is part of the URL
and the bot refuses to hand out a link that isn't https. Set that name as
`discord.livery.uploadBaseUrl` in the profile.

Two settings the proxy needs for it, beyond the three above:

- **A body limit a little over 128 MB**, and read timeouts long enough for a
  slow upload. The largest upload champctl accepts is 128 MB of skin plus the
  zip's own overhead, so nginx needs `client_max_body_size 129m;` (its default
  is 1 MB). At exactly `128m` a maximum-size upload gets nginx's error page
  rather than champctl's explanation.
- **No access log for `/u/`**, since the path is the token. In nginx,
  `location /u/ { access_log off; proxy_pass ...; }`.

## Scheduled jobs

Nothing in the containers schedules itself. Run the one-shot jobs from the
host's crontab. `-T` because cron has no terminal:

```cron
# m  h  dom mon dow  command
CHAMPCTL=/opt/acsm-champctl/deploy

# Nightly: check every championship, and keep a copy of every export.
0  4  *   *   *    cd $CHAMPCTL && docker compose run --rm -T report
30 4  *   *   *    cd $CHAMPCTL && docker compose run --rm -T archive

# Weekly: announce the next round of a championship, the day before.
0  18 *   *   2    cd $CHAMPCTL && docker compose run --rm -T announce <championship-id>
```

`standings <championship-id>` works the same way. Each job takes the options
its command documents, after the service name: `docker compose run --rm
report --dry-run` prints what it would post without posting it.

The report exits 1 when it found warnings, and 2 for errors or a championship it
couldn't read. That is the report working, not failing; exit 3 is the job
itself failing.

## Running other commands

```sh
docker compose run --rm cli gridmom list
docker compose run --rm cli gridmom check <championship-id>
docker compose run --rm admin champctl-finalize <championship-id> 3 --laps 18
docker compose run --rm admin champctl-liveries <championship-id> --claims
```

`cli` holds no secrets. `admin` has the ACSM account from `acsm.env`, for the
commands that write. Both prompt before writing and take `--yes` in a script.

## Upgrading

```sh
cd acsm-champctl
git pull
cd deploy
docker compose build
docker compose --profile discord up -d     # or without --profile, for the UI alone
```

Restarting `serve` signs everyone out, since sessions are held in memory. The
drain finishes the pass it is on before stopping, which can take a few minutes
if it is in the middle of a large batch.

## Backups

The volume holds two things worth keeping: the archive
(`data/archive/archive.db`), which is history that can't be re-read from ACSM
once a championship is deleted, and the livery queue
(`data/liveries/liveries.db`). The cache under `.cache/` can be thrown away.

Both are SQLite. Copy them while nothing is writing — after the nightly archive
run, and with the Discord services stopped if you run them. As a script for
cron to call (not inline in the crontab, where `%` needs escaping):

```sh
#!/bin/sh
set -e
cd /opt/acsm-champctl/deploy
docker compose --profile discord stop     # skip both --profile lines without the bot
docker run --rm -v champctl_champctl-data:/data:ro -v /srv/backups:/out busybox \
  tar czf "/out/champctl-$(date +%F).tgz" -C /data data
docker compose --profile discord start
```

The databases contain driver names and Steam GUIDs. Keep the backups as private
as the server.

## When something is wrong

- **Logs:** `docker compose logs -f serve`, and the same for `bot`, `drain`,
  `upload`. A failed request to Server Manager is logged with the reason,
  which the browser deliberately isn't told.
- **The drain has stopped, or keeps restarting:** it exits 3 when ACSM refuses
  its account, and when `CHAMPCTL_LIVERY_CHAMPIONSHIP` isn't set in `.env`.
  `docker compose logs drain` says which. After five failed starts it stays
  stopped; fix the cause and run `docker compose --profile discord up -d`.
- **A login in the UI doesn't stick:** it isn't being served over HTTPS.
- **Every save fails with 403:** the proxy is rewriting `Host`.
- **"Server Manager answered with a web page where champctl expected data":**
  Public Access is off in Server Manager, or a Server Manager upgrade has
  moved an endpoint behind its login. The log says which request it was.
