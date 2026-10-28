import { describe, expect, it } from "vitest"

import { applyTheme, rememberedTheme, rememberTheme } from "./theme"

describe("applying a league's colors", () => {
  it("sets the stylesheet's variable each key names", () => {
    const root = document.createElement("div")
    applyTheme({ accent: "#f7a8c8", surface2: "#222", onAccent: "#000" }, root)
    expect(root.style.getPropertyValue("--accent")).toBe("#f7a8c8")
    expect(root.style.getPropertyValue("--surface-2")).toBe("#222")
    expect(root.style.getPropertyValue("--on-accent")).toBe("#000")
  })

  it("puts a color taken out of the profile back to its default", () => {
    const root = document.createElement("div")
    applyTheme({ accent: "#f7a8c8", bg: "#111" }, root)
    applyTheme({ bg: "#111" }, root)
    expect(root.style.getPropertyValue("--accent")).toBe("")
    expect(root.style.getPropertyValue("--bg")).toBe("#111")
  })

  it("remembers the league's colors for the next load", () => {
    rememberTheme({ accent: "#f7a8c8" })
    expect(rememberedTheme()).toEqual({ accent: "#f7a8c8" })
  })
})
