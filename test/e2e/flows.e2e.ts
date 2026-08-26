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

// No skip gate: `playwright.config.ts` refuses to load without a manager to
// drive, so reaching here means there is one.

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

/**
 * The two write flows, in one pass, against a championship this test makes.
 *
 * Chained rather than independent because the alternative is editing whatever
 * happens to be first in the manager's list — which on a shared harness is a
 * different championship every run, sometimes one that has already been raced.
 * Both earlier attempts failed on exactly that, and a browser test whose
 * subject depends on the order of somebody else's data is a flake with extra
 * steps.
 */
test("creates a championship and finalizes a round of it", async ({ page }) => {
  await signIn(page)
  await page.getByRole("button", { name: /New championship/ }).click()

  const sources = page.getByLabel(/Clone from/)
  await expect(sources).toBeVisible()
  const options = await sources.locator("option").count()
  expect(options, "the manager has nothing to clone from").toBeGreaterThan(1)
  await sources.selectOption({ index: 1 })

  const name = `champctl e2e ${Date.now()}`
  await page.getByLabel(/^Name$/).fill(name)
  await page.getByRole("button", { name: /Add a round/ }).click()
  await page.getByLabel(/Round 1 track/).fill("spa")

  // The preview is a real POST to /api/championships/plan from bundled client
  // code. A path the server does not serve shows up right here.
  const create = page.getByRole("button", { name: /Create in ACSM|Blocked/ })
  await expect(create).toBeEnabled()
  await create.click()
  await expect(page.getByText(/Championship created/)).toBeVisible()

  // Into the championship champctl says it made.
  await page.getByRole("button", { name: /Open it/ }).click()
  await expect(page.getByRole("heading", { name })).toBeVisible()

  // Its one round, which has never been raced — so the lap count is safe to
  // change and a push is a real write rather than a no-op reporting success.
  await page.locator("button.row").first().click()
  const length = page.locator("#length")
  await expect(length).toBeVisible()

  const before = await length.inputValue()
  const wanted = before === "18" ? "19" : "18"
  await length.fill(wanted)

  const push = page.getByRole("button", { name: /Push to ACSM|Blocked|Nothing to change/ })
  await expect(push).toBeEnabled()
  await push.click()
  await expect(page.getByText(/Pushed to ACSM/)).toBeVisible()

  // And it stuck: a reload re-reads the event from ACSM through the API rather
  // than trusting anything still on screen.
  await page.reload()
  await expect(page.locator("#length")).toHaveValue(wanted)
})
