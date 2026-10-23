# Configuration

**League profile.** BATL's baseline is `profiles/batl.json`; another league
drops in their own and passes `--profile ./my-league.json`. It holds the ACSM
base URL, the race weekday and quali time, the timezone, and the defaults
gridmom compares against.

Two profile fields are load-bearing for a check rather than cosmetic, and both
turn one *on*:

`entryList.raceNumberFromSkin`, a regex for how your skin folder names encode a
race number. ACSM has no race number field, so without it the duplicate-race-
number check doesn't run — guessing at digits inside arbitrary skin names finds
a "duplicate" in every entry list.

`entryList.uniqueSkins`, if your league expects everyone to have their own. Off
by default, because most leagues share skins — not everyone has one — and this
check used to read ACSM's `AllowDuplicateSkinChoices` instead. That field is
`false` in every export anyone has looked at, which is Go's zero value rather
than a rule, so a normal entry list produced a screenful of errors that blocked
every push and buried the findings that mattered.

`excludedCarModels` is league furniture: cars that are always in the list and
never worth a finding. BATL's `ford_transit` runs in every race for the stream,
so naming it here stops both the car-list checks reporting it — whatever the
spectator car setting says, since `SpectatorCar.Model` is empty on a real BATL
export and there is nothing there to recognize the van by. Forgiven for being
present, never required to be.

`formats` is the league's own shorthand — BATL's `1x40` and `2x20` — offered as
one-tap starting points in the web UI. They live in the profile rather than in
the UI because they are league convention: another league's names and numbers
should be a config change, not a fork.

```json
"formats": [
  { "name": "1x40", "length": { "kind": "minutes", "minutes": 40 },
    "reversedGridPositions": 0, "mandatoryPit": true, "extraLap": false }
]
```

**Track pit counts.** `data/track-pits.json`, an array of records — see
[`data/track-pits.example.json`](../data/track-pits.example.json). Three sources,
with `manual` always winning, because mod tracks routinely lie in their ui file.
The file is gitignored: it's league data, not code. Without it the grid checks
degrade to a warning that the pit count is unknown rather than guessing.

**Discord.** Channel ids as "Copy Channel ID" gives them — 17 to 20 digits, not
a name and not a link, both of which would otherwise fail at post time on a job
nobody watches. They live in the profile rather than the environment because a
channel id is league configuration, not a secret; the token is the secret and
stays in `CHAMPCTL_DISCORD_TOKEN`. `profiles/batl.json` deliberately ships
without either, since a committed channel id is a channel every fork posts into.

```json
"discord": {
  "adminChannelId": "1234567890123456789",
  "announceChannelId": "9876543210987654321",
  "trophyChannelId": "1122334455667788990",
  "announce": { "format": false, "signUp": false },
  "guildId": "1234567890123456789",
  "livery": {
    "channelIds": ["1234567890123456789"],
    "roleIds": ["1234567890123456789"],
    "autoApply": false,
    "uploadBaseUrl": "https://liveries.example.com",
    "championshipId": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
  },
  "qualiVoiceMove": {
    "fromChannelId": "1234567890123456789",
    "toChannelId": "9876543210987654321"
  }
}
```

The bot's optional features — `incidents`, `season`, `racers`, standings after a round —
have their own keys under `discord`, each described with its step in
[`discord-bot-setup.md`](discord-bot-setup.md).

`qualiVoiceMove` has `champctl-bot serve` move everyone in one voice channel to
another once ACSM says a round's qualifying has started. BATL uses it to move
Pit Lane to Race Control. See
[`discord-bot-setup.md`](discord-bot-setup.md) step 11.

`announce` trims the parts of an announcement champctl says, because ACSM has
its own Discord integration and BATL already has it switched on — so some of
this is said twice by default. Which parts overlap depends on how that
integration is configured, which champctl cannot see, so the league decides
rather than champctl guessing. The four parts are `track`, `quali`, `format` and
`signUp`, all on unless named. An unknown key is an error rather than ignored: a
typo in an opt-*out* block is silent in the worst direction, since `"quail":
false` leaves quali on while reading, to whoever wrote it, as already off.

`guildId` is where `/livery` is registered — per server rather than globally,
because guild commands update the moment `champctl-bot serve` starts and global
ones propagate on Discord's schedule.

`channelIds` and `roleIds` are **ANDed, and an empty or absent list means
unrestricted**. Worth reading twice: a league that sets `roleIds` and leaves
`channelIds` out has accepted uploads in every channel the bot can see. Setting
`roleIds` also confines uploads to the server, since a DM has no member and no
roles for a clamp to check.

`championshipId` is optional and pins which championship uploads belong to. The
bot works it out from the manager otherwise, and refuses when the answer is
ambiguous — nought unfinished championships and two are both cases where
quietly choosing one puts a livery on the wrong car. A league running a second
series wants this set.

Omitting `livery` entirely means the league has no self-serve uploads and
`champctl-bot serve` refuses to start, rather than registering commands that
accept anything from anyone.

**Where the shared database lives.** `CHAMPCTL_STORE`, read by
`champctl-liveries`, `champctl-bot` and `champctl-upload` alike, and overridden
by `--store`. The three processes must open the same file — the queue is the
only thing they share and it is what the credential split is built on — so put
it in the environment file rather than trusting three working directories to
agree.

**Defaults for every command.** `CHAMPCTL_PROFILE` and `CHAMPCTL_PITS` stand
in for `--profile` and `--pits` when those aren't given, so a deployment names
its league once. A `CHAMPCTL_PITS` that can't be read is an error, as an
explicit `--pits` is; only the built-in default may be missing.

**Credentials.** `CHAMPCTL_USERNAME` and `CHAMPCTL_PASSWORD`, read from the
environment and never written to disk. Only the write *commands* need them —
`champctl-serve` deliberately does not read them at all, because a long-running
service holding an admin password in its environment is one exposed endpoint
away from being an admin password anyone can spend.

**Cache.** Responses are cached in `.cache/acsm/cache.db` for five minutes, so
re-running gridmom while fixing a pit box costs one request. It holds whole
response bodies — entry lists, so driver names and Steam GUIDs — and is created
`0600` inside a `0700` directory. `--no-cache` bypasses it.
