/**
 * The directory-listing parser behind `npm run recon:layouts`.
 *
 * The script's whole verdict turns on telling a subdirectory from a file: a
 * layout is a directory under `ui/`, and `meta_data.json` is not. The negative
 * has been checked against a real manager; this checks the positive, which
 * needs a server with track files on it that no harness has.
 */

import { describe, expect, it } from "vitest"

import { entries } from "../scripts/recon/layouts.js"

/** Go's `http.FileServer` listing: directories carry a trailing slash. */
const listing = (names: string[]): string =>
  `<!doctype html>\n<pre>\n${names.map((n) => `<a href="${n}">${n}</a>`).join("\n")}\n</pre>\n`

describe("reading a track's ui/ directory", () => {
  it("calls the subdirectories layouts and the rest files", () => {
    const { dirs, files } = entries(listing(["layout_gp/", "layout_indy/", "meta_data.json"]))
    expect(dirs).toEqual(["layout_gp", "layout_indy"])
    expect(files).toEqual(["meta_data.json"])
  })

  it("finds nothing to offer on a track with no layouts", () => {
    // What a real manager answered for every track on the harness, where the
    // Assetto install is barebones and has no track files at all.
    expect(entries(listing(["meta_data.json"])).dirs).toEqual([])
  })

  it("decodes a name the listing escaped", () => {
    expect(entries(listing(["layout%20long/"])).dirs).toEqual(["layout long"])
  })
})
