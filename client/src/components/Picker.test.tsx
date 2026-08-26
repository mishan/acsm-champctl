/**
 * The typeahead, on its own.
 *
 * What it has to get right is one thing: you search by a name you know and it
 * commits a folder name you don't. Everything below is a way that could stop
 * being true while the field still looked fine — a search that only matched
 * the pretty name, a blur that committed half a word, a list that showed the
 * display name and submitted it.
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { Picker } from "./Picker"

const TRACKS = [
  { id: "ks_brands_hatch", name: "Brands Hatch" },
  { id: "spa", name: "Spa" },
  { id: "ks_silverstone", name: "Silverstone" },
]

afterEach(cleanup)

function show(over: Partial<React.ComponentProps<typeof Picker>> = {}) {
  const onChange = vi.fn<(id: string) => void>()
  render(
    <Picker label="Track" value="" items={TRACKS} onChange={onChange} emptyHint="none" {...over} />,
  )
  return { onChange, input: screen.getByLabelText("Track") as HTMLInputElement }
}

const options = (): HTMLElement[] =>
  within(screen.getByRole("listbox", { name: "Track" })).getAllByRole("option")

describe("picking installed content by name", () => {
  it("commits the folder name, not the name that was searched", async () => {
    // The whole point. `RaceSetup.Track` stores `ks_brands_hatch`, and nobody
    // types that.
    const { onChange, input } = show()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "brands" } })
    fireEvent.mouseDown(options()[0] as HTMLElement)
    expect(onChange).toHaveBeenCalledWith("ks_brands_hatch")
  })

  it("searches the folder name too", async () => {
    // Somebody who already knows the content types `ks_silver`, and matching
    // only the display name would be a step backwards for them.
    const { input } = show()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "ks_silver" } })
    expect(options()).toHaveLength(1)
    expect(options()[0]?.textContent).toContain("Silverstone")
  })

  it("shows the name once something is chosen, not the folder name", () => {
    const { input } = show({ value: "ks_brands_hatch" })
    expect(input.value).toBe("Brands Hatch")
  })

  /**
   * A championship cloned from one that raced a since-removed car holds an id
   * the index has never heard of. Rendering blank would look like nothing is
   * set, and the person would have no idea what they were replacing.
   */
  it("still shows an id the manager no longer has", () => {
    const { input } = show({ value: "rss_formula_hybrid_2021" })
    expect(input.value).toBe("rss_formula_hybrid_2021")
  })

  it("does not commit a half-typed name", () => {
    // The strict half of "pick from the list only": typing filters, it does
    // not enter. A field that committed "brand" would put a track nobody has
    // into a championship, and it would read as a typo nobody made.
    const { onChange, input } = show()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "brand" } })
    expect(onChange).not.toHaveBeenCalled()
  })

  describe("from the keyboard", () => {
    it("moves through the list and takes the highlighted one", () => {
      const { onChange, input } = show()
      fireEvent.focus(input)
      fireEvent.keyDown(input, { key: "ArrowDown" })
      fireEvent.keyDown(input, { key: "Enter" })
      // Sorted the way the server sent them, which is by display name.
      expect(onChange).toHaveBeenCalledWith("spa")
    })

    it("wraps rather than stopping at the end", () => {
      const { onChange, input } = show()
      fireEvent.focus(input)
      // Up from the first lands on the last.
      fireEvent.keyDown(input, { key: "ArrowUp" })
      fireEvent.keyDown(input, { key: "Enter" })
      expect(onChange).toHaveBeenCalledWith("ks_silverstone")
    })

    /**
     * Enter with the list closed belongs to the form. Swallowing it would
     * break submitting from the keyboard for a field that isn't even open.
     */
    it("leaves Enter alone when the list is shut", () => {
      const { onChange, input } = show()
      fireEvent.keyDown(input, { key: "Enter" })
      expect(onChange).not.toHaveBeenCalled()
    })

    it("closes on Escape without choosing anything", () => {
      const { onChange, input } = show()
      fireEvent.focus(input)
      fireEvent.keyDown(input, { key: "Escape" })
      expect(screen.queryByRole("listbox")).toBeNull()
      expect(onChange).not.toHaveBeenCalled()
    })
  })

  it("says nothing matches rather than showing an empty list", () => {
    const { input } = show()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "nürburgring" } })
    expect(screen.getByText(/Nothing installed matches/)).toBeTruthy()
  })

  /**
   * Nothing to pick from is a different thing from no match, and under a
   * strict picker it is a dead end — so it has to say why rather than look
   * like a search that found nothing.
   */
  it("disables itself and explains when there is nothing installed", () => {
    const { input } = show({ items: [], emptyHint: "champctl couldn't read what's installed." })
    expect(input.disabled).toBe(true)
    expect(screen.getByText(/couldn't read what's installed/)).toBeTruthy()
  })
})
