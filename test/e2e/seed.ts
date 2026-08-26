/**
 * A championship for the browser suite to clone, made before it starts.
 *
 * The write flow needs something to base a new championship on, and the two
 * earlier versions of this test took whatever was first in the manager's list.
 * That works exactly once, on a machine that happens to have the right data: a
 * freshly provisioned harness has nothing to clone, and a shared one has a
 * different championship every run — sometimes one that has already been
 * raced, whose rounds the finalize half then refuses to touch.
 *
 * So the suite brings its own, the same way `web.live.test.ts` does, through
 * the same `importChampionship` and the same fixture. What it seeds is
 * therefore known: one unraced round, a name nothing else will collide with,
 * and a teardown that removes it.
 *
 * Seeded over the API rather than through the UI on purpose. This is arranging
 * the world, not the thing under test — driving it through the browser would
 * make every run depend on the create flow working in order to test the create
 * flow.
 */

import { AcsmSession } from "../../src/acsm/session.js"
import type { Championship } from "../../src/acsm/types.js"
import { importChampionship } from "../../src/acsm/write.js"
import { deleteChampionship, loadFixture, SEED } from "../live/harness.js"

/** Where the spec reads the name to pick out of the "Clone from" list. */
export const SOURCE_NAME_VAR = "CHAMPCTL_E2E_SOURCE_NAME"

export default async function globalSetup(): Promise<() => Promise<void>> {
  const baseUrl = process.env["CHAMPCTL_LIVE_URL"]
  const password = process.env["CHAMPCTL_LIVE_PASSWORD"]
  // `playwright.config.ts` has already refused to load without these; the
  // check here is for the type, not for the case.
  if (!baseUrl || !password) throw new Error("no manager configured")

  const session = new AcsmSession({ baseUrl, rateLimit: false })
  await session.login({
    username: process.env["CHAMPCTL_LIVE_USERNAME"] ?? "admin",
    password,
  })

  // Unique per run, so a manager that already has one of these — a previous
  // run that died before teardown — does not leave two the spec cannot tell
  // apart.
  const name = `champctl e2e source ${Date.now()}`
  const fixture = await loadFixture(SEED)
  const source: Championship = { ...fixture, Name: name }

  const { championshipId } = await importChampionship(session, source)
  process.env[SOURCE_NAME_VAR] = name

  // Through the live suite's helper rather than a `getText` here, because a
  // delete that worked reports a 404 and telling the two apart is a detail
  // worth having in one place — this file's own version warned on every
  // successful run.
  return async () => {
    await deleteChampionship(session, championshipId)
  }
}
