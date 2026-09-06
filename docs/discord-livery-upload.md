# Self-serve livery upload via the Discord bot

Status: plan. Nothing here is built.

`champctl-liveries` already does the hard half — read an untrusted zip, match it
to the entry list, upload it, assign it. What it does not do is get the zip. A
driver still sends it to an operator, who saves it, drops it in a folder named
after the car, re-zips the lot and runs the CLI. This is the plan for removing
that person.

Read `src/liveries/pack.ts`, `plan.ts` and `apply.ts` first. This document adds
a front end to them and changes neither.

---

## 0. Prerequisite: merge `main`

This branch is off `champ-form-recon`, which predates the bot. `src/bot/`,
`src/cli/bot.ts`, `LeagueProfile.discord` and `test/bot.test.ts` all live on
`main` and all of them are load-bearing here.

The merge was tried and is small: two conflicts, both textual — the Status list
in `README.md` and the `bin`/`scripts` blocks in `package.json`. Do it as the
first commit on this branch rather than at the end, because §1 is an argument
about a test that only exists on `main`.

---

## 1. The constraint, which is the whole design

Plan §7, first line: **the bot holds no ACSM credentials. Ever.** Writes do not
happen; the bot produces a proposal and a human applies it under their own
login.

This is not a preference. `test/bot.test.ts` enforces it structurally — it reads
every `.ts` file under `src/bot/` and fails if any of them imports
`acsm/session.js`, `acsm/write.js`, `finalize/apply.js`, `reorder/apply.js` or
anything under `web/`. Its own comment says why:

> the bot is the component most likely to grow a "just this once" convenience,
> since it is the one already holding a poll result someone wants applied.

A livery upload is exactly that convenience, one turn further along. The bot
holds a zip somebody wants uploaded, and `applyLiveries` is right there.

So the first design question is not "how does the bot upload a livery". It is
"how does a driver's zip reach ACSM without the Discord-facing process ever
having been able to send it there itself".

### Three answers, and the one to take

**(a) Give the bot credentials.** Delete the test, add
`CHAMPCTL_USERNAME`/`CHAMPCTL_PASSWORD` to `champctl-bot`. Now a process that
accepts arbitrary bytes from anyone in a Discord server also holds write access
to the league's server manager, and the only thing between them is
`pack.ts`. That is a lot of weight on one allowlist. Rejected.

**(b) Proposal only, exactly as §7 says.** The bot validates the zip, stashes
it, and posts the operator a link into `champctl-serve`: "Misha submitted a
livery for `rss_formula_hybrid_2021` — review and apply." A human clicks under
their own login.

This is honest and it is a real improvement — the operator stops handling files
— but it is not self-serve. Every upload still waits on a person, which on a
Wednesday evening is the same bottleneck in a nicer coat.

**(c) Split the process.** Take it.

The Discord-facing process and the ACSM-writing process are two programs that
share a queue and never share a secret:

```
  champctl-bot                    champctl-liveries drain
  ─────────────                   ───────────────────────
  CHAMPCTL_DISCORD_TOKEN          CHAMPCTL_USERNAME / _PASSWORD
  no ACSM credentials             no Discord token
  imports nothing from            imports nothing from
    the write path                  src/bot/
        │                                   ▲
        │  validated pack + submission row  │
        ▼                                   │
        ══════════ the queue (SQLite + blobs) ══════════
```

`test/bot.test.ts` keeps passing unmodified, because it is still literally true
that nothing under `src/bot/` reaches the write path. That is the test to check
this design against: if satisfying it needs the allowlist widened, the design is
wrong.

And it gives the league a dial rather than a fork. The drainer running on a
timer is self-serve; the drainer never running and the operator clicking a link
in `champctl-serve` is (b). Same queue, same engine, same refusals — one config
line apart. Default is off.

---

## 2. Identity: which entrant is this Discord user?

`Entrant` has `Name`, `GUID`, `Team`, `Model`, `Skin`, `PitBox`, `Ballast`,
`Restrictor`, `SpectatorMode`, `InternalUUID`, `GuidsList`. There is nowhere to
put a Discord handle, and nothing else in ACSM holds one either — see below,
where that claim is checked against the source rather than assumed.

`planLiveries` matches on `Entrant.Name`, exactly, NFC-normalised. So the
question is how to get from a Discord user to an entrant name.

### Do not match on the Discord username

The obvious version — ask for the Discord username on the sign-up form, compare
it to `interaction.user.username` — is wrong, and it fails quietly.

