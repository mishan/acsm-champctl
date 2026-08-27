/**
 * The `bin/` entry points, checked against what an install actually produces.
 *
 * These scripts are the only part of the project that runs compiled output
 * rather than TypeScript through tsx, so they're the only part no other test
 * or CI step exercises: `npm test` and `npm run build` both pass with a `bin/`
 * that imports a module nobody emits.
 */

import { spawnSync } from "node:child_process"
import { readFileSync, statSync } from "node:fs"
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

  /**
   * Executable, because people run them from a checkout.
   *
   * `npm install` sets the bit on the symlinks it puts in `node_modules/.bin`,
   * so a linked `gridmom` works whatever this says — which is why four of the
   * five sat at 0644 in git without anyone noticing. `./bin/gridmom.js` is how
   * you run one from a clone, and that is "permission denied" until the bit is
   * set. Every one of them has a `#!/usr/bin/env node` line saying it expects
   * to be run this way.
   *
   * Read off the filesystem rather than out of git: what matters is the file a
   * checkout produces. On a filesystem with no execute bit at all this would
   * be checking nothing, which is a fair description of running these there.
   */
  it.each(bins)("%s is executable", (_name, rel) => {
    expect(statSync(join(root, rel)).mode & 0o111, `${rel} is not executable`).not.toBe(0)
  })

  it.each(bins)("%s starts with a shebang, since it is run directly", (_name, rel) => {
    expect(readFileSync(join(root, rel), "utf8").startsWith("#!")).toBe(true)
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

/**
 * The licence and the release zip are licensed software, and the licence is
 * per-purchase. Both live in `docker/premium/`, which a harness user is told to
 * copy files into — so the ignore rule covering them is load-bearing, and a
 * plausible edit to `.gitignore` could quietly stop covering them.
 *
 * Asks git rather than re-implementing gitignore matching, since git's answer
 * is the one that decides what gets committed.
 */
describe("secrets stay out of git", () => {
  const ignored = (relativePath: string): boolean => {
    const res = spawnSync("git", ["check-ignore", "-q", "--no-index", relativePath], {
      cwd: root,
      encoding: "utf8",
    })
    // 0 = ignored, 1 = not ignored, anything else = git could not answer.
    if (res.status !== 0 && res.status !== 1) {
      throw new Error(`git check-ignore failed for ${relativePath}: ${res.stderr || res.error}`)
    }
    return res.status === 0
  }

  it.each([
    "docker/premium/ACSM.License",
    "docker/premium/acsm_v2.4.15_linux-amd64.zip",
    "docker/.env",
  ])("ignores %s", (path) => {
    expect(ignored(path), `${path} is not gitignored — it would be committed`).toBe(true)
  })

  it("still tracks the placeholder that keeps docker/premium/ in the tree", () => {
    expect(ignored("docker/premium/.gitkeep")).toBe(false)
  })
})
