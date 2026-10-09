// Apart from incident.ts because the league profile names this type, and the
// browser bundle reads the profile types: importing incident.ts there would
// pull Node's fs and zlib into the client build.

/**
 * The judgment calls in the measuring, in one place so a league can tune
 * them from its profile.
 */
export interface IncidentThresholds {
  /**
   * Center-to-center distance along the track within which two cars overlap.
   * About a wheelbase: the follower's front wheels level with the leader's
   * rear wheels, which is where most league rules start owing room.
   */
  overlapM: number
  /** Sideways movement, in meters, that counts as a car moving. */
  moveM: number
  /** Below this, in meters, a car held its line. */
  holdM: number
  /** Seconds before the contact over which movement is measured. */
  lookbackS: number
}

export const DEFAULT_THRESHOLDS: IncidentThresholds = {
  overlapM: 2.7,
  moveM: 0.8,
  holdM: 0.3,
  lookbackS: 1.5,
}