Usernames are mutable and were globally reissued in 2023 when Discord dropped
discriminators. A handle typed into a sign-up form in March is not necessarily
the same handle in September, and the failure mode is a driver whose upload
stops working for a reason neither they nor the operator can see. Display names
and per-guild nicknames are worse.

The **user ID** is the stable key: a snowflake, permanent, and already in every
interaction payload. Match on that. The typed username is only ever a
first-time claim key — see below.

### What ACSM actually holds — measured, not guessed

Checked against the OSS source (`JustaPenguin/assetto-server-manager`, v1.7.10
tree), which premium 2.x descends from.

**There is no Discord identity anywhere in ACSM.** `Account` in `accounts.go`
is `ID, Created, Updated, Deleted, Name, Groups, DriverName, GUID, Team,
PasswordHash, PasswordSalt, DefaultPassword, LastSeenVersion,
HasSeenIntroPopup, Theme` — no Discord field. `Entrant` has none.
`discord.go` is outbound notifications plus one inbound command, `!notify`,
which toggles a configured role on the message author. That command reads
`m.Author.ID` and never stores it: it maps a Discord user to a *role*, never to
a driver. So ACSM knows nothing about who a Discord user is, by construction.

**The custom sign-up questions are real, and they are in the export.**
`ChampionshipSignUpForm.ExtraFields` is `[]string` — the question labels, and
nothing more; that answers recon item §10.3, which assumed something more
complicated. Each `ChampionshipSignUpResponse` carries
`Questions map[string]string`, filled in `HandleChampionshipSignUp` by reading
`Question.{index}` off the form and keying it by the label. So a "Discord
username" question is a supported thing to add and its answers do land in the
championship JSON.

**But the export gates them on admin.** `ChampionshipsHandler.export`:

```go
if !account.HasGroupPrivilege(GroupAdmin) {
    // sign up responses are hidden for data protection reasons
    championship.SignUpForm.Responses = nil
}
```

That is deliberate and it is dated: the v1.7.0 changelog entry is "Admins can
now export full Championship information, including Sign Up Form responses."

This is worth being careful about because it contradicts two things already
written down here. Plan §5.3 says the responses are in the export and the export
is public; `src/acsm/types.ts` annotates `SignUpForm.Responses` **PUBLIC DATA**.
The likely explanation is that both were written from an export downloaded
through the UI while logged in as an admin, which is how anyone gets one. It
should be settled by one unauthenticated `curl` against BATL's premium instance
before either sentence is trusted further — see §10.

If the gate holds on premium, the consequence for *this* feature is exact:

> The bot cannot read the sign-up answers. The drainer can.

The credential split in §1 puts the Discord-facing process on the side of the
wall with no ACSM login, and admin-gated data is on the other side. That is not
an obstacle to routing around; it is the wall working.

### Where the mapping lives

**Not in the sign-up question, as the source of truth.** Two reasons, and the
second is the one that decides it.

It is a self-typed *username*, not a snowflake, so §2's first argument applies
in full: it goes stale on a rename and fails silently.

And **it is publicly writable by anyone who knows a driver's Steam GUID.**
`HandleChampionshipSignUp` upserts by GUID —

```go
for index, response := range championship.SignUpForm.Responses {
    if response.GUID == signUpResponse.GUID {
        championship.SignUpForm.Responses[index] = signUpResponse
```

— and the GUID it compares is `r.FormValue("GUID")`, validated only against
`^[0-9]{17}(;[0-9]{17})*$`. There is no Steam verification on the POST.
`LockSteamGUID` disables the input in the rendered HTML and has no effect on the
handler. Meanwhile entrant GUIDs *are* in the public export — the strip above
touches `Responses` and `ReplacementPassword`, not `Classes[].Entrants[].GUID`.

So while sign-ups are open, anyone can POST the sign-up form with another
driver's public GUID and replace that driver's entire response, Discord handle
included. Sourcing authentication from a field the attacker can overwrite is not
a mapping; it is an invitation.

**In champctl, in the queue database.** A `driver_discord` table: Discord user
id, entrant name, when it was claimed, by whom. Same shape §8.2 already calls
for — a canonical driver with a mapping table beside it, names as display data
rather than join keys — so it is a table champctl needed anyway, arriving early.

**And use the sign-up answer as a hint, on the credentialed side.** This is the
part that changes given the above. The drainer holds admin credentials, so it
*can* read `Questions`. Have it sync a `suggested_discord_handle` column into
`driver_discord` on each run. That handle then does one job: when a driver runs
`/livery claim`, the bot checks whether their current Discord username matches
the suggestion and, if it does, says so in the admin announcement —

> Misha claimed "Misha" (matches the Discord handle on their sign-up).

