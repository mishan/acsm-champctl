/**
 * Fails when the live suite skipped instead of running.
 *
 * `vitest run` exits 0 when no test matched, and the live suite skips itself
 * without CHAMPCTL_LIVE_URL — so a CI job that forgot to set it would go green
 * having proved nothing at all. That is the failure this guards.
 *
 * Reads the JSON reporter's output rather than the human summary. vitest writes
 * ANSI colour codes even through a pipe, so `Tests  35 passed` is really
 * `Tests  \x1b[1m\x1b[32m35 passed` in the bytes; a grep that looks correct in
 * the rendered log matches nothing, and under `bash -e` it kills the step after
 * the suite has passed.
 */

import { readFileSync } from "node:fs"

const path = process.argv[2]
if (!path) {
  process.stderr.write("Usage: assert-live-ran.mjs <vitest json output>\n")
  process.exit(2)
}

let report
try {
  report = JSON.parse(readFileSync(path, "utf8"))
} catch (e) {
  process.stderr.write(
    `Could not read ${path}: ${e instanceof Error ? e.message : String(e)}\n` +
      "The live suite should have written it with --reporter=json.\n",
  )
  process.exit(1)
}

const passed = Number(report.numPassedTests ?? 0)
const failed = Number(report.numFailedTests ?? 0)
const total = Number(report.numTotalTests ?? 0)

if (failed > 0) {
  process.stderr.write(`The live suite had ${failed} failing test(s).\n`)
  process.exit(1)
}

if (total === 0 || passed === 0) {
  process.stderr.write(
    "The live suite ran zero tests, which means it skipped rather than passed.\n" +
      "It skips without CHAMPCTL_LIVE_URL and CHAMPCTL_LIVE_PASSWORD — check the job's env.\n",
  )
  process.exit(1)
}

process.stdout.write(`Live suite ran for real: ${passed} passed of ${total}.\n`)
