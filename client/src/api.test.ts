import { afterEach, describe, expect, it, vi } from "vitest"

import { api } from "./api"

const content = { cars: [], tracks: [{ id: "spa", name: "Spa" }], layouts: null }

afterEach(() => vi.unstubAllGlobals())

describe("what's installed", () => {
  it("is read once for the page, but read again after a failure", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("{}", { status: 502 }))
      .mockResolvedValue(new Response(JSON.stringify(content), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)

    await expect(api.content()).rejects.toThrow()
    expect(await api.content()).toEqual(content)
    expect(await api.content()).toEqual(content)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