An operator scanning the channel gets to skim the ones that agree and look at
the ones that don't. It is corroboration, never authentication, and it costs
nothing when the league never added the question.

### Claiming

Sign-ups happen in ACSM. champctl is not in that loop, so the mapping has to be
established some other way, and there are two:

- **`/livery claim name:<entrant name>`** — the driver names themselves once.
  The bot checks the entry list, refuses a name that isn't in it, refuses a name
  already claimed by a different Discord id, and records the pair. This is
  self-serve and it is also an unverified assertion: nothing stops someone
  claiming another driver's name before they do.
- **An operator command or a config file.** Verified, and someone has to do it
  thirty times.

Neither is right on its own. The answer is first-claim-wins with the claim
**announced** — every successful claim posts into the admin channel naming the
Discord user and the entrant. An impersonation attempt is then visible rather
than silent, and the cost of the attack is being named in front of the league
for the reward of putting a livery on somebody else's car, which is not a
threat model worth building a verification flow for.

Unclaim and re-claim are operator-only.

### Missing handle: refuse, and say what to do

The question in the request was whether to make the Discord handle mandatory or
to refuse uploads without it. Refuse.

Mandatory means editing the sign-up form and re-collecting from everyone who has
already signed up, which cannot be done retroactively and would block a livery
upload behind a change to a live championship. Refusing costs one command:

> I don't know which driver you are. Run `/livery claim name:<your entry list
> name>` — it has to match the entry list exactly, so if you're "Misha" there,
> "misha" won't do.

Fails closed, self-serve to fix, and no championship gets edited to enable it.

---

## 3. The upload surface

### A slash command, not a DM

The request says drivers should be able to send the bot a `.zip`. Two ways to
read that, and they are very different programs.

**Message with an attachment** needs the `MessageContent` privileged intent to
read anything about the message — and `src/bot/discord.ts` currently requests
*no* intents at all, deliberately: "the token this job runs under can do nothing
but talk". Turning on a privileged intent to receive files means the same token
can now read every message in every channel it can see.

**A slash command with an attachment option** — `/livery upload file:<zip>` —
needs no privileged intent. The attachment arrives in the interaction payload.
It also brings three things for free:

- `interaction.member.roles` is in the payload, so the role clamp needs no
  member fetch and no `GuildMembers` intent.
- `interaction.channelId` is in the payload, so the channel clamp is a string
  compare.
- Ephemeral replies, so a refusal — which will usually say something like "your
  zip has a leftover .psd in it" — is visible to the driver and not to the
  league.

Take the slash command. It is still "send the bot a zip" from where the driver
sits.

### The clamp

Both dials, both optional, both in the profile:

```jsonc
"discord": {
  "adminChannelId": "...",
  "livery": {
    "channelIds": ["..."],     // where /livery upload is accepted
    "roleIds": ["..."],        // who may run it
    "autoApply": false,        // §5
    "uploadBaseUrl": "https://..."  // optional, enables the link path below
  }
}
```

Absent `livery` means the league has no livery uploads and the commands are not
registered at all — same shape as `discord` being absent meaning no bot.

Three notes on the clamp:

- **A role clamp implies a guild clamp.** DMs have no member and no roles, so a
  `/livery` invoked in a DM cannot satisfy a role check. If `roleIds` is set,
  refuse DM invocations explicitly — with that sentence — rather than letting
  them fail as "you don't have the role", which is confusing to someone who
  does.
- **Register the commands guild-scoped, not globally.** Guild commands update
  immediately; global ones propagate on Discord's own schedule. This is a
  single-league bot.
- **Channel and role are ANDed, and empty means unrestricted.** Say that in the
  config comment, because a league that sets `roleIds` and leaves `channelIds`
  empty has accepted uploads in every channel the bot can see, and would rather
  have known.

Validate both as snowflakes in `validateProfile`, reusing the `^\d{17,20}$`
check and the "not a channel name and not a link" wording that is already there
for `adminChannelId`. That check exists because of what people paste.

### Size

Discord's own limit is far below champctl's, and drivers will hit Discord's
first. As of August 2026 a free account may attach 20 MB per file — doubled
from the 10 MB cap imposed two years earlier — while Nitro Basic is 50 MB and
Nitro 500 MB, and server boosting raises the floor for everyone in the guild.
`DEFAULT_LIMITS` in `pack.ts` allows 48 MB a file and 128 MB a skin. Confirm the
current numbers before putting any of them in help text; this one has moved
three times in three years.

So the practical ceiling on a bot upload is set by the submitting driver's
Discord tier, which champctl cannot see and should not guess. Do not hardcode a
number. Validate the attachment size that actually arrives against
`DEFAULT_LIMITS`, and when a driver reports "Your files are too powerful" and
never reaches the bot at all, the answer is documentation, not code: a 4K DDS
with mipmaps compresses, and the working `.psd`-in-a-`.png` layers that
`pack.ts` already refuses are usually what pushed it over.

Worth saying in the driver-facing help: **the bot cannot see an upload Discord
rejected.** A silent failure at that layer looks exactly like a bot that is
down.

### The way round it: a one-time upload link

For a driver whose zip is over their tier's ceiling, the bot can hand out a URL
champctl hosts itself and take the file over HTTP instead. `/livery upload-url`,
or offered automatically when an attachment is refused for size.

This is worth having for a second reason beyond size. It is the only path that
works when a driver's client refuses the upload outright — Discord's rejection
happens before the bot exists, so today that driver has no way to tell champctl
anything at all.

**Where it is hosted matters more than it looks.** Not `champctl-serve`: that
process holds ACSM credentials, and this endpoint is unauthenticated, internet-
facing and accepts tens of megabytes from a stranger. Put it in its own process
— `champctl-upload` — with no Discord token and no ACSM credentials, writing to
the same queue database as everything else. That is §1's argument applied a
third time, and the shape is now a rule rather than a one-off: **every process
that faces something untrusted has nothing worth stealing.**

The token:

- **256 bits of `crypto.randomBytes`, base64url.** It is the whole
  authentication, so it has to be unguessable rather than merely unique.
- **Stored as a SHA-256 hash**, compared in constant time. The queue database
  holds driver names and Discord ids already; it should not also be a drawer of
  live credentials.
- **Scoped at mint time** to the discord user id, championship, driver name and
  car model resolved in §2 and §8. The URL cannot be used to upload as someone
  else, because it does not carry a "who" for the uploader to change.
- **Short TTL** — thirty minutes is generous for "go and find the file".
- **One live token per driver.** Minting a second invalidates the first, so a
  driver who asks twice does not leave a spare lying in their message history.

**GET must not consume it.** Discord unfurls links, so the URL is fetched by
Discord's crawler within a second of being sent. If the token burned on GET,
every link would be dead before the driver clicked it — and it would look like
a bot bug rather than a design one. GET renders the upload form; POST consumes.
Send it with `<>` around it to suppress the unfurl too, but do not rely on that.

**HTTPS or refuse to mint.** The token is in the URL, so plain HTTP puts it in
the clear and in every proxy log on the way. `validateProfile` should reject a
`uploadBaseUrl` that is not `https://`, with a localhost exemption for
development, and the bot should refuse to mint rather than silently falling
back to asking for an attachment.

