# Setting up the Discord bot

How to get `champctl-bot` running, from an empty Discord server to a driver
uploading their own livery. Follow it in order; each step checks the one before
it.

This is the operator's runbook. Why the design is shaped this way — the identity
mapping, the size limits, the credential split — is
[`docs/discord-livery-upload.md`](discord-livery-upload.md). Full flag lists are
in the [README](../README.md).

## What you end up running

Three processes, and the split between them is the point rather than an
accident of deployment:

| Process | Holds | Does |
| --- | --- | --- |
| `champctl-bot serve` | Discord token | Answers `/livery`. Writes uploads to the queue. |
| `champctl-liveries --drain --push --watch` | ACSM credentials | Takes the queue and puts it on the game server. |
| `champctl-upload` | nothing | Serves one-time upload links and the carset download. |

**No process holds two of those things, and there is no flag that would give it
them.** The bot cannot write to your game server; the upload server — the one
facing the open internet — has nothing worth stealing. What they share is one
SQLite file, and that is deliberately the only thing they share.

You need the first two. The third is optional and covered in step 8.

## Before you start

- champctl installed, with `acsmBaseUrl` set in your league profile and the
  championship export readable — `champctl-liveries <championship-id> --drain`
  with no `--push` is a preview that reads it and writes nothing. The bot is a
  front end for machinery that has to work first.
- Permission to add an application to your Discord server.
- A championship in ACSM with an entry list. Drivers claim names off it, so an
  empty entry list means nobody can claim anything.

## 1. Create the application

At <https://discord.com/developers/applications>, **New Application**, name it
whatever the league should see. Under **Bot**, **Reset Token**, and copy what it
gives you — Discord shows it once.

Put it in the environment:

```sh
export CHAMPCTL_DISCORD_TOKEN='…'
```

**There is no `--token` flag,** and that is on purpose: a token on a command
line is in your shell history and in every `ps` listing on the box. `champctl-bot`
errors if you try.

You do not need to enable any Privileged Gateway Intents, and you should not.
champctl requests none: intents are a subscription to events, and interactions
arrive without one. The roles and channel an upload clamp checks come in the
interaction payload rather than from `GuildMembers`.

This is why `/livery upload` takes an attachment rather than a zip posted as an
ordinary message. Reading it off a message would need `MessageContent`, which is
privileged — and would let this token read every message in every channel it can
see. Asking for nothing means the token can do nothing but talk and answer.

## 2. Invite it to your server

**OAuth2 → URL Generator.** Tick two scopes:

- `bot`
- `applications.commands` — **easy to miss, and the failure is confusing.**
  Without it the bot logs in fine and then cannot register `/livery`; you get
  `Could not register commands in guild …` at startup. If you already invited it
  without this, re-invite with the box ticked — the same URL over an existing
  install just adds the scope.

Under bot permissions, **Send Messages** is enough. Open the generated URL and
add it to the server.

## 3. Collect the two ids

In Discord, **User Settings → Advanced → Developer Mode** on. Then right-click:

- the **server** → Copy Server ID — this is `guildId`
- the **admin channel** → Copy Channel ID — this is `adminChannelId`

Both are 17–20 digits. A name or a link will fail at post time, on a job nobody
is watching.

Make the admin channel one the league cannot read. Claim announcements name
Discord accounts alongside entry list names, and the nightly report quotes the
entry list — none of it is secret, since the ACSM export is public, but "these
three people are about to be dropped from the grid" is not a thing to say in
front of everyone before anyone has looked at it.

## 4. Configure the profile

In your league profile (`profiles/batl.json`, or your own):

```json
"discord": {
  "adminChannelId": "1234567890123456789",
  "guildId": "1234567890123456789",
  "livery": {
    "channelIds": ["1234567890123456789"],
    "roleIds": ["1234567890123456789"],
    "autoApply": false
  }
}
```

Ids live in the profile rather than the environment because a channel id is
league configuration, not a secret. The token is the secret.

Three things to get right:

- **`livery` must be present or `serve` refuses to start.** Absent means the
  league has no self-serve uploads, and champctl would rather not start than
  register commands that accept anything from anyone.
- **`channelIds` and `roleIds` are ANDed, and an empty or absent list means
  unrestricted.** Worth reading twice: set `roleIds` and leave `channelIds` out
  and you have accepted uploads in every channel the bot can see. Setting
  `roleIds` also confines uploads to the server, since a DM has no member and no
  roles for a clamp to check.
- **Leave `autoApply` off for now.** Step 7 turns it on, once there is something
  to apply the uploads.

`championshipId` is optional. The bot works out which championship uploads
belong to from the manager, and refuses when the answer is ambiguous — nought
unfinished championships and two are both cases where quietly choosing one puts
a livery on the wrong car. If you run a second series, pin it here.

## 5. Decide where the shared database lives

All three processes open the same SQLite file. It holds the queue, the claims
and the upload tokens, and it is what the credential split is built on.

```sh
export CHAMPCTL_STORE=/var/lib/champctl/liveries.db
```

Without it, each process defaults to `data/liveries/liveries.db` **relative to
its own working directory** — which is the one way to get three processes
quietly using three different databases, where the bot accepts uploads that the
drain never sees. Set it explicitly, to an absolute path, in every unit or shell
that starts one of them.

