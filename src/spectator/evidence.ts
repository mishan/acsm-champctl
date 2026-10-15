/**
 * Everything the recording can say about one moment, for an incident report:
 * the measurements and suggested call where the server reported a collision,
 * where both cars were where it didn't, any track skip either made nearby, an
 * overhead video, and a replay clip to watch in the game.
 */

import { rm } from "node:fs/promises"
import { join } from "node:path"

import { writeReplay } from "./acreplay.js"
import { analyzeIncident, trackForJournal } from "./analysis.js"
import { listCollisions } from "./incident.js"
import { findTrackSkips, type TrackSkip } from "./cuts.js"
import { sessionStart } from "./journal.js"
import { renderIncidentSvg } from "./render.js"
import { callName } from "./rules.js"
import type { IncidentThresholds } from "./thresholds.js"
import { type FrameSink, ffmpegSink, loadClip, poseAt, writeVideo } from "./video.js"

export interface EvidenceRequest {
  journal: string
  /** For the racing line and the cars' wheel data. */
  acRoot: string
  /** Where the video and the replay clip are written. */
  outDir: string
  /** File names start with this, e.g. "incident-12". */
  stem: string
  /** The two cars, by slot. */
  carIds: [number, number]
  /** The moment, in ms from the session's start. */
  atMs: number
  /** A collision from `listCollisions`, when the report is about one. */
  collisionIndex?: number
  thresholds?: Partial<IncidentThresholds>
  /** Where the video's frames go; ffmpeg writing `path` unless a test says otherwise. */
  videoSink?: (path: string) => FrameSink
}

export interface Evidence {
  /** Plain sentences, for the report's channel. */
  summary: string[]
  /** The suggested call and its reasons, for a collision. */
  call?: string[]
  /** Overhead drawing of the approach, PNG, for a collision. */
  drawing?: Buffer
  video: string
  /** The replay clip's file name in `outDir`. */
  clip: string
  skips: TrackSkip[]
}

/** The video, from this long before the moment to this long after. */
const VIDEO_BEFORE_MS = 20_000
const VIDEO_AFTER_MS = 10_000
/** The replay clip, a little longer, for a run-up in the game. */
const CLIP_BEFORE_MS = 30_000
const CLIP_AFTER_MS = 15_000
/** A reported contact this near the moment is worth saying, whichever was picked. */
const CONTACT_NEAR_MS = 10_000
/** A track skip this near the moment is part of the story. */
const SKIP_NEAR_MS = 60_000

