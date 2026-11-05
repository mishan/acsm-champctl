import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { Version } from "./Version"

afterEach(cleanup)

describe("Version", () => {
  it("links a release to its notes", () => {
    render(<Version version="2026.11.0" />)
    expect(screen.getByRole("link", { name: "2026.11.0" }).getAttribute("href")).toBe(
      "https://github.com/mishan/acsm-champctl/releases/tag/2026.11.0",
    )
  })

  it("links nothing for a build outside a release, which has no notes", () => {
    render(<Version version="dev" />)
    expect(screen.getByText(/champctl dev/)).toBeTruthy()
    expect(screen.queryByRole("link")).toBeNull()
  })
})
