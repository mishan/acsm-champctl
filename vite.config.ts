import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

/**
 * The client build. `npm run build` runs this after `tsc`, and the server
 * serves what it produces from `dist/client`.
 *
 * `vitest.config.ts` is separate and takes precedence for `npm test`, so
 * nothing here affects the test run.
 */
export default defineConfig({
  root: "client",
  plugins: [react()],
  build: {
    outDir: "../dist/client",
    // Safe because the directory is only ever this build's output — `tsc`
    // writes to `dist/` itself, not to `dist/client`.
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    /**
     * `npm run dev` serves the client and forwards the API to a
     * `champctl-serve` on 3000.
     *
     * `changeOrigin` stays off deliberately. With it off the proxied request
     * keeps `Host: localhost:5173`, which matches the browser's `Origin`, so
     * the server's cross-origin check passes for the same reason it would in
     * production. Turning it on rewrites the Host to the target and every
     * write starts failing 403 — a confusing way to discover that the check
     * works.
     */
    proxy: { "/api": { target: "http://127.0.0.1:3000", changeOrigin: false } },
  },
})
