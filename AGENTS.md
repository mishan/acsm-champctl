# Working on this repo

For humans and agents alike. Layout, gates and design history are in
[docs/development.md](docs/development.md).

## Branches and commits

- **Work on a branch.** Never commit to `main`; branch off it and open a PR.
- **No tool prefixes on branch names.** No `claude/`, no `copilot/`, no
  `bot/`. Name the branch after the change.
- **No `Co-authored-by` trailers.** No "generated with" footers either.
- **Commit as `Misha Nasledov <misha@nasledov.com>`.**

Commit messages: a terse title saying what the commit delivers, and a body only
where the *why* isn't obvious from the diff. Two or three sentences is plenty.
If a fix is subtle, the explanation belongs in a code comment next to the code,
where it stays true — not in a commit message nobody will read again.

```
Refuse a POST missing an EntryList key outright

Counting keys against each other can't see one that isn't there: nine
arrays of 24 with the tenth absent is consistent, and ACSM indexes most of
them unguarded.
```

## Tests

**Every bug fix gets a test.** No exceptions — a fix without one is a fix that
comes back.

**Check the test fails without the fix.** Revert the change, run the test, watch
it fail, put the change back. A test that passes either way documents nothing
and guards nothing. This is the single most useful habit here, and the one most
often skipped; several tests in this repo were written, passed, and turned out
to prove nothing.

Some specifics that have bitten:

- **Assert on exit codes**, not on log text. A tool that prints "Checked 25
  files" prints it on failure too.
- **Make concurrency tests actually concurrent**, and confirm they fail under
  the sequential version.
- If a property can't be tested — an unreachable branch, a host-dependent
  default — say so in a comment rather than writing a test that implies
  coverage it doesn't have.

## Before you push

```sh
npm run typecheck && npm run lint && npm run format:check && npm test && npm run build
```

CI runs all five. Check the **exit code** of each, not the output.

If you've been rebasing or amending, verify the *committed* tree rather than
your working directory — `git worktree add --detach` somewhere temporary and run
the gates there. A staged-but-uncommitted file passes locally and breaks CI.

## Style

- TypeScript, strict, with `exactOptionalPropertyTypes` and
  `noUncheckedIndexedAccess`. Biome formats and lints; don't fight it.
- **Types stay loose at the ACSM boundary.** The championship schema is a large
  undocumented Go struct that drifts across versions. Model what you read, let
  the rest flow through, and don't tighten it.
- **Comments say why, not what.** The interesting ones record a decision, a
  measurement, or a bug that used to be there.
- **Fail closed on the write path.** Refusing a write costs a diagnosis;
  guessing costs an entry list.
- Messages people read — gridmom findings, CLI errors — are plain sentences that
  name the thing and where it is. No severity jargon in the prose.

## Repo hygiene

- `.cache/`, `data/` and `fixtures/live/` hold league data, including driver
  names and Steam GUIDs. Gitignored, and they stay that way.
- Prefer staging files explicitly over `git add -A`. Untracked scratch files in
  a tracked directory get swept in otherwise.
- Never commit an ACSM release zip, a `server_manager.db`, or anything from
  `docker/premium/`.