export async function gatherEvidence(q: EvidenceRequest): Promise<Evidence> {
  const track = await trackForJournal(q.journal, q.acRoot)
  const summary: string[] = []
  let call: string[] | undefined
  let drawing: Buffer | undefined
  if (q.collisionIndex !== undefined) {
    const { packet, suggestion } = await analyzeIncident(
      q.journal,
      q.collisionIndex,
      q.acRoot,
      q.thresholds,
    )
    summary.push(...packet.facts)
    call = [
      `Suggested call: ${callName(suggestion.call, packet)}${suggestion.rule ? ` (rule: ${suggestion.rule})` : ""}`,
      ...suggestion.reasons,
      "The call is the rules engine's; the decision is the stewards'.",
    ]
    drawing = await svgToPng(renderIncidentSvg(packet, track))
  }

  const window = { fromMs: Math.max(0, q.atMs - VIDEO_BEFORE_MS), toMs: q.atMs + VIDEO_AFTER_MS }
  const clip = await loadClip(q.journal, track, { ...window, focusCarIds: q.carIds })
  if (q.collisionIndex === undefined) {
    summary.push(...whereTheyWere(clip, track, q))
    const start = await sessionStart(q.journal)
    const contacts = (await listCollisions(q.journal)).filter(
      (c) =>
        c.otherCarId !== undefined &&
        q.carIds.includes(c.carId) &&
        q.carIds.includes(c.otherCarId) &&
        Math.abs(c.at - start - q.atMs) <= CONTACT_NEAR_MS,
    )
    summary.push(
      contacts.length === 0
        ? "The server reported no contact between them within 10 s of then."
        : `The server reported contact between them at ${contacts.map((c) => clock(c.at - start)).join(", ")}.`,
    )
  }

  const nearby = (await findTrackSkips(q.journal, track)).filter(
    (k) => q.carIds.includes(k.carId) && Math.abs(k.offS * 1000 - q.atMs) <= SKIP_NEAR_MS,
  )
  for (const k of nearby) {
    summary.push(
      `${k.driver} left the track ${clock(k.offS * 1000)} into the session and came back on ` +
        `${Math.round(k.skippedM)} m further round, ${k.savedS.toFixed(1)} s quicker than ` +
        `${k.field ? "other drivers' usual" : "their usual"} time through that stretch (${k.tookS.toFixed(1)} s against ${k.usualS.toFixed(1)} s).`,
    )
  }

  // The clip first: it refuses to replace one already there, so a stem that's
  // been used fails before anything of the earlier one is overwritten.
  const clipFile = `${q.stem}.acreplay`
  await writeReplay(q.journal, join(q.outDir, clipFile), {
    carsDir: join(q.acRoot, "content/cars"),
    window: { fromMs: Math.max(0, q.atMs - CLIP_BEFORE_MS), toMs: q.atMs + CLIP_AFTER_MS },
  })

  const video = join(q.outDir, `${q.stem}.mp4`)
  try {
    const sink = q.videoSink?.(video) ?? ffmpegSink(video, 1280, 720, 30)
    await writeVideo(clip, sink, { ...window, focusCarIds: q.carIds })
  } catch (e) {
    // Half a video plays as if it were the whole of one, and the stem is free to try again.
    await Promise.all([rm(video, { force: true }), rm(join(q.outDir, clipFile), { force: true })])
    throw e
  }

  return {
    summary,
    ...(call ? { call } : {}),
    ...(drawing ? { drawing } : {}),
    video,
    clip: clipFile,
    skips: nearby,
  }
}

/** Where the two cars were at the moment, for a report with no collision to measure. */
function whereTheyWere(
  clip: Awaited<ReturnType<typeof loadClip>>,
  track: Awaited<ReturnType<typeof trackForJournal>>,
  q: EvidenceRequest,
): string[] {
  const [a, b] = q.carIds.map((id) => clip.cars.find((c) => c.carId === id))
  const out = [`At ${clock(q.atMs)} into the session:`]
  const at = (c: (typeof clip.cars)[number] | undefined) => {
    const p = c && poseAt(c, q.atMs)
    return p && { ...p, ...track.project([p.x, 0, p.z]) }
  }
  const pa = at(a)
  const pb = at(b)
  for (const [c, p] of [
    [a, pa],
    [b, pb],
  ] as const) {
    if (!c || !p) {
      out.push(`${c?.driver ?? "One car"} wasn't recorded at that moment.`)
      continue
    }
    out.push(
      `${c.driver} was doing ${Math.round(p.kmh)} km/h, ${track.where(p.s)}` +
        (p.offTrack > 1 ? `, ${p.offTrack.toFixed(1)} m beyond the track edge.` : "."),
    )
  }
  if (a && b && pa && pb) {
    const gap = track.gap(pa.s, pb.s)
    const ahead = gap > 0 ? b : a
    const behind = gap > 0 ? a : b
    out.push(
      Math.abs(gap) < 5
        ? `They were side by side, ${Math.abs(gap).toFixed(1)} m apart along the track.`
        : `${ahead.driver} was ${Math.round(Math.abs(gap))} m ahead of ${behind.driver} along the track.`,
    )
  }
  return out
}

/** The drawing as PNG: what Discord shows inline. */
export async function svgToPng(svg: string): Promise<Buffer> {
  // Loaded here so a recorder never needs the native binary.
  const { createCanvas, loadImage } = await import("@napi-rs/canvas")
  const img = await loadImage(Buffer.from(svg))
  const canvas = createCanvas(img.width, img.height)
  canvas.getContext("2d").drawImage(img, 0, 0)
  return canvas.encode("png")
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}
