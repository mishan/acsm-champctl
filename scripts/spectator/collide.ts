/**
 * Two scripted cars and a recorder on a disposable server, with the plugin
 * feed listening: the second car drives into the first and reports the
 * contact the way a game client would, so the feed's collision event can be
 * checked against what was sent.
 *
 *   tsx scripts/spectator/collide.ts <host> <port> <acRoot> <car> <pluginListenPort> <pluginServerPort>
 */

import { SpectatorClient } from "../../src/spectator/client.js"
import { PluginListener } from "../../src/spectator/plugin.js"
import { WireWriter } from "../../src/spectator/wire.js"

const [
  host = "127.0.0.1",
  port = "9600",
  acRoot = ".",
  car = "",
  listen = "12001",
  command = "12000",
] = process.argv.slice(2)

class ScriptedDriver extends SpectatorClient {
  reportCollision(otherCarId: number, speed: number): void {
    this.sendTcp(
      new WireWriter()
        .u8(0x82)
        .u16(1)
        .u8(0x0a)
        .u8(otherCarId)
        .f32(speed)
        .vec3([10, 0, 20])
        .vec3([0.5, 0, 2])
        .build(),
    )
  }
}

const identity = (n: number) => ({
  guid: `7656119800000000${n}`,
  name: `champctl spike ${n}`,
  team: "",
  nation: "",
  car,
  password: "",
})
const still = { pos: [10, 0, 20], rot: [0, 0, 0], vel: [0, 0, 0] } as const
const base = { host, port: Number(port), acRoot, onPacket: () => {} }

const plugin = new PluginListener({
  listenPort: Number(listen),
  serverHost: host,
  serverPort: Number(command),
  realtimeIntervalMs: 100,
  onEvent: (e) => {
    if (e.kind !== "carUpdate") console.log("plugin <-", JSON.stringify(e))
  },
})
await plugin.start()

const a = new ScriptedDriver({
  ...base,
  identity: identity(1),
  pose: () => ({ pos: [...still.pos], rot: [0, 0, 0], vel: [0, 0, 0] }),
})
const b = new ScriptedDriver({
  ...base,
  identity: identity(2),
  pose: (t) => ({ pos: [10, 0, 20 - Math.max(0, 30 - t / 100)], rot: [0, 0, 0], vel: [0, 0, 10] }),
})
const sa = await a.connect()
await b.connect()
await new Promise((r) => setTimeout(r, 3000))
b.reportCollision(sa.carId, 12.5)
await new Promise((r) => setTimeout(r, 2000))
a.close()
b.close()
await new Promise((r) => setTimeout(r, 1000))
plugin.close()
