/**
 * The `bin/` entry points, checked against what an install actually produces.
 *
 * These scripts are the only part of the project that runs compiled output
 * rather than TypeScript through tsx, so they're the only part no other test
 * or CI step exercises: `npm test` and `npm run build` both pass with a `bin/`
 * that imports a module nobody emits.
 */

import { readFileSync } from "node:fs"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  bin: Record<string, string>
  files: string[]
  scripts: Record<string, string>
}

const bins = Object.entries(pkg.bin)

describe("bin entry points", () => {
  it("declares at least one", () => {
    // Otherwise every test below vacuously passes.
    expect(bins.length).toBeGreaterThan(0)
  })

  it.each(bins)("%s exists where package.json says", (_name, rel) => {
    expect(existsSync(join(root, rel))).toBe(true)
  })

  it.each(bins)("%s imports a module the build emits", (_name, rel) => {
    const source = readFileSync(join(root, rel), "utf8")
    const specifier = /from\s+"([^"]+)"/.exec(source)?.[1]
    expect(specifier, `${rel} imports nothing`).toBeDefined()

    // bin/x.js does `from "../dist/cli/x.js"`, which tsc emits from
    // src/cli/x.ts. Renaming or moving the CLI leaves the bin script pointing
    // at a path that only appears at runtime, in the one configuration
    // developers never run.
    const imported = resolve(dirname(join(root, rel)), specifier!)
    const fromRoot = imported.slice(root.length + 1)
    expect(fromRoot.startsWith("dist/"), `${rel} imports ${specifier}, outside dist/`).toBe(true)

    const source_ts = join(root, fromRoot.replace(/^dist\//, "src/").replace(/\.js$/, ".ts"))
    expect(existsSync(source_ts), `no source file compiles to ${fromRoot}`).toBe(true)
  })

  it("ships the compiled output it runs", () => {
    // dist/ is in .gitignore. npm falls back to gitignore rules when `files`
    // is absent, so without this the published tarball has bin/ and no dist/.
    expect(pkg.files).toContain("dist")
    expect(pkg.files).toContain("bin")
  })

  it("builds on install rather than assuming someone did", () => {
    // `npm install <git url>` and `npm pack` both run prepare; neither runs
    // build on its own.
    expect(pkg.scripts.prepare).toContain("build")
  })
})
