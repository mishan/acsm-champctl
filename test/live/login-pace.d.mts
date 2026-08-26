/**
 * Types for `login-pace.mjs`, which is JavaScript because the browser suite
 * loads it through `NODE_OPTIONS=--import` before tsx can register a
 * TypeScript loader. See the module's own comment.
 *
 * Importing it for its side effect — `import "./login-pace.mjs"` — installs
 * the paced `fetch`. The named exports are here for the unit test, which
 * checks the window arithmetic on a fake clock.
 */

export declare function paceStatePath(baseUrl: string): string

export declare function paceLogin(options?: {
  statePath?: string
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): Promise<void>