### Ephemeral reply, not a DM

The request said DM. An ephemeral interaction reply is better, and it is less
code.

A DM needs the bot to open a channel with the user, which fails if they have
DMs from server members turned off — a common and entirely reasonable setting,
and one that produces a confusing failure for a driver who did nothing wrong.
An ephemeral reply is visible only to the person who ran the command, arrives on
the interaction that is already in hand, and leaves nothing in the driver's
message history for someone looking over their shoulder later.

It also composes with §3's clamp rather than escaping it. A DM has no member and
no roles, so a flow that ends in a DM has already left the place where the role
check is meaningful; an ephemeral reply stays in the channel the command was
allowed in.

Keep DM as an explicit fallback only if the ephemeral path turns out to be
awkward on mobile, which is worth checking before assuming.

---

## 4. From one driver's zip to a `LiveryPack`

`readLiveryPack` expects a zip of zips — `car_model/DriverName.zip` — and
derives the driver name from the inner filename and the car model from the outer
folder. A driver submitting through Discord has neither. They have
`my_livery.zip` with a `.dds` and a preview loose inside it.

Both of the missing pieces are already known, and known **better** than the
filename knows them:

- the **driver name** comes from the identity mapping in §2, not from what they
  called the file;
- the **car model** comes from that entrant's `Entrant.Model` in the entry list,
  not from a folder they didn't create.

This is a strict improvement over the CLI path. `planLiveries` currently refuses
a pack where the folder disagrees with the entrant's car — "uploading it would
put the skin on a car they don't drive" — and that refusal becomes unreachable
here, because the model is read from the entrant in the first place.

### The change to `pack.ts`

`readOneLivery(carModel, driverName, innerBytes, limits, where)` is already
exactly the function needed and is module-private. Export a thin named wrapper:

