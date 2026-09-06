# Recon artefacts

`npm run recon:forms`, `recon:roundtrip` and `recon:champ-form` write here.
**Commit what they produce** — the diff on the next ACSM upgrade is the whole
point, and a snapshot nobody can compare against is worth nothing.

Two things to know before you do:

- **Regenerate after changing the recon code.** The first captures were taken
  before the round-trip diff learned about Go's `omitempty` and timestamp
  formatting, so they reported a `Created` difference of `...58.140Z` versus
  `...58.14Z` as substantive. An artefact that contradicts the code is worse
  than no artefact.
- **These files are public.** Diffs touching entry lists or sign-up responses
  have their values redacted before writing, because exports carry names, Steam
  GUIDs, emails and free-text answers (plan §5.3). If you add a new artefact,
  keep that property.

`forms-<version>.json` and `champ-form-<version>.json` are named for the Server
Manager version they were captured against, so a 1.7.x capture is never mistaken
for one from the 2.4.x BATL runs. See `docs/acsm-write-path.md` §0 for which
answers are version-specific.

`champ-form-*.json` is the one artefact here that can be captured against a
league's *production* manager, because `recon:champ-form` given a championship
id only reads. It holds counts, control types and Bootstrap wrapper classes —
never a value from an entrant row. `uuidCensus` exists so the identity question
can be answered by three numbers instead of a list of UUIDs; keep it that way.
See `docs/acsm-champ-form.md`.
