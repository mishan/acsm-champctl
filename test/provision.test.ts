import { describe, expect, it } from "vitest"

import { looksLikeLoginPage } from "../scripts/harness/provision.js"
import { fakeLoginPage } from "./support/acsm-html.js"

/**
 * Provisioning decides whether Public Access is on by making an unauthenticated
 * request and looking at what comes back. A status check alone is not enough:
 * ACSM is known to serve the login form with a 200 rather than a redirect —
 * which is why the reader has to warn about "got HTML" when it expected JSON —
 * and reading that as success makes provisioning skip the toggle, so every
 * credential-free read then fails with an error about Public Access that
 * provisioning has just reported as fine.
 *
 * Both builds here answer a logged-out read with a 302, measured on 1.7.9 and
 * 2.4.5. Checking the body as well as the status is the braces to that belt.
 */
describe("recognising ACSM's login page", () => {
  it("knows the login form when it sees one", () => {
    expect(looksLikeLoginPage(fakeLoginPage())).toBe(true)
  })

  it("catches a login page whose form action is absolute", () => {
    expect(
      looksLikeLoginPage(`<form method="post" action="https://acsm.example/login"></form>`),
    ).toBe(true)
  })

  it("catches one that only has the password field", () => {
    expect(looksLikeLoginPage(`<input type="password" name="Password">`)).toBe(true)
  })

  it("does not mistake the championships listing for it", () => {
    // The page provisioning is actually asking for. A link *to* /login in the
    // navbar is on every authenticated page and must not read as the login
    // form.
    const listing = `<html><body>
      <nav><a href="/login">Log in</a></nav>
      <a href="/championship/11111111-2222-3333-4444-555555555555">August 2026</a>
    </body></html>`
    expect(looksLikeLoginPage(listing)).toBe(false)
  })

  it("does not mistake an empty page for it", () => {
    expect(looksLikeLoginPage("")).toBe(false)
    expect(looksLikeLoginPage("<html><body><p>None yet.</p></body></html>")).toBe(false)
  })
})
