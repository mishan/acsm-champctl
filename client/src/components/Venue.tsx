import type { InstalledItem } from "../api"
import { venueLabel } from "../format"

/**
 * A round's track by the name people know it by, with the folder name beside
 * it. The folder name stays because it is what Server Manager and the pit
 * table use, and what someone checking champctl's work is looking for; on its
 * own it read `ks_nurburgring/layout_gp_a` where a person looks for
 * "Nürburgring".
 *
 * Just the folder name until the installed tracks arrive, or when they don't
 * list this one.
 */
export function Venue({
  venue,
  tracks,
}: {
  venue: { track: string; layout: string }
  tracks: readonly InstalledItem[]
}): React.JSX.Element {
  const folder = venueLabel(venue)
  if (!folder) return <>no track set</>
  const name = tracks.find((t) => t.id === venue.track.trim())?.name
  if (!name) return <>{folder}</>
  return (
    <span className="venue">
      <span>{name}</span>
      <span className="picker-id">{folder}</span>
    </span>
  )
}
