/**
 * What shape does `standings.json` actually answer with?
 *
 * The one recon script that is safe to point at a league's production manager,
 * and the only one that has to be. `standings.json` is premium-only — absent
 * from the public `router.go` (docs/acsm-write-path.md §6) — so the Docker
 * harness cannot serve it, and live BATL is the only place its shape can be
 * read. Deliberately not built on `recon/env.ts`: that module logs in and its
 * disposable-host guard exists because every other script here *writes*. This
 * one holds no credentials and calls nothing but a GET.
 *
 * **It prints a shape, not the standings.** Key paths and value types, with
 * strings reduced to their length. The response is full of driver names, and
 * the point of running this is to paste the answer somewhere champctl can read
 * it — so it must be safe to paste.
 *
 *   npm run recon:standings -- https://ac.example.com <championship-id>
 */

import { HttpAcsmReader } from "../../src/acsm/client.js"
import { parseStandings } from "../../src/bot/standings.js"
import { runRecon } from "./env.js"

/** A value as its type, with anything identifying reduced to a shape. */
function shapeOf(v: unknown, depth = 0): unknown {
  if (v === null) return "null"
  if (Array.isArray(v)) {
    // The first two entries only. A thirty-driver array says nothing the first
    // two don't, and the second one catches a field that is absent on the
    // leader — a winner's "gap to leader" being 0 or missing, say.
    if (v.length === 0) return "[] (empty)"
    return { length: v.length, entries: v.slice(0, 2).map((e) => shapeOf(e, depth + 1)) }
  }
  if (typeof v === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, value] of Object.entries(v as Record<string, unknown>)) {
      out[k] = shapeOf(value, depth + 1)
    }
    return out
  }
  if (typeof v === "string") return `string(${v.length})`
  return typeof v
}

async function main(): Promise<void> {
  const [baseUrl, championshipId] = process.argv.slice(2)
  if (!baseUrl || !championshipId) {
    throw new Error(
      "Usage: npm run recon:standings -- <base-url> <championship-id>\n" +
        "Reads only, needs no credentials, and prints a shape rather than any driver's name.",
    )
  }

  const reader = new HttpAcsmReader({
    baseUrl,
    userAgent: "acsm-champctl/0.1 (recon:standings)",
  })

  const body = await reader.standings(championshipId)

  process.stdout.write(`${JSON.stringify(shapeOf(body), null, 2)}\n\n`)

  // The point of the exercise: does the parser champctl ships recognise this?
  const parsed = parseStandings(body)
  if (parsed) {
    const classes = parsed.map((c) => `${c.name || "(unnamed)"}: ${c.rows.length} rows`)
    process.stdout.write(`parseStandings understood it — ${classes.join(", ")}\n`)
  } else {
    process.stdout.write(
      "parseStandings did NOT understand it. The shape above is what it needs to learn;\n" +
        "it is safe to paste, since no names or point totals are in it.\n",
    )
  }
}

await runRecon("recon:standings", main)
