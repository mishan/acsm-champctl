/**
 * The parts every champctl CLI needs, in one place.
 *
 * There are four entry points now — gridmom, archive, finalize, month — and
 * before this they each carried their own copy of the same three things: a
 * `UsageError` class, a `loadPits` that falls back when the default file isn't
 * there, and the `run()` wrapper that turns an exception into an exit code.
 *
 * Four copies of a helper is a nuisance. Four copies of `UsageError` is a bug
 * waiting to happen: they are distinct classes with the same name, so
 * `e instanceof UsageError` is false for an error raised by any of the others,
 * and the first shared helper to throw one would have its usage block silently
 * skipped by three of the four callers. Nothing depended on that yet, which is
 * the right time to fix it.
 *
 * What is deliberately *not* here: the argument loops themselves. gridmom takes
 * a command and a target, finalize takes an id and a round, month takes a
 * subcommand — the switch statements have little in common, and merging them
 * would mean a config object more complicated than the code it replaced. The
 * shared part is the error type and the IO, not the parsing.
 */

import { resolve } from "node:path"

import { EMPTY_PIT_TABLE, loadPitTable, type PitTable } from "../pits/table.js"

/**
 * A mistake the person can fix by retyping the command, as opposed to
 * something going wrong with ACSM.
 *
 * These always print the usage block, so the CLI explains itself rather than
 * just saying no. One class shared by every CLI, so a helper thrown from here
 * is recognised by whichever entry point happens to be running.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UsageError"
  }
}

/** Prints the message above the usage block. Returns the exit code for it. */
export function reportUsageError(e: UsageError, usage: string): number {
  process.stderr.write(`${e.message}\n\n${usage}`)
  return 3
}

/**
 * The track pit table, falling back to an empty one when there isn't a default.
 *
 * An explicit `--pits` that won't load is a mistake worth reporting; the
 * default may simply not exist yet, since the file is league data and
 * gitignored. Without it the grid checks degrade to a warning that the pit
 * count is unknown, which is the intended behaviour rather than a failure.
 */
export async function loadPits(path: string | undefined): Promise<PitTable> {
  const target = path ?? resolve(process.cwd(), "data/track-pits.json")
  try {
    return await loadPitTable(target)
  } catch (e) {
    if (path) throw e
    void e
    return EMPTY_PIT_TABLE
  }
}

/**
 * Runs a CLI's `main` and turns whatever escapes into an exit code.
 *
 * `main` is expected to handle its own `UsageError`s — it is the one that knows
 * which usage block to print — but this catches them too, because "no ACSM base
 * URL configured" is a usage mistake raised long after parsing, and forgetting
 * to wrap one of those is exactly the kind of thing that goes unnoticed until
 * someone sees a stack trace instead of a usage block.
 *
 * Anything else is ACSM or the filesystem misbehaving, which usage text won't
 * fix, so it gets one line naming the tool and exit 3.
 */
export async function runCli(
  options: { name: string; usage: string; main: (argv: readonly string[]) => Promise<number> },
  argv: readonly string[],
): Promise<void> {
  try {
    process.exitCode = await options.main(argv)
  } catch (e) {
    if (e instanceof UsageError) {
      process.exitCode = reportUsageError(e, options.usage)
      return
    }
    const msg = e instanceof Error ? e.message : String(e)
    process.stderr.write(`${options.name} couldn't run: ${msg}\n`)
    process.exitCode = 3
  }
}
