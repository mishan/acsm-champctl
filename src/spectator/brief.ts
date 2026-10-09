/**
 * An incident written up for a reader who wasn't there: the league's rules,
 * the measured facts and the timeline, as text. For pasting into any chat
 * model or handing to one over MCP; champctl itself calls no model.
 */

import type { CarFrame, IncidentPacket } from "./incident.js"

/**
 * Used when the league hasn't supplied its own rules. Conventions most sim
 * leagues share; a league's written rules should replace them.
 */
export const DEFAULT_RULES = `- A driver may make one defensive move off the racing line and may return to it, but not move in the braking zone in reaction to an attacker.
- To be entitled to racing room at a corner, an attacking car needs a meaningful overlap (roughly its front wheels alongside the other car's rear wheels or further) by the turn-in point.
- A driver with a meaningful overlap must be left a car's width; a driver without one must yield.
- The driver behind is generally responsible for contact from behind, including misjudged braking.
- Contact that neither driver could reasonably have avoided is a racing incident.`

/** What the recording can't show, so a reader doesn't take more from it than it holds. */
export const LIMITS = `- Positions come from the server at about 18 Hz and are interpolated between samples.
- Braking is only brake lights on or off, not pressure.
- Steering is a raw value whose scale hasn't been calibrated; use it for direction and timing, not degrees.
- The contact point comes from the reporting car's game.
- Lateral offsets are measured from the track's AI racing line, not the edge of the track. Positive is left.`

function frameCell(f: CarFrame | null): string {
  if (!f) return "-"
  const side =
    Math.abs(f.lateralM) < 0.3
      ? "on line"
      : `${Math.abs(f.lateralM).toFixed(1)}${f.lateralM > 0 ? "L" : "R"}`
  return `${Math.round(f.speedKmh)} km/h, ${side}${f.braking ? ", brake" : ""}${f.offTrackM > 0 ? `, ${f.offTrackM.toFixed(1)} m off` : ""}, steer ${f.steer}`
}

export function incidentBrief(p: IncidentPacket, rules = DEFAULT_RULES): string {
  const a = p.a.driver || `car ${p.a.carId}`
  const b = p.b.driver || `car ${p.b.carId}`
  const rows = p.timeline
    .filter((r) => r.t >= -6 && r.t <= 2 && Math.abs((r.t * 5) % 2) < 1e-6)
    .map(
      (r) =>
        `| ${r.t > 0 ? "+" : ""}${r.t.toFixed(1)} | ${r.gapM === null ? "-" : r.gapM.toFixed(1)} | ${frameCell(r.a)} | ${frameCell(r.b)} |`,
    )
  return `A collision in a sim racing league (Assetto Corsa), measured from a recording of the session. Who, if anyone, was responsible: A, B, both, or neither (a racing incident)? Say how confident you are, why, citing the facts and rules below, and what the recording doesn't show that would change your view. A human steward makes the decision.

Track: ${p.session.track}${p.session.trackConfig ? ` (${p.session.trackConfig})` : ""}, ${p.session.name}.

Car A: ${a}${p.a.model ? ` (${p.a.model})` : ""}. Car B: ${b}${p.b.model ? ` (${p.b.model})` : ""}. Car A's game reported the contact.

League rules:
${rules}

What the recording can't show:
${LIMITS}

Measured facts:
${p.facts.map((f) => `- ${f}`).join("\n")}

Timeline, every 0.4 s around the contact at t = 0. "Gap" is how far B was ahead of A along the track in meters (negative: behind). Lateral offsets are from the racing line, L or R.

| t (s) | gap (m) | A | B |
|---|---|---|---|
${rows.join("\n")}`
}
