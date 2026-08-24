import { defineConfig } from "vitest/config"

/**
 * Live suite: talks to the Docker harness. Separate config so `npm test` never
 * needs a container, and so these get a longer timeout and run serially — they
 * import and delete championships in a shared manager.
 */
export default defineConfig({
  test: {
    include: ["test/live/**/*.live.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
})
