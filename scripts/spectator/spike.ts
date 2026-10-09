/**
 * Joins a disposable AC server twice: one car parked, recording, and one
 * driving a circle so there is something to record. Prints every packet kind
 * the recorder sees and how many position samples arrived per car.
 *
 *   tsx scripts/spectator/spike.ts <host> <port> <acRoot> <car> [seconds]
 */

import { SpectatorClient } from "../../src/spectator/client.js"
import type { ServerPacket } from "../../src/spectator/protocol.js"

const [host = "127.0.0.1", port = "9700", acRoot = ".", car = "", seconds = "30"] =
  process.argv.slice(2)

const identity = (n: number) => ({
  guid: `7656119800000000${n}`,
  name: `champctl spike ${n}`,
  team: "",
  nation: "",
  car,
  password: "",
})

const kinds = new Map<string, number>()
const samples = new Map<number, number[]>()
let lastDriver: ServerPacket | undefined

const recorder = new SpectatorClient({
  host,
  port: Number(port),
  identity: identity(1),
  acRoot,
  // Pit-box positions live in the track's models, which a server doesn't
  // have, so until they come from somewhere the recorder hovers well clear
  // of anything a car could drive into.
  pose: () => ({ pos: [0, 1000, 0], rot: [0, 0, 0], vel: [0, 0, 0] }),
  onPacket: (p) => {
    const k = p.kind === "unknown" ? `unknown 0x${p.id.toString(16)}` : p.kind
    kinds.set(k, (kinds.get(k) ?? 0) + 1)
    if (p.kind === "position") {
      for (const c of p.cars) {
        const ts = samples.get(c.carId) ?? []
        ts.push(c.timestamp)
        samples.set(c.carId, ts)
      }
      lastDriver = p
    } else if (p.kind !== "ping") {
      console.log("recorder <-", JSON.stringify(p))
    }
  },
  onClose: (r) => console.log("recorder closed:", r),
})

const R = 50
const driver = new SpectatorClient({
  host,
  port: Number(port),
  identity: identity(2),
  acRoot,
  pose: (t) => {
    const a = t / 5000
    return {
      pos: [R * Math.cos(a), 0, R * Math.sin(a)],
      rot: [a, 0, 0],
      vel: [(-R * Math.sin(a)) / 5, 0, (R * Math.cos(a)) / 5],
    }
  },
  onPacket: () => {},
  onClose: (r) => console.log("driver closed:", r),
})

const s = await recorder.connect()
console.log("recorder joined:", JSON.stringify({ ...s, checksumPaths: s.checksumPaths }))
console.log("car list:", JSON.stringify(recorder.cars))
await driver.connect()
console.log("driver joined as car", driver.session?.carId)

await new Promise((r) => setTimeout(r, Number(seconds) * 1000))
driver.close()
await new Promise((r) => setTimeout(r, 1500))
recorder.close()

console.log("packet kinds:", JSON.stringify(Object.fromEntries(kinds)))
for (const [id, ts] of samples) {
  const span = (ts.at(-1)! - ts[0]!) / 1000
  console.log(
    `car ${id}: ${ts.length} samples over ${span.toFixed(1)} s = ${(ts.length / span).toFixed(1)} Hz`,
  )
}
console.log("last position packet:", JSON.stringify(lastDriver))