```ts
export function readSingleLivery(
  zipBytes: Uint8Array,
  identity: { carModel: string; driverName: string },
  limits: PackLimits = DEFAULT_LIMITS,
): Livery
```

It runs every check the CLI path runs — the traversal guard, the extension
allowlist, the flat-folder rule with its one-common-root unwrap, the per-file
and per-skin caps, and the `.dds`-must-exist test that is the only check
establishing the thing *is* a livery. No new validation, no relaxed validation.
This is the point of routing through `pack.ts` rather than writing a second
reader for the bot: the module's header says everything in it is untrusted
because a Discord bot was coming, and the bot arriving should not be the moment
a second code path appears.

`assertSafeName` still applies to `driverName`, and now it applies to a name
that came from ACSM rather than from a zip. `SAFE_COMPONENT` is more restrictive
than what ACSM will store in `Entrant.Name` — a name with a `/` in it, or
leading with a dot, passes ACSM and fails here. That driver cannot upload, ever,
and the refusal must say so in those terms and be addressed to the operator, not
to the driver, since only the operator can fix it.

Then wrap: `{ liveries: [livery], totalBytes: livery.totalBytes }` is a
`LiveryPack`, and `planLiveries` takes it unchanged.

### Validate on receipt, at the bot

Run `readSingleLivery` and `planLiveries` **in the bot**, before anything is
queued. Both are pure and neither writes, so neither breaches §1.

This matters for the reply. A refusal is worth having at the moment the driver
is looking at Discord, in their own words:

> Refusing Misha: "Alpha for carbon.png" — a skin folder holds .dds, .png, .jpg,
> .json, .ini, .txt files, delete the rest and zip it again.

A queue that accepts everything and refuses it forty minutes later in a channel
nobody is reading is a worse product than the operator it replaced.
`LiveryPackError` and `LiveryPlanError` messages were written for a driver to
read — that was the intent recorded in `pack.ts` and this is where it pays off.

---

## 5. The queue, and applying

### What gets stored

One row per submission plus the validated bytes:

| | |
|---|---|
| `id` | |
| `discord_user_id`, `discord_message_id` | who and where, for the audit trail |
| `championship_id` | resolved at submission, §8 |
| `driver_name`, `car_model`, `skin_folder` | resolved at submission |
| `bytes` | the zip **as received**, not the unpacked files |
| `state` | `queued` / `applied` / `refused` / `superseded` |
| `submitted_at`, `applied_at` | |

Store the zip as received. Re-running `readSingleLivery` at apply time means the
thing applied went through the checks twice with the same input, rather than
trusting an unpacking the bot did earlier and stored in pieces.

SQLite, via `src/sqlite.ts` — which already handles the mode-0600 database and,
crucially, the `-wal` and `-shm` sidecars that SQLite creates at the umask
default. These are driver names and, now, Discord ids.

**Supersede rather than accumulate.** A driver uploading twice before a drain
should end up with one queued row: the second replaces the first. The skin
folder is the driver's name either way, so a second upload was always going to
land on the same folder on the server — queuing both means uploading the dead
one first.

### Draining

`champctl-liveries drain <championship-id>` — a subcommand on the existing CLI,
which already has the credentials, the `--push` gate and the `--json` output.

It reads every `queued` row for the championship, builds **one** `LiveryPack`
from all of them, and hands it to `planLiveries` and `applyLiveries` exactly as
the `--zip` path does today.

One pack, not one per submission, and this is the part worth being careful
about. `saveChampionshipSkins` does GET the form → mutate → POST the whole form.
Draining three submissions as three applies is three overlapping
read-modify-write cycles against a full-form replace, which is a lost update
waiting for the week three people upload at once. `RosterChangedError` does not
catch it — that guard compares the *names* on the form, and a concurrent skin
write does not change the names.

Batching also means one championship save per drain instead of one per driver,
which is the difference between a write the operator can reason about and a
burst against `src/acsm/rate-limit.ts`.

Serialise the drain. One at a time, per championship, whatever the trigger.

### Two triggers, one dial

- **`autoApply: false`** (default) — the bot posts into the admin channel: "3
  liveries queued for September 2026" with a link. A human runs the drain, or
  clicks in `champctl-serve`. This is plan §7 verbatim.
- **`autoApply: true`** — a timer runs the drain. Self-serve.

The dial is what makes this worth building as a queue rather than as a direct
call. A league can start at `false`, watch what arrives for a season, and turn
it on when the refusals have stopped being interesting.

---

## 6. Retention, and the pack drivers install

A livery is not finished when it reaches the server. Everyone else on the grid
needs it too, or they see the default skin where a car should be — and the way
a league solves that today is somebody maintaining a "carset" archive by hand,
which is the same job this feature exists to delete, one step further along.

