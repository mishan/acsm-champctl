/**
 * What this ACSM is, and which of its differences champctl has to care about.
 *
 * champctl talks to two families of Server Manager: the public 1.7.x builds
 * most leagues run, and the 2.4.x premium builds BATL runs. They differ in ways
 * that are invisible until a write goes wrong, so this module names them in one
 * place instead of leaving version checks scattered through the call sites.
 *
 * **Detect structurally where you can; use the version only where you can't.**
 * That is the whole design rule here, and it is not fastidiousness. A version
 * check is a claim about every build that will ever exist, and it fails silently
 * on the next one — champctl already had "1.7.9 does X" comments that turned out
 * to be wrong about 2.4.5. Where the answer is in front of us, we read it:
 *
 * - **Import mechanism.** Read off the page. 1.7.9 renders a `<textarea
 *   name="import">`, 2.4.x a file input, and `detectImportMechanism` looks
 *   rather than asks (write.ts).
 * - **The forced-password form.** Read off the redirect. 1.7.9 sends
 *   `/accounts/new-password`, 2.4.x `/account/new-password`, and
 *   `PasswordChangeRequiredError` carries whichever arrived.
 * - **The championship list.** Read off the response. Neither build has
 *   `/api/championships/list.json`, and the reader falls back on a measured 404
 *   rather than on a version (client.ts).
 *
 * What is left needs the version, because absence is not a shape you can see
 * without paying for a request that usually 404s. Those are the fields below.
 */

import type { AcsmHealthcheck } from "./types.js"

/** Which family of Server Manager this is. */
export type AcsmFamily = "oss" | "premium"

export interface AcsmDialect {
  /** As reported, e.g. `v1.7.9`. Empty when the build didn't say. */
  version: string
  /** Leading integers of the version, for comparisons. `[1, 7, 9]`. */
  parts: readonly number[]
  family: AcsmFamily

  /**
   * 2.4.x intercepts every authenticated page with a first-run wizard at
   * `/intro/checks` until it is completed. 1.7.9 has no such thing and answers
   * 404 for the whole `/intro` tree.
   *
   * Version-keyed because the alternative is a request that 404s on half the
   * builds champctl supports, on every provisioning run, to learn something the
   * version already says.
   */
  hasIntroWizard: boolean

  /**
   * Whether the premium-only read endpoints are worth trying at all.
   *
   * `standings.json` and the penalties log are premium features
   * (docs/acsm-write-path.md §6). Note this does *not* include
   * `/api/championships/list.json`, which is absent from both families —
   * measured on 1.7.9, 2.4.5, 2.4.15 and on ac.batlracing.com.
   */
  hasPremiumReadEndpoints: boolean
}

/**
 * The dialect for a healthcheck response.
 *
 * `/healthcheck.json` is unauthenticated on every build, which is what makes
 * this cheap enough to do before anything else.
 *
 * `IsPremium` is the honest signal and 1.7.9 reports it. 2.4.x dropped the
 * field and reports `LicenseID` instead — a premium build is the only one that
 * has a licence to report — so both are consulted before falling back to the
 * version number.
 */
export function dialectFrom(health: AcsmHealthcheck | undefined): AcsmDialect {
  const version = versionFrom(health)
  const parts = versionParts(version)
  const family = familyOf(health, parts)

  // The wizard is a 2.x behaviour, so it is keyed on the version rather than on
  // the family. Those are not the same question: this module documents that a
  // premium 1.7.9 exists, and keying on the family sent it to an intro wizard
  // its build has never had. With no version to read, fall back to the family —
  // see `familyOf` for why premium is the safe direction to be wrong in.
  const major = parts[0]
  const hasIntroWizard = major === undefined ? family === "premium" : major >= 2

  return {
    version,
    parts,
    family,
    hasIntroWizard,
    hasPremiumReadEndpoints: family === "premium",
  }
}

/**
 * The version string, under whichever key the build used.
 *
 * Every build measured — 1.7.9, 2.4.5, 2.4.15 — answers with `Version`, and
 * that is the one to trust. The other two are read because `recon/forms.ts`
 * already probes for them, and because the cost of being wrong is asymmetric:
 * an unread version leaves `parts` empty, which sends `hasIntroWizard` and the
 * family fallback to their defaults on a build that was willing to say.
 */
function versionFrom(health: AcsmHealthcheck | undefined): string {
  for (const v of [health?.Version, health?.version, health?.ServerManagerVersion]) {
    if (typeof v === "string" && v !== "") return v
  }
  return ""
}

/**
 * Which family, from whatever the build was willing to say.
 *
 * **Version numbers do not separate the families.** There is a premium 1.7.9 as
 * well as the public one, so `major >= 2` is a fallback for when the build told
 * us nothing, not a definition — and it would call a premium 1.7.9 "oss". The
 * healthcheck is consulted first for exactly that reason: `IsPremium` is the
 * build answering the question directly, and a premium 1.7.x reports it.
 *
 * Nothing here supports premium v1 today and nothing has been measured against
 * one. If that becomes worth doing, this is the seam: `familyOf` would keep
 * working from `IsPremium`, and the fields on `AcsmDialect` would need a third
 * answer rather than a boolean — premium v1 presumably has the premium read
 * endpoints without the 2.x first-run wizard, which is a combination neither
 * flag can currently express.
 *
 * Unknown reads as premium on purpose. The premium path does strictly more —
 * it completes a wizard that a 1.7.x server 404s, and tries endpoints a 1.7.x
 * server doesn't have — and both of those degrade to a skip or a caught 404.
 * Guessing "oss" for a premium server skips the wizard, and *that* leaves every
 * authenticated page redirecting to `/intro/checks` with nothing saying why.
 */
function familyOf(health: AcsmHealthcheck | undefined, parts: readonly number[]): AcsmFamily {
  if (typeof health?.IsPremium === "boolean") return health.IsPremium ? "premium" : "oss"
  // 2.4.x stopped reporting IsPremium and reports the licence it validated.
  if (typeof health?.LicenseID === "string" && health.LicenseID !== "") return "premium"
  const major = parts[0]
  if (major === undefined) return "premium"
  return major >= 2 ? "premium" : "oss"
}

/** `"v1.7.9"` -> `[1, 7, 9]`. Anything unparseable contributes nothing. */
function versionParts(version: string): number[] {
  return version
    .replace(/^v/i, "")
    .split(".")
    .map((p) => Number.parseInt(p, 10))
    .filter((n) => Number.isFinite(n))
}

/** True when `version` is at least `parts`, for a comparison a reader can check. */
export function atLeast(dialect: AcsmDialect, ...target: number[]): boolean {
  for (let i = 0; i < target.length; i++) {
    const mine = dialect.parts[i] ?? 0
    const theirs = target[i] ?? 0
    if (mine !== theirs) return mine > theirs
  }
  return true
}
