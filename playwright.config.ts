import { defineConfig } from "@playwright/test"

/**
 * The browser suite: champctl as a person actually reaches it.
 *
 * This exists to close one specific gap, and it is worth naming precisely
 * because everything either side of it is already covered. The client tests
 * mock `api`, so they never make a request. The server tests drive Fastify
 * directly, so they never load the client. Between them sits the contract that
 * `client/src/api.ts` calls the paths `src/web/routes.ts` serves — and when the
 * championship rename moved `/months/plan` to `/championships/plan`, every one
 * of those tests stayed green while the UI 404'd in a browser.
 *
 * So the value here is not "click the buttons again". It is that the request
 * leaving the browser and the route receiving it are the same string, proven
 * by a real fetch from real bundled code.
 *
 * Needs a running ACSM, and refuses to load without one — see below. `npm test`
 * is unaffected: this suite has its own command and its own runner.
 *
 *   npm run harness:oss -- start
 *   npm run build:client
 *   CHAMPCTL_LIVE_URL=... CHAMPCTL_LIVE_PASSWORD=... npm run test:e2e
 */

/**
 * The port champctl is served on for the run.
 *
 * Validated rather than coerced. `Number("nope")` is `NaN`, which turns the
 * base URL into `http://127.0.0.1:NaN` — a string that looks almost right in a
 * log and produces a connection failure with nothing pointing at the typo.
 */
const PORT = port(process.env["CHAMPCTL_E2E_PORT"])

function port(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 3100
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(
      `CHAMPCTL_E2E_PORT is ${JSON.stringify(raw)}, which is not a port from 1 to 65535.`,
    )
  }
  return n
}

/**
 * Refuse to run rather than skipping quietly.
 *
 * `npm run test:e2e` is an explicit request to run these. Reporting "2 skipped"
 * for a missing variable looks like a pass in a terminal and in CI, which is
 * the same failure as a test that goes green for the absence of what it
 * checks. The live *vitest* suite skips instead, and correctly: it shares a
 * command with the unit tests, so a laptop with no harness has to stay green.
 * Nothing shares a command with this one.
 */
const BASE_URL = process.env["CHAMPCTL_LIVE_URL"]
if (!BASE_URL || !process.env["CHAMPCTL_LIVE_PASSWORD"]) {
  throw new Error(
    "The browser suite needs a Server Manager to drive. Start one and point champctl at it:\n\n" +
      "  npm run harness:oss -- start\n" +
      "  set -a && . docker/.env && set +a\n" +
      "  CHAMPCTL_LIVE_URL=http://127.0.0.1:8772 npm run test:e2e\n\n" +
      "docker-compose puts the OSS build on ACSM_OSS_PORT (8773 by default) and the premium one " +
      "on 8772, so check which one you are running.",
  )
}

export default defineConfig({
  testDir: "test/e2e",
  // `.e2e.ts`, not `.test.ts`: vitest's node project globs `test/**/*.test.ts`,
  // and a browser spec picked up by vitest fails in a way that reads as a
  // broken test rather than a misfiled one.
  testMatch: "**/*.e2e.ts",
  // Seeds a championship for the write flow to clone, and removes it after.
  // `seed.ts` says why the suite brings its own rather than using whatever the
  // manager happens to hold.
  globalSetup: "./test/e2e/seed.ts",
  // Serially, and one worker. These import championships into a shared manager
  // and delete them again; two workers would be two people editing the same
  // ACSM, which is a race the tool is designed to *detect* rather than a thing
  // to arrange on purpose.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env["CI"],
  retries: 0,
  reporter: process.env["CI"] ? "list" : "line",
  // Generous, because champctl rate-limits its own reads to be polite to a
  // league's production manager (plan §3.1) — five per twenty seconds. Against
  // a local harness that is pure latency, and a screen that makes three reads
  // spends a minute waiting for permission champctl gave itself.
  timeout: 120_000,
  expect: { timeout: 40_000 },

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // On failure only: a passing run should leave nothing behind, and a failing
    // one should say what the page looked like.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  /**
   * The real server, started the way a deployment starts it.
   *
   * `--insecure-cookies` because the session cookie is `Secure` by default and
   * a browser will not keep one over plain `http://`. That is the flag's whole
   * purpose and this is exactly the case it exists for; the alternative is
   * terminating TLS in a test harness to prove something about champctl.
   *
   * `--client dist/client` rather than letting the default resolve: under tsx
   * the default is a checkout path, and depending on which branch of
   * `clientRootFor` runs is a way to test the wrong thing by accident.
   *
   * `--unthrottled-reads` because champctl paces its own reads at five per
   * twenty seconds to be polite to a league's manager, and a browser flow that
   * makes three of them then spends a minute waiting for permission champctl
   * gave itself. The harness is a container this suite started and will throw
   * away, which is the case that flag exists for.
   *
   * `--no-cache` because `seed.ts` imports a championship straight into ACSM,
   * behind champctl's back, moments before the run. Responses are cached on
   * disk for five minutes, so without this the "Clone from" list is whatever
   * the previous run saw — the seeded championship is simply absent, and the
   * spec fails looking for an option that exists on the manager. The cache
   * outlives the process, so restarting champctl does not clear it.
   */
  webServer: {
    command: `node_modules/.bin/tsx src/cli/serve.ts --port ${PORT} --insecure-cookies --unthrottled-reads --no-cache --client dist/client --base-url ${BASE_URL}`,
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: !process.env["CI"],
    timeout: 30_000,
    stdout: "pipe",
    stderr: "pipe",
  },
})
