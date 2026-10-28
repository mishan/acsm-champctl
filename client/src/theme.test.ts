import { describe, expect, it } from "vitest"

import { applyTheme } from "./theme"

describe("applying a league's colors", () => {
  it("sets the stylesheet's variable each key names", () => {
    const root = document.createElement("div")
    applyTheme({ accent: "#f7a8c8", surface2: "#222", onAccent: "#000" }, root)
    expect(root.style.getPropertyValue("--accent")).toBe("#f7a8c8")
    expect(root.style.getPropertyValue("--surface-2")).toBe("#222")
    expect(root.style.getPropertyValue("--on-accent")).toBe("#000")
  })
})
