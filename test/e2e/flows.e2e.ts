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

import { expect, type Page, test } from "@playwright/test"

import { AcsmSession } from "../../src/acsm/session.js"
import { deleteChampionship } from "../live/harness.js"
// Paces the teardown login below. Playwright runs this file in a worker of its
// own, so the config's import does not reach it.
import "../live/login-pace.mjs"
import { SOURCE_NAME_VAR } from "./seed.js"

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
async function signIn(page: Page): Promise<void> {
  await page.goto("/")
  await page.getByLabel(/username/i).fill(USERNAME)
  await page.getByLabel(/password/i).fill(PASSWORD)
  await page.getByRole("button", { name: /sign in/i }).click()
  await expect(page.getByRole("button", { name: /sign out/i })).toBeVisible()
}

/**
 * The championship the write flow created, so a run doesn't leave one behind.
 *
 * `seed.ts` removes what it seeded; this is the other half, and without it a
 * manager collects a "champctl e2e <timestamp>" every time anyone runs the
 * suite. Its own session because a Playwright worker cannot reach into global
 * setup's — one more login, at the end, against a manager that allows five in
 * twenty seconds.
 */
let created: string | undefined

test.afterAll(async () => {
  const baseUrl = process.env["CHAMPCTL_LIVE_URL"]
  if (!created || !baseUrl) return
  const session = new AcsmSession({ baseUrl, rateLimit: false })
  await session.login({ username: USERNAME, password: PASSWORD })
  await deleteChampionship(session, created)
})

/**
 * Choose something in a typeahead: focus it, type part of the name, take the
 * first suggestion.
 *
 * `fill` is what this used to do, and it stopped meaning anything when the
 * field became a picker — typing filters the list, it does not enter a value.
 * The suggestions are whatever `/api/content` scraped off the manager's own
 * `/cars` and `/tracks` pages, so this only passes if the display name a
 * person would search for really does reach the browser.
 */
async function pick(page: Page, label: RegExp, query: string): Promise<void> {
  // By role, not `getByLabel`: the listbox carries the same accessible name as
  // the input it belongs to — deliberately, so a screen reader announces what
  // the options are for — and a label lookup resolves to both.
  const input = page.getByRole("combobox", { name: label })
  await input.click()
  await input.fill(query)
  await page.getByRole("listbox", { name: label }).getByRole("option").first().click()
}

/**
 * Wait for the server's review, then acknowledge whatever gridmom said.
 *
 * Both write screens render their gridmom section only once a plan has come
 * back, so that heading is the signal that the preview resolved — waiting on
 * the button instead races the debounce and reads "disabled" from a screen
 * that has not asked the server anything yet.
 *
 * Ticking the box is not a way around the rules. An ERROR blocks the write
 * outright and offers no checkbox; warnings are the case the screen expects a
 * person to read and accept, and against this harness there are always some —
 * there is no pit table for the seed's tracks and no content installed, so
 * gridmom reports on the harness rather than on the change under test. Leaving
 * them unacknowledged would mean this suite could only ever exercise the path
 * where gridmom is silent, which is not the path a league takes.
 */
async function reviewAndAcknowledge(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: /^gridmom$/ })).toBeVisible()
  const ack = page.getByRole("checkbox", { name: /read the warnings/i })
  if ((await ack.count()) > 0) await ack.check()
}

test("signs in against the real manager and lists its championships", async ({ page }) => {
  await signIn(page)
  await expect(page.getByText(/Loading championships/)).toHaveCount(0)
  await expect(page.getByRole("button", { name: /New championship/ })).toBeVisible()

  // The championship `seed.ts` just imported, by name.
  //
  // This used to assert only that the screen resolved, on the grounds that a
  // fresh harness has nothing to list. It doesn't any more — the suite seeds
  // one — and "resolved" was passing against an empty list while
  // `listChampionships` dropped every entry on the floor, because 2.4.15's
  // list endpoint spells its keys in lowercase and champctl read `ID`. A
  // screen that renders nothing is exactly what that bug looks like, so
  // "something rendered" has to mean a championship.
  const sourceName = process.env[SOURCE_NAME_VAR]
  expect(sourceName, "global setup did not seed a championship").toBeTruthy()
  await expect(page.getByText(sourceName as string)).toBeVisible()
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
 * The two write flows, in one pass, over a championship the suite seeded.
 *
 * Chained rather than independent because the finalize half needs a round that
 * has never been raced, and the create half is what produces one.
 *
 * The *source* is picked by name, not by position. Both earlier versions took
 * whichever championship was first in the list, which is a different one every
 * run on a shared manager and none at all on a fresh one — see `seed.ts`.
 */
test("creates a championship and finalizes a round of it", async ({ page }) => {
  await signIn(page)
  await page.getByRole("button", { name: /New championship/ }).click()

  const sourceName = process.env[SOURCE_NAME_VAR]
  expect(sourceName, "global setup did not seed a championship to clone").toBeTruthy()

  const sources = page.getByLabel(/Clone from/)
  await expect(sources).toBeVisible()
  // By label. Position would be whatever the manager's ordering happens to be.
  await sources.selectOption({ label: sourceName as string })

  const name = `champctl e2e ${Date.now()}`
  await page.getByLabel(/^Name$/).fill(name)
  await page.getByRole("button", { name: /Add a round/ }).click()
  await pick(page, /Round 1 track/, "Spa")

  // The cars came from the source championship, through `/api/content` and a
  // second read of the source — two requests the DOM tests mock away. An empty
  // Cars field blocks the preview, so reaching the review at all proves both
  // arrived and that the picker matched what ACSM says is installed.
  await expect(page.getByRole("button", { name: /^Remove / }).first()).toBeVisible()

  // The preview is a real POST to /api/championships/plan from bundled client
  // code. A path the server does not serve shows up right here.
  await reviewAndAcknowledge(page)
  const create = page.getByRole("button", { name: /Create in ACSM|Blocked/ })
  await expect(create).toBeEnabled()
  await create.click()
  await expect(page.getByText(/Championship created/)).toBeVisible()

  // Into the championship champctl says it made.
  await page.getByRole("button", { name: /Open it/ }).click()
  await expect(page.getByRole("heading", { name })).toBeVisible()
  // Off the URL rather than out of the create response, so cleanup removes
  // whatever the browser actually ended up on.
  created = new URL(page.url()).pathname.split("/")[2]

  // Its one round, which has never been raced — so the lap count is safe to
  // change and a push is a real write rather than a no-op reporting success.
  await page.locator("button.row").first().click()
  const length = page.locator("#length")
  await expect(length).toBeVisible()

  const before = await length.inputValue()
  const wanted = before === "18" ? "19" : "18"
  await length.fill(wanted)

  await reviewAndAcknowledge(page)
  const push = page.getByRole("button", { name: /Push to ACSM|Blocked|Nothing to change/ })
  await expect(push).toBeEnabled()
  await push.click()
  await expect(page.getByText(/Pushed to ACSM/)).toBeVisible()

  // And it stuck: a reload re-reads the event from ACSM through the API rather
  // than trusting anything still on screen.
  await page.reload()
  await expect(page.locator("#length")).toHaveValue(wanted)
})
