/**
 * Reading a module's imports, for the guards that keep the credential split
 * honest (docs/discord-livery-upload.md §1, §11 step 9).
 *
 * Shared rather than copied, because `test/bot.test.ts` and `test/upload.test.ts`
 * each had their own regex and each had the same two holes in it.
 */
import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

/**
 * Every module specifier a file pulls in.
 *
 * Three forms, and the last two are the ones that matter. A static
 * `from "…"` is what an honest import looks like; `import("…")` and a bare
 * `import "…"` are what a deliberate one would look like, and a guard that
 * only saw the first was one line away from being bypassable in exactly the
 * way its own comment anticipates — "just this once, the bot could apply that
 * itself" is written as an `await import`, not as a top-of-file import.
 *
 * `require(…)` is in here too. Nothing in this repo is CommonJS, which is the
 * reason to check rather than a reason not to.
 */
export function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf8")
  const patterns = [
    /\bfrom\s+"([^"]+)"/g,
    /(?:^|[\n;])\s*import\s+"([^"]+)"/g,
    /\bimport\s*\(\s*"([^"]+)"/g,
    /\brequire\s*\(\s*"([^"]+)"/g,
  ]
  const out = new Set<string>()
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) out.add(match[1] as string)
  }
  return [...out]
}

/** The `.ts` a relative specifier names, if it is one this repo owns. */
export function resolveSpecifier(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined
  const path = resolve(dirname(fromFile), specifier.replace(/\.js$/, ".ts"))
  return existsSync(path) ? path : undefined
}

/**
 * Walks out from `entries` and reports every path that reaches `forbidden`.
 *
 * Each offence is the trail that got there, because "something under src/bot
 * reaches the write path" is not an actionable sentence and
 * "livery-router.ts → claims.ts → apply.ts" is.
 */
export function reachesAny(entries: readonly string[], forbidden: readonly string[]): string[] {
  const offences: string[] = []
  const seen = new Set<string>()
  const walk = (file: string, trail: string[]): void => {
    if (seen.has(file)) return
    seen.add(file)
    const here = [...trail, file]
    for (const specifier of importsOf(file)) {
      if (forbidden.some((f) => specifier.includes(f))) {
        offences.push([...here, specifier].join(" → "))
        continue
      }
      const next = resolveSpecifier(file, specifier)
      if (next) walk(next, here)
    }
  }
  for (const entry of entries) walk(entry, [])
  return offences
}
