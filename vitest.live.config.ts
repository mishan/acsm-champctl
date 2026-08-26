import { defineConfig } from "vitest/config"

/**
 * Live suite: talks to the Docker harness. Separate config so `npm test` never
 * needs a container, and so these get a longer timeout and run serially — they
 * import and delete championships in a shared manager.
 *
 * Serial is not enough on its own, and that is worth saying because the
 * obvious reading of the failure was that these were racing. They weren't:
 * ACSM limits `/login` to about five requests per twenty seconds, and a serial
 * run still makes far more than that in a minute. `test/live/setup.ts` paces
 * them.
 */
export default defineConfig({
  test: {
    include: ["test/live/**/*.live.test.ts"],
    environment: "node",
    setupFiles: ["./test/live/setup.ts"],
    // Long enough to hold a test that waits out ACSM's login window — twenty
    // seconds — before it does anything.
    testTimeout: 90_000,
    hookTimeout: 90_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
})
