/**
 * Turning champctl's exceptions into HTTP.
 *
 * The CLIs already do this once, as exit codes, and the mapping here is
 * deliberately the same judgement in a different alphabet — a refusal is not a
 * crash, a half-finished write is not a refusal, and ACSM saying no is not
 * champctl failing. `src/cli/finalize.ts` has the prose version of why each
 * class is caught separately.
 *
 * **The message goes to the browser verbatim, and only for errors champctl
 * raised itself.** Those messages are written to be read by a person under time
 * pressure: they name the thing, say where it is, and say what happens next.
 * Rewriting them here would be a second copy that drifts. Anything else — a
 * `TypeError`, a bug — gets a generic sentence and a server-side log, because
 * an unexpected message can carry a path, a query, or part of a form.
 */

import { AcsmError } from "../acsm/client.js"
import { AcsmAuthError, AcsmWriteError, PasswordChangeRequiredError } from "../acsm/session.js"
import { EntryListChangedError, PartialWriteError } from "../finalize/apply.js"
import { FinalizeError } from "../finalize/plan.js"
import { ScheduleError } from "../finalize/schedule.js"

export interface ErrorBody {
  error: {
    /** Stable machine code, so the UI can react without matching on prose. */
    code: string
    /** One plain sentence, safe to render as-is. */
    message: string
  }
}

export interface DescribedError {
  status: number
  body: ErrorBody
  /** True when the original is worth putting in the server log. */
  unexpected: boolean
}

/**
 * A refusal champctl raises deliberately, with a message written for the
 * person reading it. Used for the API's own input and state errors so they
 * travel the same path as the engine's.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

export function describeError(e: unknown): DescribedError {
  if (e instanceof ApiError) {
    return { status: e.status, body: { error: { code: e.code, message: e.message } }, ...OK }
  }

  // Before the FinalizeError branch it extends: the entry list changing under
  // an open preview is not a generic refusal but the one failure with its own
  // remedy — reload and redo — and the UI has to do that rather than offer a
  // retry that would refuse again. 409 because that is exactly what it is.
  if (e instanceof EntryListChangedError) {
    return {
      status: 409,
      body: { error: { code: "entry-list-changed", message: e.message } },
      ...OK,
    }
  }

  // Also before FinalizeError. Half of this went through, so it is neither a
  // refusal nor something to retry; the message says which half landed.
  if (e instanceof PartialWriteError) {
    return { status: 500, body: { error: { code: "partial-write", message: e.message } }, ...OK }
  }

  // Something the person typed: a date the zone doesn't have, an ambiguous
  // wall clock in the hour the clocks go back. 400, not 422 — the request is
  // malformed rather than refused on its merits.
  if (e instanceof ScheduleError) {
    return { status: 400, body: { error: { code: "schedule", message: e.message } }, ...OK }
  }

  // gridmom blocked it, warnings weren't acknowledged, the round doesn't
  // exist, ACSM served a page with no event form on it. The request was
  // understood and champctl declined to act on it.
  if (e instanceof FinalizeError) {
    return { status: 422, body: { error: { code: "finalize", message: e.message } }, ...OK }
  }

  // ACSM will not let this account do anything until its password is changed,
  // which is a first-login state champctl cannot clear on the user's behalf —
  // the change has to happen in ACSM, by them. Before the `AcsmAuthError`
  // branch because it extends it, and separate from it because the two need
  // different words: "these credentials are wrong" sends someone back to
  // retype them, and no amount of retyping fixes this one.
  if (e instanceof PasswordChangeRequiredError) {
    return {
      status: 401,
      body: {
        error: {
          code: "acsm-password-change",
          message:
            "Server Manager is asking for this account's password to be changed before it can " +
            "do anything. champctl can't do that on your behalf — sign in to Server Manager " +
            "directly, set the new password, then come back.",
        },
      },
      ...OK,
    }
  }

  /**
   * A login that failed, or a session ACSM expired underneath us. Either way
   * the browser's champctl session is now useless, and the UI should say so and
   * offer the login screen.
   *
   * The one place in this module where champctl's own message is *not*
   * forwarded. `AcsmSession.login` writes for whoever is running the CLI, and
   * says a great deal: the username it tried, the base URL, where a stray
   * redirect went, and — from `describeCredentialShape` — whether the password
   * had trailing whitespace, was wrapped in quotes, or was empty. Every one of
   * those is useful in a terminal and none of them belongs in a reply to an
   * unauthenticated browser, which is exactly the audience that has not proved
   * it is entitled to know whether the username exists.
   */
  if (e instanceof AcsmAuthError) {
    return {
      status: 401,
      body: {
        error: {
          code: "acsm-auth",
          message:
            "Server Manager didn't accept that. Check the username and password you use to " +
            "sign in to it directly — champctl has no accounts of its own and passes yours " +
            "straight through.",
        },
      },
      ...OK,
    }
  }

  /**
   * A write ACSM refused, or one champctl refused to send.
   *
   * Before the `AcsmError` branch it extends, because the message is worth
   * keeping. These are champctl's own sentences about the *request* — this
   * championship already has results, the import form has no field to post to,
   * ACSM answered the import without saying what it created — and each names
   * something the person can go and look at. The generic gateway sentence
   * below is right for a transport failure and useless for these.
   *
   * Still 502: whatever went wrong, it went wrong at the manager rather than
   * in champctl, and nothing champctl could retry differently would fix it.
   */
  if (e instanceof AcsmWriteError) {
    return { status: 502, body: { error: { code: "acsm-write", message: e.message } }, ...OK }
  }

  /**
   * ACSM refused, timed out, or isn't there. Not champctl's failure, and 502
   * says so — champctl is a gateway here, and the thing behind it is what went
   * wrong. `AcsmWriteError` extends this and is caught by it on purpose.
   *
   * Rebuilt rather than forwarded. These messages are assembled for a terminal
   * and carry the ACSM path that was being fetched and, through `asMessage`,
   * whatever the transport said — `getaddrinfo ENOTFOUND acsm.internal`,
   * `connect ECONNREFUSED 10.0.0.5:8772`. A league admin does not need their
   * manager's internal address to act on this, and the login endpoint that can
   * raise it is reachable without a session.
   *
   * The status is kept, because that is the part that tells someone what to do:
   * a 503 from the manager is "it is up and unhappy, wait", and no status at
   * all is "champctl could not reach it", which is a different afternoon.
   */
  if (e instanceof AcsmError) {
    const message =
      e.status === undefined
        ? "champctl couldn't reach Server Manager. Check that it's running and that champctl is " +
          "pointed at the right address."
        : `Server Manager answered with ${e.status}. That's the manager refusing or failing, ` +
          `not champctl — nothing was written.`
    return { status: 502, body: { error: { code: "acsm", message } }, ...OK }
  }

  return {
    status: 500,
    body: {
      error: {
        code: "internal",
        message:
          "champctl hit a problem it doesn't have a description for. Nothing was written unless " +
          "a push was already in flight; check the event in ACSM before retrying, and look at " +
          "the server log for what actually happened.",
      },
    },
    unexpected: true,
  }
}

/** Spread into the branches above; every one of them is an expected refusal. */
const OK = { unexpected: false } as const
