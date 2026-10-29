/**
 * The sign-up queue: a championship's sign-ups, and whether ACSM can be
 * trusted to accept or reject each one.
 *
 * ACSM's own accept and reject links have no guards, and two of what they do
 * unasked cost a driver their seat (measured on 2.4.15, docs/acsm-signups.md):
 *
 * - Accepting first clears the driver's existing seat, then looks for a free
 *   one for the car they chose. With none, it saves anyway: a driver who signed
 *   up again for a different car loses the seat they had.
 * - Rejecting clears the seat of whoever holds that Steam ID, so rejecting a
 *   seated driver's second sign-up takes them off the grid.
 *
 * So accepting is refused when there is no seat to give, and rejecting a
 * seated driver needs saying so.
 */

import { ANY_CAR_MODEL, type Championship, type Entrant } from "../acsm/types.js"
import { classes, signUpResponses } from "../acsm/view.js"
import type { SignUpView } from "../web/wire.js"

export const PENDING = "Pending Approval"

/** Every sign-up, pending ones first and newest first within each group. */
export function signUps(c: Championship): SignUpView[] {
  return signUpResponses(c)
    .filter((r) => r.GUID)
    .map((r) => {
      const guid = r.GUID ?? ""
      const car = r.Car ?? ""
      const status = r.Status ?? PENDING
      const problem = status === "Accepted" ? undefined : noSeatFor(c, guid, car)
      return {
        guid,
        name: r.Name ?? "",
        team: r.Team ?? "",
        car,
        skin: r.Skin ?? "",
        created: r.Created ?? "",
        status,
        questions: Object.entries(r.Questions ?? {}).map(([question, answer]) => ({
          question,
          answer,
        })),
        seated: seatOf(c, guid) !== undefined,
        ...(problem ? { cantAccept: problem } : {}),
      }
    })
    .sort(
      (a, b) =>
        Number(b.status === PENDING) - Number(a.status === PENDING) ||
        b.created.localeCompare(a.created),
    )
}

function entrants(c: Championship): Entrant[] {
  return classes(c).flatMap((cls) => Object.values(cls.Entrants ?? {}))
}

function seatOf(c: Championship, guid: string): Entrant | undefined {
  return entrants(c).find((e) => (e.GUID ?? "") === guid)
}

/**
 * Why ACSM would find this driver no seat, or undefined when it would.
 *
 * Its rule: the driver's own seat if it is already this car, else the first
 * empty seat set to this car, else the first empty `any_car_model` one.
 */
function noSeatFor(c: Championship, guid: string, car: string): string | undefined {
  const own = seatOf(c, guid)
  if (own && own.Model === car) return undefined
  const free = entrants(c).some(
    (e) => !e.GUID && !e.Name && (e.Model === car || e.Model === ANY_CAR_MODEL),
  )
  if (free) return undefined
  return own
    ? `There's no free seat for ${car || "the car they chose"}, and accepting would take ` +
        `away the seat they already have.`
    : `There's no free seat for ${car || "the car they chose"}. Add a slot to the entry ` +
        `list in Server Manager first.`
}
