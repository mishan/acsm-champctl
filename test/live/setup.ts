/**
 * Every login the live suite makes, paced — wherever it is made from.
 *
 * Wrapping `fetch` rather than adding a call at each site, because the sites
 * are not all reachable. `cli.live.test.ts` calls `main()` in process and the
 * login happens several layers down inside a CLI; `web.live.test.ts` posts to
 * champctl's own `/api/login`, which logs in on the server side; `harness.ts`
 * logs in directly. One wrapper covers all three, and it counts the request
 * ACSM actually limits rather than a proxy for it — the old pacer ran before
 * every CLI invocation, including `gridmom` and `champctl-archive`, which are
 * credential-free and never log in at all.
 *
 * Safe to install globally because this file is loaded only by
 * `vitest.live.config.ts`. `npm test` never sees it, and neither does `src/`:
 * champctl still fails a 429 outright and says to wait twenty seconds, which
 * is the right thing for a person at a terminal and the wrong thing for a
 * suite that knows exactly how many logins it is about to make.
 *
 * `AcsmSession` and `HttpAcsmReader` both default to `globalThis.fetch`, bound
 * at construction — and setup files run before the test file's imports, so
 * what they bind is this.
 */

import { paceLogin } from "./login-pace.js"

const real = globalThis.fetch

/**
 * One pre-emptive wait, then at most two goes at waiting out a 429.
 *
 * Pacing alone is not enough, because the pacer can only count the logins it
 * makes. One login from anywhere else — a person signed in to the harness in a
 * browser, a `curl` in another terminal, a previous run killed mid-flight —
 * spends the slot it was holding in reserve, and the suite fails on a limiter
 * it was doing everything right about. That is not hypothetical: it is how
 * this was reproduced, with a single `curl` before the run.
 *
 * ACSM says exactly when the window reopens, so the wait is read rather than
 * guessed. Bounded, so a header that says something absurd cannot hang the
 * suite instead of failing it.
 */
const MAX_ATTEMPTS = 3

globalThis.fetch = (async (
  input: Parameters<typeof globalThis.fetch>[0],
  init?: RequestInit,
): Promise<Response> => {
  if (!isLogin(input, init)) return real(input, init)

  // Re-sending is safe here and would not be in general: `AcsmSession` posts a
  // login as a URL-encoded string, so the body survives being sent twice. A
  // `Request` with a streamed body would not, which is why this narrow case is
  // the only one that retries.
  for (let attempt = 1; ; attempt++) {
    await paceLogin()
    const res = await real(input, init)
    if (res.status !== 429 || attempt >= MAX_ATTEMPTS) return res
    await sleepUntilWindowReopens(res)
  }
}) as typeof globalThis.fetch

/** ACSM's `X-Ratelimit-Reset` is unix seconds, and the window is 20s wide. */
async function sleepUntilWindowReopens(res: Response): Promise<void> {
  const reset = Number(res.headers.get("x-ratelimit-reset"))
  const until = Number.isFinite(reset) && reset > 0 ? reset * 1000 - Date.now() : 20_000
  const wait = Math.min(Math.max(until + 250, 250), 25_000)
  await new Promise((r) => setTimeout(r, wait))
}

function isLogin(input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit): boolean {
  const request = typeof input === "object" && "url" in input ? input : undefined
  const method = init?.method ?? request?.method ?? "GET"
  if (method.toUpperCase() !== "POST") return false

  const raw = request ? request.url : String(input)
  try {
    // Only the login route. Champctl's own `/api/login` is not it: that one
    // reaches ACSM's, and pacing both would spend two slots for one login.
    return new URL(raw).pathname.replace(/\/$/, "") === "/login"
  } catch {
    return false
  }
}
