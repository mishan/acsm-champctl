/**
 * Brings a fresh harness container to the state the live suite expects.
 *
 * Replaces the manual browser step the docker README used to open with. Every
 * part of it is measured against 2.4.15, and none of it involves a CSRF token:
 *
 *   1. `POST /login` as admin/servermanager, which 302s to the forced password
 *      change at `/account/new-password` — singular `account`, where 1.7.9 uses
 *      `/accounts/`.
 *   2. `POST /account/new-password` with `Password` and `RepeatPassword`.
 *   3. The first-run wizard, which is the one that matters. 2.4.x redirects
 *      *every* authenticated page to `/intro/checks` until it is finished, so
 *      an unprovisioned container fails the whole live suite with a confusing
 *      "No form posting to /championship/import on the import page". Fetching
 *      `/intro/server-options` and posting its form back unchanged finishes it.
 *      1.7.9 has no such wizard.
 *
 * Idempotent, so it is safe to run before every suite: on a container that is
 * already provisioned, the first login succeeds with the real password and the
 * wizard POST is a no-op.
 *
 *   npm run harness:provision
 */

import { HttpAcsmReader } from "../../src/acsm/client.js"
import { dialectFrom } from "../../src/acsm/dialect.js"
import { assertDisposable } from "../../src/acsm/disposable.js"
import { CHAMPIONSHIPS_PATH } from "../../src/acsm/paths.js"
import { AcsmAuthError, AcsmSession, PasswordChangeRequiredError } from "../../src/acsm/session.js"

const INITIAL_PASSWORD = "servermanager"

async function main(): Promise<void> {
  const baseUrl = (process.env["CHAMPCTL_LIVE_URL"] ?? "").trim()
  const username = (process.env["CHAMPCTL_LIVE_USERNAME"] ?? "admin").trim()
  const password = process.env["CHAMPCTL_LIVE_PASSWORD"]

  if (!baseUrl) {
    throw new Error(
      "CHAMPCTL_LIVE_URL is not set. Start the harness with `npm run harness:up`, " +
        "then `set -a && . docker/.env && set +a`.",
    )
  }
  if (!password) {
    throw new Error(
      "CHAMPCTL_LIVE_PASSWORD is not set. Choose one, put it in docker/.env, and re-run — " +
        "this script is what sets it on the container.",
    )
  }

  // This script changes an admin password. Pointing it at a league's real
  // manager is the worst thing in this repo, so it gets the same guard as recon.
  assertDisposable(baseUrl, "harness provisioning")

  // No rate limiting: a throwaway container, and the default 5-per-20s would
  // make provisioning take longer than the work it precedes.
  const session = new AcsmSession({ baseUrl, rateLimit: false })

  const dialect = dialectFrom(await new HttpAcsmReader({ baseUrl, rateLimit: false }).healthcheck())

  const firstRun = await ensurePassword(session, username, password)

  // Unconditional on a build that has the wizard, because a container can have
  // had its password set without it being finished — exactly the
  // half-provisioned state a manual browser visit tends to leave behind. 1.7.x
  // has no wizard and answers 404 for the whole /intro tree.
  if (dialect.hasIntroWizard) {
    const intro = await session.getForm("/intro/server-options")
    await session.postForm("/intro/server-options", intro.fields)
  }

  const openedNow = await allowPublicAccess(session, baseUrl)

  process.stdout.write(
    `${firstRun ? "Provisioned" : "Already provisioned"} ${baseUrl} as ${username}.\n` +
      `Public access ${openedNow ? "enabled" : "already enabled"}.\n`,
  )
}

/**
 * Logs in, setting the password first if ACSM insists on it.
 *
 * ACSM answers the first login with a redirect to `/account/new-password`, and
 * `login()` throws `PasswordChangeRequiredError` for it — with the session
 * cookie already in the jar, which is what makes posting the form from here
 * work.
 *
 * Caught by type rather than by catching everything. This was a bare `catch`
 * that retried with the shipped default, which lands on the very same redirect
 * and throws again: the password form below was unreachable, so the first-run
 * flow could not work at all. It went unnoticed because the harness script
 * changed the password by other means before ever calling this. Every other
 * login failure — wrong password, 429, an ACSM that is down — still surfaces.
 *
 * Returns whether it had to set the password.
 */
