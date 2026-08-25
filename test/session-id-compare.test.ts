/**
 * Its own file because it mocks `node:crypto`, and that mock applies to the
 * whole module graph of the file it lives in.
 *
 * What is being pinned: `sameSessionId` must not short-circuit on a length
 * mismatch. That is a *structural* property — the behaviour is identical
 * either way, so an ordinary assertion can't see it, and a wall-clock timing
 * assertion would be flaky and would prove very little on a JIT. Asserting
 * that the comparison is actually reached is the honest middle: it fails if
 * anyone reintroduces the early return.
 */

import { describe, expect, it, vi } from "vitest"

const { timingSafeEqualCalls } = vi.hoisted(() => ({ timingSafeEqualCalls: vi.fn() }))

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>()
  return {
    ...actual,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      timingSafeEqualCalls(a, b)
      return actual.timingSafeEqual(a, b)
    },
  }
})

const { newSessionId, sameSessionId } = await import("../src/web/sessions.js")

describe("sameSessionId does the same work whatever the input length", () => {
  it("still reaches the comparison when the lengths differ", () => {
    // The early-return version answered false without ever comparing, which is
    // observably not constant time.
    timingSafeEqualCalls.mockClear()
    expect(sameSessionId(newSessionId(), "x")).toBe(false)
    expect(timingSafeEqualCalls).toHaveBeenCalledTimes(1)
  })

  it("compares buffers of the same fixed size regardless of input", () => {
    // Hashing first is what makes that true: a 1-character input and a
    // 10,000-character one both become a 32-byte digest.
    for (const other of ["x", "b".repeat(10_000), newSessionId()]) {
      timingSafeEqualCalls.mockClear()
      sameSessionId(newSessionId(), other)

      const [a, b] = timingSafeEqualCalls.mock.calls[0] as [Buffer, Buffer]
      expect(a).toHaveLength(32)
      expect(b).toHaveLength(32)
    }
  })

  it("is still correct, not just constant", () => {
    const id = newSessionId()
    expect(sameSessionId(id, id)).toBe(true)
    expect(sameSessionId(id, newSessionId())).toBe(false)
  })
})