So the queue is not a queue. Bytes stay for the life of the championship, and
`champctl` builds the carset out of them on demand.

### The store is what champctl applied, not what Discord received

If only bot submissions are retained, the pack is a lie the first week an
operator uploads someone's livery by hand — the file is on the server, missing
from the pack, and the driver who installed the pack still cannot see that car.
A pack that is *almost* complete is worse than no pack, because nobody knows
which car is the one they're missing.

So the recording point is `applyLiveries`, not the bot. **Everything champctl
puts on the server gets written to the store, whatever route it came in by** —
`--zip` from an operator, the drain, anything later. The store then answers
"what has champctl put on this championship's cars", which is a more useful
question than "what did Discord send" and is the one the pack needs.

It is still not "every skin on the server": a livery uploaded through ACSM's own
web UI is invisible to champctl and always will be. The pack should say what it
is — a count, and the date — rather than implying completeness it cannot have.

### Layout

Content Manager installs an archive by working out what it holds and dropping it
onto the Assetto Corsa root, so the archive should simply *be* that root:

```
content/cars/rss_formula_hybrid_2021/skins/Misha/livery.dds
content/cars/rss_formula_hybrid_2021/skins/Misha/preview.jpg
content/cars/rss_formula_hybrid_2021/skins/Shoebacca/livery.dds
content/cars/ks_mazda_mx5_cup/skins/postaL/livery.dds
```

Top-level `content/`, one tree, every car in the championship. This is the shape
leagues already distribute carsets in, and it degrades well: a driver whose CM
install misbehaves can extract the `content` folder over their AC directory by
hand and get the identical result.

**The skin folder name is load-bearing and has to match the server.** ACSM
creates the skin folder from the driver's name, `Entrant.Skin` is set to that
same string, and the pack has to use it a third time — if the pack's folder were
`misha_2026` while the entry list says `Misha`, every driver would install the
files successfully and still see the default livery, because AC would be looking
in a folder that doesn't exist. All three come from `Livery.skinFolder` already,
so this is true by construction; it needs a test precisely *because* it is the
kind of thing a later refactor breaks silently.

**Warn on a missing `preview.jpg`.** A skin without one shows blank in CM's
list. `pack.ts` does not require one and should not start — a livery with no
preview still works in a race — but the pack build is the right place to say
"four of these will look empty in Content Manager", in gridmom's register.

### Build it deterministically

Same submissions in, same bytes out: entries sorted, timestamps fixed, no
build-time metadata. Three things follow, and all three matter more than the
tidiness does.

The pack gets a content hash, so "has the carset changed since Tuesday" is a
string compare rather than a judgement. It can be served with a strong `ETag`,
so a driver re-checking the link before a race night downloads nothing when
nothing changed — which is the common case, and the pack is the largest thing
champctl will ever serve. And a rebuilt pack that differs only in a zip
timestamp does not look like a new carset to everyone who already has it.

### Size, and not reusing the upload limits

Thirty drivers is plausibly a few hundred megabytes. `DEFAULT_LIMITS` caps a
*submission* at 128 MB and has no business here — a carset is meant to be large.
Stream it rather than assembling it in memory, and cache the built artifact
keyed on the content hash rather than rebuilding per request.

Retention has a cost that is worth stating rather than discovering: keeping only
the newest applied submission per (championship, car, driver) is what bounds it.
Superseded and refused bytes are not carset material and should not outlive the
decision that rejected them.

### Serving it

`champctl-upload` — the process from §3 that already faces the internet with no
credentials. Same argument, and it is now the obvious home rather than a new
one.

Two things to decide:

- **Public URL, or unguessable one?** The folder names are driver names, which
  are already in the public entry list, so there is little to protect. But a
  stable public URL is also a stable public URL, and a league may not want its
  carset indexed. An unguessable per-championship path costs nothing and can be
  pinned in Discord exactly like a public one.
- **How drivers get it.** A link, and it has to be — this was nearly a hole in
  the plan. The reason `/livery upload-url` exists is that one driver's zip can
  be larger than Discord will carry; the carset is *every* driver's zip at once,
  so it is larger than that by construction. "Pinned in Discord" would have been
  an instruction to attach a file Discord refuses. `champctl-upload` serves it
  from `/c/<slug>` and `/livery carset` hands out the address.

  Not through ACSM's Content Manager wrapper either: its `cars` map is one URL
  per *car model*, meant for the car mod itself, so putting the carset there
  would replace the link to the car people need before the livery matters.

