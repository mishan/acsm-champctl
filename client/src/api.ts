/**
 * The API, typed from the server's own definitions.
 *
 * Every response type here comes from `src/web/wire.ts` rather than being
 * restated. A hand-written mirror of a response shape is a second definition
 * that starts out right and stops being right the first time a field is
 * renamed — and the failure lands in the browser, at runtime, on the screen
 * someone is using to change a race that starts in an hour.
 *
 * `wire.ts` exists precisely so this import is safe: it may only depend on
 * leaves, so following it doesn't drag the write session and `node:crypto` into
 * the client's typecheck. These are `import type` and nothing else, so they
 * erase completely and no server code reaches the bundle. A *value* import from
 * `src/` would fail the Vite build, which is the right way for that mistake to
 * go.
 */

import type { Finding, Severity } from "../../src/gridmom/finding.js"
import type {
  ApplyResponse,
  ChampionshipListItem,
  ChampionshipListResponse,
  ChampionshipResponse,
  ChampionshipView,
  CheckReport,
  ConfigResponse,
  FormatPreset,
  LoginResponse,
  NewChampionshipResponse,
  NewChampionshipRequest,
  NewChampionshipPlanResponse,
  NewChampionshipPlan,
  PlannedRoundView,
  PlanRequest,
  PlanResponse,
  PlanView,
  RaceFormat,
  RoundView,
  SessionResponse,
  TrackRequest,
} from "../../src/web/wire.js"

export type {
  ApplyResponse,
  ChampionshipListItem,
  // Every response type this module returns is re-exported, so a caller that
  // wants to name what it got back never has to reach past here into the
  // server's wire types.
  ChampionshipListResponse,
  ChampionshipResponse,
  ChampionshipView,
  CheckReport,
  Finding,
  FormatPreset,
  NewChampionshipResponse,
  NewChampionshipRequest,
  NewChampionshipPlanResponse,
  NewChampionshipPlan,
  PlannedRoundView,
  PlanRequest,
  // `plan()` returns it, so a caller that wants to name what it got back
  // should not have to reach past this module into the server's wire types.
  PlanResponse,
  PlanView,
  RaceFormat,
  RoundView,
  Severity,
  TrackRequest,
}

/** Local aliases for the two the components read most. */
export type Config = ConfigResponse
export type SessionState = SessionResponse

/**
 * A refusal the server described, with its code intact.
 *
 * The `message` is champctl's own sentence and is rendered verbatim — those are
 * written to be read by someone in a hurry, and paraphrasing them in the UI
 * would be a third copy of wording that already exists in two places. `code` is
 * what the UI branches on, so that reacting to "your session expired" never
 * depends on matching prose.
 */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "ApiFailure"
  }
}

/** True when the only thing to do is log in again. */
export function isAuthFailure(e: unknown): boolean {
  return (
    e instanceof ApiFailure &&
    (e.code === "not-authenticated" || e.code === "session-expired" || e.code === "acsm-auth")
  )
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      // Only when there is a body. Declaring JSON on a bodyless POST makes
      // Fastify reject it as an empty JSON body before the route runs, which
      // is what happened to logout: the UI switched to the login screen while
      // the server session and cookie stayed valid, so a reload signed the
      // person straight back in.
      headers: {
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...init.headers,
      },
      // The session cookie is httpOnly, so the browser has to be told to send
      // it; `same-origin` is the default for fetch, stated here because the
      // whole auth model rests on it.
      credentials: "same-origin",
    })
  } catch (e) {
    // A network failure is not a refusal, and it must not read like one — the
    // person needs to know nothing reached the server rather than that the
    // server said no.
    if (e instanceof DOMException && e.name === "AbortError") throw e
    throw new ApiFailure(
      0,
      "offline",
      "Couldn't reach champctl. Nothing was sent. Check the connection and try again.",
    )
  }

  if (res.status === 204) return undefined as T

  const body: unknown = await res.json().catch(() => undefined)
  if (!res.ok) {
    const described = (body as { error?: { code?: string; message?: string } } | undefined)?.error
    throw new ApiFailure(
      res.status,
      described?.code ?? "unknown",
      described?.message ?? `champctl answered ${res.status} and said nothing about why.`,
    )
  }
  return body as T
}

const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) })

export const api = {
  config: (): Promise<ConfigResponse> => request<ConfigResponse>("/config"),

  session: (): Promise<SessionResponse> => request<SessionResponse>("/session"),

  login: (username: string, password: string): Promise<LoginResponse> =>
    request("/login", json({ username, password })),

  logout: (): Promise<void> => request("/logout", { method: "POST" }),

  championships: (): Promise<ChampionshipListResponse> => request("/championships"),

  championship: (id: string): Promise<ChampionshipResponse> =>
    request(`/championships/${encodeURIComponent(id)}`),

  /**
   * Preview. Performs no writes — it reads the event's edit form and works out
   * what a save would send.
   *
   * Takes a signal because the screen re-previews as the fields change, and an
   * answer to a question the person has already moved on from must not be
   * allowed to overwrite the answer to the one they are looking at.
   */
  plan: (
    id: string,
    round: number,
    body: PlanRequest,
    signal?: AbortSignal,
  ): Promise<PlanResponse> =>
    request(`/championships/${encodeURIComponent(id)}/rounds/${round}/plan`, {
      ...json(body),
      ...(signal ? { signal } : {}),
    }),

  /**
   * Push. Takes the plan id and nothing else, so what lands is what was
   * previewed — see the server's `plans.ts`.
   */
  apply: (planId: string, acknowledgeWarnings: boolean): Promise<ApplyResponse> =>
    request(`/plans/${encodeURIComponent(planId)}/apply`, json({ acknowledgeWarnings })),

  /**
   * Preview a new championship cloned from a past one. Writes nothing.
   *
   * Takes a signal for the same reason `plan` does: the review screen
   * re-previews as the track list is edited.
   */
  planNewChampionship: (
    body: NewChampionshipRequest,
    signal?: AbortSignal,
  ): Promise<NewChampionshipPlanResponse> =>
    request("/championships/plan", { ...json(body), ...(signal ? { signal } : {}) }),

  /** Create it. Takes the plan id, so what lands is what was reviewed. */
  createChampionship: (
    planId: string,
    acknowledgeWarnings: boolean,
  ): Promise<NewChampionshipResponse> =>
    request(`/championships/${encodeURIComponent(planId)}/create`, json({ acknowledgeWarnings })),
}
