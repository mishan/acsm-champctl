/**
 * champctl in a browser, against a real Server Manager.
 *
 * The one thing only this suite can prove: that the requests leaving the
 * bundled client are the routes the server actually serves. `client/src/api.ts`
 * builds those paths as strings and the DOM tests mock the module that builds
 * them, so a client calling `/months/plan` at a server serving
 * `/championships/plan` is green in every other suite in this repo and broken
 * for every human. That has happened once already.
 *
 * Everything else here is deliberately thin. The rules of each screen are
 * covered next to the component, the endpoints are covered against a stubbed
 * ACSM, and the write path is covered against a real one — repeating any of
 * that through a browser buys slow tests and a second place to update.
 */

import { expect, test } from "@playwright/test"

const LIVE = Boolean(process.env["CHAMPCTL_LIVE_URL"] && process.env["CHAMPCTL_LIVE_PASSWORD"])

test.skip(
  !LIVE,
  "set CHAMPCTL_LIVE_URL and CHAMPCTL_LIVE_PASSWORD, and start the harness, to run these",
)

const USERNAME = process.env["CHAMPCTL_LIVE_USERNAME"] ?? "admin"
const PASSWORD = process.env["CHAMPCTL_LIVE_PASSWORD"] ?? ""

/**
 * Signed in, on the championship list.
 *
 * Through the form rather than by planting a cookie: the login round trip is
 * part of what this suite is here to prove, and a fabricated session would
 * skip the one request every other one depends on.
 */
async function signIn(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/")
  await page.getByLabel(/username/i).fill(USERNAME)
  await page.getByLabel(/password/i).fill(PASSWORD)
  await page.getByRole("button", { name: /sign in/i }).click()
  await expect(page.getByRole("button", { name: /sign out/i })).toBeVisible()
}

test("signs in against the real manager and lists its championships", async ({ page }) => {
  await signIn(page)
  // Something came back from ACSM through champctl and rendered. The list may
  // be empty on a fresh harness, so this asserts the screen resolved rather
  // than a count.
  await expect(page.getByText(/Loading championships/)).toHaveCount(0)
  await expect(page.getByRole("button", { name: /New championship/ })).toBeVisible()
})

test("refuses a wrong password without leaving a session behind", async ({ page }) => {
  await page.goto("/")
  await page.getByLabel(/username/i).fill(USERNAME)
  await page.getByLabel(/password/i).fill("not-the-password")
  await page.getByRole("button", { name: /sign in/i }).click()

  // ACSM answers a wrong password with a 200 and the login form again, so this
  // is the browser-level version of the check the live API suite makes: the
  // screen must stay on the login form rather than admitting anyone.
  await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible()
  await expect(page.getByRole("button", { name: /sign out/i })).toHaveCount(0)
})

/*
 * Still to come: the two write flows.
 *
 * The harness reaches them — a browser signs in, the list renders from a real
 * manager — but both specs stop at the same place and it is not yet clear
 * whether the fault is theirs or champctl's:
 *
 * - Creating a championship: the form fills in, and "Create in ACSM" never
 *   leaves its disabled state, which means the preview POST is not producing a
 *   plan. Either the spec is cloning a source that cannot be cloned, or the
 *   browser's request to /api/championships/plan is not landing the way
 *   `web.live.test.ts` proves the endpoint does.
 * - Finalizing an event: the push reports "Pushed to ACSM", and a reload shows
 *   the old lap count. Either the spec navigates to a different round than the
 *   one it edited, or a write that the API suite lands is not landing here.
 *
 * The second reading of each is the one worth ruling out first, because it is
 * exactly the class of bug this suite exists to catch: something true of the
 * API that is not true of the browser reaching it.
 */
