# OSS 1.7.9 against premium 2.4.x

Measured against a real 1.7.9 and a real 2.4.5/2.4.15, with the same live suite
run against each. 35 live tests pass on both.

## The design rule

**Detect structurally where you can; use the version only where you can't.**

A version check is a claim about every build that will ever exist. champctl
already carried "1.7.9 does X" comments that turned out to be wrong about
2.4.5, and this repo has now been bitten twice by reasoning about a build
instead of asking it. Most differences below are read off the response, not off
a version number, and `src/acsm/dialect.ts` holds only the ones that genuinely
need the version.

**Version numbers do not separate the families.** There is a premium 1.7.9 as
well as the public one. `IsPremium` in the healthcheck is the honest signal;
the major-version fallback is for a build that reports neither.

## Differences, and how champctl handles each

| | 1.7.9 | 2.4.x | How it's decided |
|---|---|---|---|
| Import mechanism | `<textarea name="import">`, urlencoded | file part, multipart | read off the page |
| Forced-password form | `/accounts/new-password` | `/account/new-password` | read off the redirect |
| First-run wizard | none, `/intro/*` is 404 | blocks every page | **version** (`hasIntroWizard`) |
| `IsPremium` in healthcheck | reported | absent; `LicenseID` instead | both consulted |
| Public access default | off | off | asked, not assumed |
| Public access UI | button "Make Open", no prose | button "Allow Public Access", prose | not parsed at all |
| `/api/championships/list.json` | 404 | 404 | measured 404 → scrape |
| Premium read endpoints | absent | present | **version** |

Two entries are worth expanding.

**Public access.** Provisioning used to read the accounts page and match 2.4.x's
sentence. On 1.7.9 there is no such sentence, so it concluded "already enabled"
while every credential-free read still returned the login page — and the CLI
tests failed with "was not JSON (got HTML)". It now makes an unauthenticated
request to `/championships` and looks at the status, which is the property that
actually matters and needs no knowledge of either build.

**The import path already worked.** `detectImportMechanism` reads the page, so
champctl drove 1.7.9's textarea import correctly the first time it was pointed
at one. The only thing that needed changing was a *test* asserting multipart.

## Not a champctl difference: 1.7.9 needs a content tree

1.7.9's event edit form enumerates tracks to build its dropdown and returns 500
without one:

```
couldn't build championship race
error="open .../assetto/content/tracks: no such file or directory"
```

Eleven live tests failed on this and every one of them looked like a champctl
bug. `assetto/system` is enough for 1.7.9 to skip steamcmd, but not enough to
render the form; the harness creates `assetto/content/tracks` and
`assetto/content/cars` as well. 2.4.x builds a barebones install itself and
needs neither.

The directories can be empty. Nothing in the recon or the live suite needs a
real track — championship import validates no track name, and the form only
needs somewhere to enumerate.
