/**
 * What the browser is told when something goes wrong.
 *
 * Two things are being pinned here. The status and code, because the UI reacts
 * to them and a silent reclassification would change behaviour without
 * changing any code the UI can see. And the message, because this is the
 * boundary where an internal failure could carry a path, a query or part of a
 * form out to a browser — champctl's own refusals are written to be read and
 * go out verbatim, and everything else gets a generic sentence.
 */

import { describe, expect, it } from "vitest"

import { AcsmError } from "../src/acsm/client.js"
import { AcsmAuthError, PasswordChangeRequiredError } from "../src/acsm/session.js"
import { EntryListChangedError, PartialWriteError } from "../src/finalize/apply.js"
import { FinalizeError, type FinalizePlan } from "../src/finalize/plan.js"
import { ScheduleError } from "../src/finalize/schedule.js"
import { ApiError, describeError } from "../src/web/errors.js"

describe("champctl's own refusals", () => {
  it("carries an ApiError's status, code and message through", () => {
    const d = describeError(
      new ApiError(400, "bad-round", "That round isn't in this championship."),
    )
    expect(d).toEqual({
      status: 400,
      body: { error: { code: "bad-round", message: "That round isn't in this championship." } },
      unexpected: false,
    })
  })

  it("gives a changed entry list its own code, not the generic refusal", () => {
    // Before the FinalizeError branch it extends. The UI has to reload and
    // redo rather than offer a retry that would refuse again, and it can only
    // tell the difference from the code.
    const d = describeError(new EntryListChangedError("champ-1", "event-1"))
    expect(d.status).toBe(409)
    expect(d.body.error.code).toBe("entry-list-changed")
    expect(d.body.error.message).toMatch(/Reload the event/)
    expect(d.unexpected).toBe(false)
  })

  it("does not call a half-finished write a refusal", () => {
    // Only `round` is read to build the message; the rest of the plan is not
    // this test's subject.
    const plan = { round: 3 } as FinalizePlan
    const d = describeError(new PartialWriteError(plan, new Error("ACSM returned 500")))
    expect(d.status).toBe(500)
    expect(d.body.error.code).toBe("partial-write")
    expect(d.body.error.message).toMatch(/round 3 is still at its old time/)
    // 500, but not a bug: there is nothing to log that the message doesn't say.
    expect(d.unexpected).toBe(false)
  })

  it("treats a bad date as malformed rather than refused on its merits", () => {
    const d = describeError(new ScheduleError("That wall clock doesn't exist in that zone."))
    expect(d.status).toBe(400)
    expect(d.body.error.code).toBe("schedule")
  })

  it("returns 422 when gridmom blocked it", () => {
    const d = describeError(new FinalizeError("gridmom found 2 errors."))
    expect(d.status).toBe(422)
    expect(d.body.error.code).toBe("finalize")
  })
})

describe("failures that came from ACSM", () => {
  it("returns 401 when the credentials were rejected", () => {
    const d = describeError(new AcsmAuthError("ACSM rejected those credentials."))
    expect(d.status).toBe(401)
    expect(d.body.error.code).toBe("acsm-auth")
    expect(d.unexpected).toBe(false)
  })

  it("does not repeat back what the login attempt revealed", () => {
    // The real message from `AcsmSession.login`, which is written for whoever
    // is running the CLI. It names the username that was tried, the manager's
    // URL, and — via `describeCredentialShape` — what was wrong with the shape
    // of the password. All of it useful in a terminal; none of it something to
    // tell a browser that has not proved it is entitled to know whether the
    // username even exists.
    const d = describeError(
      new AcsmAuthError(
        "Login as league-admin failed: 401 Unauthorized. Also worth knowing: the password is " +
          "wrapped in quotes, which are being sent as part of it. https://acsm.batlracing.com",
        401,
      ),
    )
    expect(d.status).toBe(401)
    expect(d.body.error.message).not.toMatch(/league-admin/)
    expect(d.body.error.message).not.toMatch(/wrapped in quotes/)
    expect(d.body.error.message).not.toMatch(/batlracing/)
    // Still says enough to act on.
    expect(d.body.error.message).toMatch(/username and password/i)
  })

  it("says nothing about the account when a password change is required", () => {
    const d = describeError(
      new PasswordChangeRequiredError(
        "ACSM wants league-admin's password changed at https://acsm.batlracing.com.",
      ),
    )
    expect(d.body.error.message).not.toMatch(/league-admin|batlracing/)
    // And the remedy, which is the whole reason this has its own code: no
    // amount of retyping the password clears it.
    expect(d.body.error.message).toMatch(/sign in to Server Manager directly/i)
  })

  it("separates a required password change from a wrong password", () => {
    // It extends AcsmAuthError, so the order of the branches is the whole
    // test: "these credentials are wrong" sends someone back to retype them,
    // and no amount of retyping clears a password change ACSM is demanding.
    const d = describeError(new PasswordChangeRequiredError("ACSM wants this password changed."))
    expect(d.status).toBe(401)
    expect(d.body.error.code).toBe("acsm-password-change")
  })

  it("calls ACSM being unreachable a gateway failure, not champctl's", () => {
    const d = describeError(new AcsmError("ACSM returned 503."))
    expect(d.status).toBe(502)
    expect(d.body.error.code).toBe("acsm")
    expect(d.unexpected).toBe(false)
  })

  it("keeps the manager's status, which is the actionable part", () => {
    const d = describeError(new AcsmError("503 Service Unavailable from /championships", 503))
    expect(d.body.error.message).toMatch(/answered with 503/)
  })

  it("does not pass on the transport detail or the path it was fetching", () => {
    // The real shape from `HttpAcsmReader`: champctl's own sentence wrapped
    // around whatever undici said. Useful in a terminal; it names an internal
    // address, and the login endpoint that can raise it needs no session.
    const d = describeError(
      new AcsmError(
        "Request to /championships failed: connect ECONNREFUSED 10.0.0.5:8772",
        undefined,
        "http://acsm.internal:8772/championships",
      ),
    )
    expect(d.status).toBe(502)
    expect(d.body.error.message).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|acsm\.internal/)
    expect(d.body.error.message).toMatch(/couldn't reach Server Manager/)
  })
})

describe("anything else", () => {
  it("says nothing about what actually happened, and asks to be logged", () => {
    const d = describeError(new TypeError("Cannot read properties of undefined (reading 'jar')"))
    expect(d.status).toBe(500)
    expect(d.body.error.code).toBe("internal")
    expect(d.body.error.message).not.toContain("jar")
    expect(d.unexpected).toBe(true)
  })

  it("does the same for a thrown non-error", () => {
    // `throw "boom"` and `throw { path: "/srv/champctl/profiles/batl.json" }`
    // both reach here, and neither has a message worth forwarding.
    const d = describeError({ path: "/srv/champctl/profiles/batl.json" })
    expect(d.status).toBe(500)
    expect(d.body.error.message).not.toContain("/srv")
    expect(d.unexpected).toBe(true)
  })
})
