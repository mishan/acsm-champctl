/**
 * Writes synthetic track content into a harness's `assetto/content/tracks`.
 *
 *   npm run harness:tracks -- <assetto-content-tracks-dir>
 *
 * ACSM reads a track's pit count from `ui/ui_track.json`, so the pit-count
 * source (plan §4.5) and the `content.*` checks need tracks installed — and
 * champctl runs off-host, which is the whole reason that table exists.
 *
 * These are written rather than downloaded, and that is a deliberate choice
 * over shipping real content:
 *
 * - **No licence question.** Real AC tracks are redistributable under terms
 *   that vary per track and per author, and a test fixture is a bad place to
 *   find that out.
 * - **No Steam.** The stock tracks come from a Steam depot that needs an
 *   account owning Assetto Corsa (docs/acsm-write-path.md §7).
 * - **Exact.** A hand-written pit count is a number a test can assert. Real
 *   content's `ui_track.json` is also the thing that *lies* about pit counts on
 *   mod tracks, which is why the pit table has a `manual` source that wins.
 * - **Small.** A real track is tens of megabytes; these are a few hundred bytes.
 *
 * Nothing here can host a race — there is no geometry and no `acServer`. That
 * is fine: no test starts a session, and championship import validates no track
 * name.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

/**
 * A track ACSM will enumerate, and the pit count champctl should read back.
 *
 * The layouts matter as much as the pit counts. A track with layouts keeps its
 * `ui_track.json` one level deeper, under `ui/<layout>/`, and champctl's pit
 * table is keyed by `track` *and* `layout` for that reason — a fixture with
 * only single-layout tracks would never exercise the difference.
 */
export interface SyntheticTrack {
  track: string
  /** Omit for a track with no layouts. */
  layout?: string
  pitboxes: number
  name?: string
}

/**
 * Modelled on the fixtures the rest of the suite already uses, so a live run
 * and a unit test are talking about the same tracks.
 *
 * Suzuka's 20 is deliberately below BATL's usual grid: it is the track that
 * makes `MaxClients` bind in the emitter tests, and a fixture where nothing
 * binds would never show the cap being applied.
 */
export const HARNESS_TRACKS: readonly SyntheticTrack[] = [
  { track: "spa", pitboxes: 30, name: "Spa-Francorchamps" },
  { track: "suzuka", pitboxes: 20, name: "Suzuka Circuit" },
  { track: "monza", pitboxes: 28, name: "Autodromo Nazionale Monza" },
  // Layouts, so the track/layout key is exercised rather than assumed.
  { track: "brands_hatch", layout: "indy", pitboxes: 18, name: "Brands Hatch Indy" },
  { track: "brands_hatch", layout: "gp", pitboxes: 24, name: "Brands Hatch GP" },
]

/**
 * Writes each track's `ui_track.json`, creating directories as needed.
 *
 * Only the fields champctl and ACSM read are written. `pitboxes` is a *string*
 * because that is what real `ui_track.json` files carry — Kunos writes it
 * quoted, and a fixture with a number would let a parser that only handles
 * numbers pass here and fail on real content.
 */
export async function writeSyntheticTracks(
  contentTracksDir: string,
  tracks: readonly SyntheticTrack[] = HARNESS_TRACKS,
): Promise<string[]> {
  const written: string[] = []

  for (const t of tracks) {
    const dir = t.layout
      ? join(contentTracksDir, t.track, "ui", t.layout)
      : join(contentTracksDir, t.track, "ui")
    await mkdir(dir, { recursive: true })

    const path = join(dir, "ui_track.json")
    await writeFile(
      path,
      `${JSON.stringify(
        {
          name: t.name ?? t.track,
          pitboxes: String(t.pitboxes),
          country: "Synthetic",
          description: "champctl test fixture. Not a real track — no geometry, no surfaces.",
        },
        null,
        2,
      )}\n`,
      "utf8",
    )
    written.push(path)
  }

  return written
}

async function main(): Promise<void> {
  const dir = process.argv[2]
  if (!dir) {
    process.stderr.write(
      "Usage: npm run harness:tracks -- <path to assetto/content/tracks>\n" +
        "Writes synthetic ui_track.json files so the pit-count checks have something to read.\n",
    )
    process.exitCode = 2
    return
  }
  const written = await writeSyntheticTracks(dir)
  process.stdout.write(`Wrote ${written.length} synthetic tracks under ${dir}\n`)
}

// Only when run as a script; the exports above are used by tests.
if (process.argv[1]?.endsWith("tracks.ts")) {
  main().catch((e: unknown) => {
    process.stderr.write(`harness:tracks failed: ${e instanceof Error ? e.message : String(e)}\n`)
    process.exitCode = 1
  })
}