## 6. Register the commands

Check the wiring before committing to a long-running process:

```sh
champctl-bot serve --register-only
```

It connects, publishes `/livery`, prints `Registered /livery in <guild>`, and
exits. `/livery` should appear in Discord immediately — commands are registered
per guild rather than globally precisely so they update the moment this runs,
instead of propagating on Discord's schedule and leaving drivers a renamed
option for an hour.

Then start it properly:

```sh
champctl-bot serve
```

It prints where uploads are going and stays up until stopped. Run it under
systemd or whatever supervises the rest of your league; it exits cleanly on
SIGINT and SIGTERM, closing the database last so the drain never reads a queue
whose write-ahead log was not checkpointed.

At this point drivers can claim and upload, and **nothing reaches the game
server yet.** That is the next step, not a fault.

## 7. Run the drain

This is the process that holds ACSM credentials, and the only one that writes to
the game server:

```sh
export CHAMPCTL_USERNAME='…'
export CHAMPCTL_PASSWORD='…'
champctl-liveries <championship-id> --drain --push --watch
```

Do one pass by hand first, without `--watch`, and read what it says before
letting it loop.

Liveries appear at the next practice start. The drain never restarts a practice
session — a driver uploading at 8pm must not be able to disconnect everyone in
practice over a cosmetic change — and the bot's reply tells them so.

**Now turn on `autoApply`** in the profile and restart the bot. The setting is
only ever a promise about this drain, and the bot checks rather than trusts it:
it looks for a heartbeat the drain writes on every pass, including empty ones,
and if the last one is more than 30 minutes old it goes back to telling drivers
an admin will apply their upload. So `autoApply` with no watcher running does
not mislead anyone — but it does not do anything either.

## 8. Optional: the upload server

Two things need this, and both are the same problem — a file too big for a chat
client to carry:

- a driver whose zip is over their Discord tier's ceiling, which Discord refuses
  on their machine before the bot ever hears about it
- the carset: every livery at once, so larger by construction than any single
  upload

```sh
champctl-upload --port 8477 --host 127.0.0.1
```

Bind it to localhost and put a TLS terminator in front. **The link has to be
https** — the token travels in the URL, so plain HTTP puts a bearer credential in
every proxy log between the driver and the server, and champctl refuses to mint
a link that would rather than downgrading quietly. `http://localhost` is allowed
while you are developing.

Then point the bot at it:

```json
"livery": { "uploadBaseUrl": "https://liveries.example.com" }
```

Restart the bot, and `/livery upload-url` and `/livery carset` start working.
A mount path is fine — `https://example.com/champctl/` works, and champctl
matches the links it minted under it.

## 9. Check it end to end

As a driver, in a channel the clamp allows:

1. `/livery claim` with your name **exactly** as the entry list spells it. The
   admin channel gets a line saying who claimed what, and whether the sign-up
   form agrees. That announcement is the whole verification story — read it.
2. `/livery upload` with a zip of your skin folder: a `.dds`, its
   `preview.jpg`, and `ui_skin.json`.
3. `champctl-liveries <id> --claims` should list you.
4. Within an interval or two, the drain logs what it applied.
5. `/livery carset` hands back everyone's liveries as one archive for Content
   Manager, if you set up step 8.

Replies are ephemeral — only the driver sees them. Refusals name what was wrong
with the file, so a driver can fix it without an admin.

## 10. The nightly report

Separate from all of the above and worth having regardless: `champctl-bot
report` posts what gridmom found into `adminChannelId`. It is a one-shot command
for cron or a timer, not a service, and it needs no `guildId` and no `livery`
section.

```sh
champctl-bot report
```

Exit codes let a timer decide whether to page anyone: `0` nothing worth
reporting, `1` warnings only, `2` at least one error or a championship that
could not be read, `3` the run itself failed. `--dry-run` prints what it would
post and talks to nobody.

## When it doesn't work

| What you see | What it is |
| --- | --- |
| `Could not register commands in guild …` | The bot was invited without `applications.commands`. Re-invite it with the scope ticked (step 2). |
| `No Discord server. Set discord.guildId …` | `guildId` missing from the profile. `serve` refuses before connecting rather than logging in and having nowhere to publish. |
| `This profile has no discord.livery section …` | Add one. An empty object works but accepts uploads from anyone, anywhere. |
| `/livery` missing in Discord | Registered in a different guild, or the bot is not in this server. Re-run `--register-only` and read the guild id it prints. |
| Uploads accepted, nothing on the server | The drain is not running, or it is on a different `CHAMPCTL_STORE`. Check `champctl-liveries <id> --drain` by hand. |
| Drivers told an admin will apply it, with `autoApply` on | No drain heartbeat in the last 30 minutes. The watcher is not running (step 7). |
| `"…" isn't on the entry list` | The name must match exactly. Check spacing and case against ACSM. |
| Bot answers in one channel but not another | `channelIds` clamp. Empty or absent means anywhere; a list means only those. |

## What the bot cannot do

Worth knowing before you give it a permission it does not need. `champctl-bot`
holds no ACSM credentials on any code path, and `src/bot/` importing anything
from the write path is a failing test rather than a code review note. Everything
it can do to a league is say something in a channel and write a driver's zip to
a local queue. Applying that queue is a separate process, run by you, holding
credentials you gave it.
