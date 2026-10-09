/**
 * Records a disposable server for a while with a scripted car driving a
 * circle, then writes the replay: the whole recorder path, end to end.
 *
 *   tsx scripts/spectator/record.ts <host> <port> <acRoot> <car> <outDir> [seconds] [pluginListenPort pluginServerPort]
 */

import { writeReplay } from "../../src/spectator/acreplay.js"
import { SpectatorClient } from "../../src/spectator/client.js"
import { Recorder } from "../../src/spectator/recorder.js"

const [
  host = "127.0.0.1",
  port = "9600",
  acRoot = ".",
  car = "",
  outDir = ".",
  seconds = "20",
  listen,
  command,
] = process.argv.slice(2)

const identity = (n: number) => ({
  guid: `7656119800000000${n}`,
  name: `champctl spike ${n}`,
  team: "",
  nation: "",
  car,
  password: "",
})

const journals: string[] = []
const recorder = new Recorder({
  client: {
    host,
    port: Number(port),
    acRoot,
    identity: identity(1),
    pose: () => ({ pos: [0, 1000, 0], rot: [0, 0, 0], vel: [0, 0, 0] }),
  },
  ...(listen && command
    ? {
        plugin: {
          listenPort: Number(listen),
          serverHost: host,
          serverPort: Number(command),
          realtimeIntervalMs: 100,
        },
      }
    : {}),
  outDir,
  onJournal: (p) => journals.push(p),
  log: (m) => console.log("recorder:", m),
})
await recorder.start()
await new Promise((r) => setTimeout(r, 2000))

const R = 50
const driver = new SpectatorClient({
  host,
  port: Number(port),
  acRoot,
  identity: identity(2),
  pose: (t) => {
    const a = t / 5000
    // Driving counterclockwise seen from above, facing along the circle.
    return {
      pos: [R * Math.cos(a), 0, R * Math.sin(a)],
      rot: [Math.atan2(Math.sin(a), Math.cos(a)), 0, 0],
      vel: [(-R * Math.sin(a)) / 5, 0, (R * Math.cos(a)) / 5],
    }
  },
  onPacket: () => {},
})
await driver.connect()
await new Promise((r) => setTimeout(r, Number(seconds) * 1000))
driver.close()
await new Promise((r) => setTimeout(r, 1000))
await recorder.stop()

for (const j of journals) {
  const out = j.replace(/\.ndjson\.gz$/, ".acreplay")
  console.log(out, JSON.stringify(await writeReplay(j, out)))
}
