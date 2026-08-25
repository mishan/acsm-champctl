import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The live suite needs a running ACSM; it has its own config and its own
    // npm script, so `npm test` stays runnable with no Docker.
    exclude: ["**/node_modules/**", "test/live/**"],
    environment: "node",
  },
})