- **The link is shared and permanent**, unlike an upload token. Everyone on the
  grid needs this file, so a token each would leave a driver who joined last
  week with nothing to click when somebody pasted theirs — and it gets pinned,
  which only works if it survives the season. Unguessable rather than public,
  because the folder names are driver names and a league may reasonably not want
  its carset indexed.

- **Cached on disk, keyed on the digest.** A thirty-driver carset is a few
  hundred megabytes; one held in the heap per request is how a league's VPS dies
  on the evening everyone downloads at once. Served with the digest as an
  `ETag`, so the whole grid re-checking before a race night costs one 304 each
  when nothing has changed — which the manifest digest makes possible, since a
  rebuild does not move it.

## 7. No practice restart, and telling the driver why

`applyLiveries` takes `restartPracticeRound` as optional and skips the restart
when it is absent. The bot path never sets it. That is the whole implementation.

The reason is worth writing down where somebody will find it before adding the
flag back. `restartPractice` does `GET /championship/{id}/event/{eventID}/practice`,
which rebuilds `entry_list.ini` and starts a fresh looping session — and anyone
on that server at the time is disconnected. A driver uploading a livery at 8pm
must not be able to bounce everyone else out of practice. It is the same
judgement as `FullRestartPractice` being deliberately off: a livery is cosmetic
and a reconnect is not.

The consequence lands on the driver, so tell them:

> Uploaded and assigned. It'll show up the next time practice for round 3
> starts — practice that's running now keeps the old entry list.

Without that sentence, a driver joins practice, sees the old car, assumes the
upload failed, and uploads again. The message is not politeness; it is what
stops the retry loop.

Two more things belong in the same reply:

- **`unreachableRounds(plan)`.** If a round's own entry list would override the
  class-level skin, the assignment lands in the database and does not reach the
  race. The plan already computes this. Say it, and name the round.
- **`plan.noop`.** "That's already your livery" is a different sentence from
  "done", and the CLI already exits 1 to distinguish them.

The operator gets the restart. Leave `--restart` on the CLI exactly as it is.

---

## 8. Which championship?

The CLI takes an id. A driver will not.

Resolve it in the bot, at submission, and store it on the row — so a drain that
runs an hour later applies to the championship the driver was uploading for
rather than whichever one is current when the timer fires.

`AcsmReader.listChampionships` plus the export gives what is needed, and
`isFinished` in `src/bot/nightly.ts` is already the "every round has been raced"
test — the same function, for the same reason it exists there: a finished
championship cannot be acted on.

Refuse ambiguity rather than picking. Zero unfinished championships and two are
both cases where the bot should say what it found and stop; two active
championships is a real state for a league running a second series, and quietly
choosing one puts a livery on the wrong car. An optional
`discord.livery.championshipId` in the profile pins it for leagues that want no
guessing at all.

---

## 9. Abuse, which is now a thing

The CLI's threat model was "the operator might be handed a bad zip". This one is
"anyone with the role can send arbitrary bytes on a schedule of their choosing".
`pack.ts` handles the *contents*. It does not handle volume.

- **Per-user cooldown.** One accepted upload per driver per N minutes. A
  refused upload should not consume it — a driver iterating on a zip that keeps
  getting rejected is doing exactly what the refusals are for.
- **A disk budget for the queue**, checked before writing, refused with a
  sentence rather than an exception. `maxTotalBytes` caps one pack; nothing caps
  a hundred packs.
- **Log every submission and every refusal** with the Discord user id. Not for
  policing — for the operator's "who uploaded the thing that broke Suzuka"
  question, which currently has an answer only because a human received the file.
- **Nothing from Discord reaches a path.** The attachment filename is the one
  piece of driver-controlled text in the flow, and it is used for **nothing** —
  not the skin folder, not the queue key, not the log line unquoted. The skin
  folder comes from §2.

Fetch the attachment from its CDN URL server-side and immediately; those URLs
now carry expiring signed parameters and a queued download will 403.

---

## 10. What has to be measured before building

The repo's rule (plan §3.4) is that a request gets captured before code is
written against it. Outstanding here:

1. **`POST /car/{model}/skin` against a car with no `skins/` directory yet.**
   `apply.ts` reads ACSM's handler as `MkdirAll` on the derived path, but the
   CLI has only ever been run against cars that already had skins.
2. **Two skin uploads for the same folder.** A re-upload is expected to replace
   files in place. Confirm ACSM overwrites rather than erroring, and confirm
   what happens to a file present in the old skin and absent from the new one —
   a stale `livery.dds` left behind under a new `preview.jpg` is a car that
   renders the old livery for reasons nothing in champctl would explain.
