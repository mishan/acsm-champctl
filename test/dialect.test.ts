import { describe, expect, it } from "vitest"

import type { AcsmHealthcheck } from "../src/acsm/types.js"
import { atLeast, dialectFrom } from "../src/acsm/dialect.js"

describe("working out which ACSM this is", () => {
  it("believes IsPremium over the version number", () => {
    // The reason this ordering matters: there is a premium 1.7.9 as well as the
    // public one, so a version number does not separate the families. 1.7.x
    // answers the question directly and is taken at its word.
    expect(dialectFrom({ Version: "v1.7.9", IsPremium: false }).family).toBe("oss")
    expect(dialectFrom({ Version: "v1.7.9", IsPremium: true }).family).toBe("premium")
  })

  it("reads a licence as premium, since 2.4.x stopped reporting IsPremium", () => {
    const d = dialectFrom({ Version: "v2.4.15", LicenseID: "e539dac6-264f-40c7-90c2" })
    expect(d.family).toBe("premium")
    expect(d.hasIntroWizard).toBe(true)
  })

  it("falls back to the major version when the build said neither", () => {
    expect(dialectFrom({ Version: "v1.7.9" }).family).toBe("oss")
    expect(dialectFrom({ Version: "v2.4.5" }).family).toBe("premium")
  })

  it("reads the version under any of the keys recon probes for", () => {
    // Every build measured answers with `Version`. The other two are read
    // because `scripts/recon/forms.ts` probes for them, and a version this
    // function fails to read is not an error anywhere — it is an empty `parts`
    // that quietly sends the version-keyed differences to their defaults.
    expect(dialectFrom({ version: "v2.4.5" }).parts).toEqual([2, 4, 5])
    expect(dialectFrom({ ServerManagerVersion: "v1.7.9" }).parts).toEqual([1, 7, 9])
  })

  it("reads a healthcheck that spells the flag either way", () => {
    // `OK` is what every measured build sends; `ok` is what this repo's own
    // fixtures and StaticAcsmReader have always used. Both are declared, so
    // neither needs a cast to read.
    const upper: AcsmHealthcheck = { OK: true, Version: "v1.7.9" }
    const lower: AcsmHealthcheck = { ok: true, Version: "v1.7.9" }
    expect(dialectFrom(upper).family).toBe("oss")
    expect(dialectFrom(lower).family).toBe("oss")
  })

  it("prefers the spelling the real builds use", () => {
    expect(dialectFrom({ Version: "v2.4.5", version: "v1.7.9" }).parts).toEqual([2, 4, 5])
  })

  it("keeps the intro wizard a question about the version, not the family", () => {
    // A premium 1.7.x exists, and it has never had the wizard — the wizard
    // arrived with 2.x. Keying this on the family sent that build to a page it
    // does not serve.
    expect(dialectFrom({ IsPremium: true, Version: "v1.7.9" }).family).toBe("premium")
    expect(dialectFrom({ IsPremium: true, Version: "v1.7.9" }).hasIntroWizard).toBe(false)
    expect(dialectFrom({ Version: "v2.4.5" }).hasIntroWizard).toBe(true)
  })

  it("assumes the wizard when the build gave no version at all", () => {
    // Same safe direction as `familyOf`: attempting the wizard on a build that
    // has none is a 404 on a provisioning step, where skipping one that does
    // leaves every later request staring at an unfinished setup page.
    expect(dialectFrom({ LicenseID: "abc" }).hasIntroWizard).toBe(true)
    expect(dialectFrom(undefined).hasIntroWizard).toBe(true)
    expect(dialectFrom({ IsPremium: false }).hasIntroWizard).toBe(false)
  })

  /**
   * Unknown reads as premium because the premium path does strictly more, and
   * its extra steps degrade to a skip or a caught 404. Guessing "oss" for a
   * premium server skips the first-run wizard, and that leaves every
   * authenticated page redirecting to /intro/checks with nothing saying why.
   */
  it("treats an unrecognisable build as premium", () => {
    expect(dialectFrom(undefined).family).toBe("premium")
    expect(dialectFrom({}).family).toBe("premium")
    expect(dialectFrom({ Version: "banana" }).family).toBe("premium")
  })

  it("keeps the OSS build away from premium-only endpoints", () => {
    const oss = dialectFrom({ Version: "v1.7.9", IsPremium: false })
    expect(oss.hasIntroWizard).toBe(false)
    expect(oss.hasPremiumReadEndpoints).toBe(false)
  })

  it("compares versions without lexicographic surprises", () => {
    const d = dialectFrom({ Version: "v1.7.9" })
    expect(d.parts).toEqual([1, 7, 9])
    // "1.7.9" < "1.10.0" is false as strings and true as versions.
    expect(atLeast(dialectFrom({ Version: "v1.10.0" }), 1, 7, 9)).toBe(true)
    expect(atLeast(d, 1, 7, 9)).toBe(true)
    expect(atLeast(d, 2, 0)).toBe(false)
  })
})