async function ensurePassword(
  session: AcsmSession,
  username: string,
  password: string,
): Promise<boolean> {
  let newPasswordPath: string | undefined

  // The configured password first: on an already-provisioned container that is
  // the whole of it.
  try {
    await session.login({ username, password })
    return false
  } catch (e) {
    if (e instanceof PasswordChangeRequiredError) newPasswordPath = e.newPasswordPath
    // Two ways a fresh container refuses it, and both mean "not provisioned":
    // a plain rejection, because the account is still on the shipped default;
    // or the password-change redirect, if the password happens to match and
    // ACSM is still insisting. Anything else — 429, a 5xx, a connection that
    // never landed — is not a wrong password and must not be answered by
    // trying a different one.
    if (!isWrongPassword(e) && !(e instanceof PasswordChangeRequiredError)) throw e
  }

  // Only when the configured password did not already get us there. If it did,
  // the jar holds the cookie and `newPasswordPath` holds the form, which is
  // everything the POST below needs — and trying the shipped default anyway
  // would be a *second* login, this time with a password ACSM has no reason to
  // accept. It answers that with a plain rejection, which is not a
  // `PasswordChangeRequiredError`, so it was rethrown and provisioning died
  // one step short of finishing a container it had already unlocked.
  if (!newPasswordPath) {
    // The shipped default, which lands on the password-change redirect with
    // the session cookie set. That cookie is what makes the POST below work.
    try {
      await session.login({ username, password: INITIAL_PASSWORD })
    } catch (e) {
      if (!(e instanceof PasswordChangeRequiredError)) throw e
      newPasswordPath = e.newPasswordPath
    }
  }

  if (!newPasswordPath) {
    throw new Error(
      "ACSM never asked for a new password, so there is no form to post one to, and the " +
        "configured password was rejected. Check CHAMPCTL_LIVE_PASSWORD against the container.",
    )
  }

  // Whichever path ACSM redirected to. 1.7.9 says `/accounts/new-password`
  // and 2.4.x `/account/new-password`, and the error carries the one that
  // actually arrived rather than champctl guessing from a version.
  await session.postForm(newPasswordPath, [
    { name: "Password", value: password },
    { name: "RepeatPassword", value: password },
  ])
  await session.login({ username, password })
  return true
}

/**
 * Whether ACSM said the credentials were wrong, as opposed to being unwell.
 *
 * It answers a bad password with 200 and the login form again, which is why
 * `AcsmAuthError` carries a status at all. A 429 is its own rate limiter and a
 * 5xx is the manager failing; retrying either with a different password is
 * guessing at a question that was never asked.
 */
function isWrongPassword(e: unknown): boolean {
  if (!(e instanceof AcsmAuthError)) return false
  return e.status === undefined || e.status === 200 || e.status === 401 || e.status === 403
}

/**
 * Turns on Public Access, which the read path depends on.
 *
 * Without it `/championship/{id}/export` and `/api/championships/list.json`
 * answer with the login page, and every credential-free read fails. That is
 * most of champctl: gridmom, the archive, and the export read inside
 * `champctl-finalize` all go through `HttpAcsmReader`, which holds no
 * credentials by construction. BATL has it on, so a harness without it is not
 * modelling the thing under test — and the live suite missed this entirely
 * because its own reads went through an authenticated session.
 *
 * `/accounts/toggle-open` is a GET and it *toggles*, so calling it blindly on
 * an already-open manager would close it. The page says which way it is set,
 * so read first.
 *
 * Returns whether this call changed anything.
 */
async function allowPublicAccess(session: AcsmSession, baseUrl: string): Promise<boolean> {
  if (await publicAccessEnabled(baseUrl)) return false

  // The toggle works and then redirects to `/accounts/` — with a trailing
  // slash, which ACSM itself does not route, so following the redirect gets a
  // 404. The setting has already changed by then. Swallowing the transport
  // error and reading the state back is the only way to tell a broken redirect
  // from a toggle that didn't happen, and the check below is what makes that
  // safe rather than hopeful.
  try {
    await session.getText("/accounts/toggle-open")
  } catch {
    // Verified immediately below.
  }

  if (!(await publicAccessEnabled(baseUrl))) {
    throw new Error(
      "Toggled /accounts/toggle-open but public access is still off. Without it every " +
        "credential-free read returns the login page, so gridmom and the archive cannot work.",
    )
  }
  return true
}

/**
 * Whether a request with no credentials can read a page that needs them.
 *
 * Asks the question directly instead of reading the accounts page. That page
 * describes the setting differently on every build — 2.4.x has a sentence of
 * prose and a button reading "Allow Public Access", 1.7.9 has no prose at all
 * and a button reading "Make Open" — so matching either is guessing at a label.
 * Matching 2.4.x's sentence is what made provisioning report "already enabled"
 * on 1.7.9 while every credential-free read still returned the login page.
 *
 * An unauthenticated fetch is exact on both, and on whatever the next build
 * calls its button. `/championships` is the page the archive actually needs,
 * which makes this the property under test rather than a proxy for it.
 */
async function publicAccessEnabled(baseUrl: string): Promise<boolean> {
  const res = await fetch(new URL(CHAMPIONSHIPS_PATH, baseUrl), { redirect: "manual" })
  // A logged-out read of a protected page redirects to the login form; with
  // public access on it is served.
  return res.status === 200
}

main().catch((e: unknown) => {
  process.stderr.write(`harness:provision failed: ${e instanceof Error ? e.message : String(e)}\n`)
  process.exitCode = 1
})