3. **Does BATL's premium instance return `SignUpForm.Responses` to an
   unauthenticated export?** One `curl` with no cookie jar against
   `/championship/{id}/export`, and look for `Responses`. OSS gates it on
   `GroupAdmin`; §5.3 of the plan and the **PUBLIC DATA** annotation on
   `src/acsm/types.ts` both say otherwise, and one of the two is wrong.

   Whichever way it lands, something gets corrected. If the gate holds, that
   annotation and §5.3's privacy note are describing a leak that isn't there,
   and the drainer becomes the only process that can read a sign-up answer. If
   it does not, premium has widened the OSS behaviour and the leak is real and
   worse than §5.3 says — because a Discord handle would then be published
   alongside the Steam GUID, which is the pair that lets someone find a driver
   off the server.

   Do this before anything in §2 is built; it decides whether the hint sync
   exists at all.

   `ExtraFields` itself needs no recon: it is `[]string` in the OSS source, the
   question labels and nothing more. `src/acsm/types.ts` should be narrowed from
   `unknown[]` to `string[]` either way.
4. **Does Content Manager overwrite an existing skin folder when the carset is
   re-installed?** The pack is downloaded repeatedly through a season and most
   of what it contains is already on the driver's disk, so an install that
   silently declines to replace changed files means a driver who has installed
   once keeps the *old* version of every livery that has been updated since —
   and sees a stale car with no indication anything went wrong.

   There is at least one report of CM's auto-install not replacing an existing
   `data.acd` in a league's skin archive, with a manual extract over the AC root
   working fine. Whatever is going on there, it is close enough to this to be
   worth ten minutes: install a pack, change one `livery.dds`, rebuild, install
   again, look at the file.

   If it does not overwrite, the workaround belongs in the driver-facing note
   rather than in the pack — "if a livery looks wrong, delete the skin folder
   and re-install" — and the pack should ship a plain-text manifest listing each
   skin and its hash so the answer to "did mine update" is checkable.
5. **A slash command with an attachment option, end to end**, on a scratch
   guild — the payload shape, `interaction.member.roles` in a guild, and the
   deferral needed for a 20 MB download to finish inside Discord's 3-second
   initial-response window.

---

## 11. Build order

Each step is a commit that leaves the tree working.

1. Merge `main` (§0).
2. `readSingleLivery` in `pack.ts`, with tests. No bot involved; the CLI can
   grow a `--skin <zip> --for <driver>` mode as its first caller and that is
   independently useful.
3. The store: schema, `src/liveries/store.ts`, recording from `applyLiveries`
   whatever the route, and `champctl-liveries drain` behind `--push`. Still no
   bot. Testable with rows inserted by hand.
4. The carset pack — build from the store, serve nothing yet. A CLI subcommand
   that writes the zip to a path is enough to install by hand and prove the
   layout, and it is the only part of §6 that can be tested without a browser.
5. `driver_discord` and the claim/unclaim commands, with the admin-channel
   announcement.
6. `/livery upload` — clamp, download, validate, queue, reply.
7. `champctl-upload` and the one-time link, for the drivers Discord's own
   ceiling shuts out. Its own process, no credentials of any kind.
8. `autoApply` and the timer.
9. Extend `test/bot.test.ts`'s import guard to the new modules under
   `src/bot/`, and add the mirror of it: nothing under `src/liveries/` or the
   drain path imports `src/bot/`. The invariant is a wall, and a wall tested
   from one side is a fence.

---

## 12. Open questions

- **Does a claim need to survive a championship?** Entrant names are per
  championship. A driver who races as "Misha" in September and "Misha [BATL]"
  in October has to re-claim, and §8.2's canonical driver table is the real
  answer — this plan is storing a name where it should eventually store a
  driver id.
- **Should a refused upload be visible to the operator?** Ephemeral replies
  mean the operator never learns that four drivers spent Tuesday fighting the
  extension allowlist, which is the signal that the documentation is wrong.
  A daily count in the admin channel, perhaps, rather than each refusal.
- **What happens to a queued livery for a driver who is dropped from the entry
  list before the drain?** `planLiveries` will refuse the whole pack over the
  missing name — which is the right call for a hand-assembled pack and the
  wrong one here, where it means one departed driver blocks everyone else's
  liveries. The drain probably needs to plan per-submission, drop the ones that
  no longer match with a reason, and batch the rest. That is a real divergence
  from the CLI's all-or-nothing rule and needs deciding before §5 is built.
- **`GuidsList` and multiple Discord accounts** — deferred, but the table shape
  in §2 should not make it hard.
