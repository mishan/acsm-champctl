import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"

/**
 * Two suites, one command.
 *
 * The server and domain tests run in node, and always did. The client tests
 * need a DOM, and giving the whole run one would be the wrong trade: it is
 * slower, and it puts `window` in scope for server code that must never reach
 * for it — a stray `document` reference in `src/` would start passing its
 * tests instead of failing them.
 *
 * Projects rather than a per-file `@vitest-environment` docblock, so a new
 * component test gets the right environment by being in the right place rather
 * than by remembering a comment.
 *
 * The live suite is in neither: it needs a running ACSM, so it keeps its own
 * config and its own npm script, and `npm test` stays runnable with no Docker.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["test/**/*.test.ts"],
          exclude: ["**/node_modules/**", "test/live/**"],
          environment: "node",
        },
      },
      {
        // The same plugin the client is built with, so what is under test is
        // transformed the way it ships.
        plugins: [react()],
        test: {
          name: "client",
          include: ["client/src/**/*.test.tsx"],
          environment: "jsdom",
          restoreMocks: true,
        },
      },
    ],
  },
})
