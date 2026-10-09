import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { acdKey, carWheels, readAcd, wheelsFromSuspension } from "../src/spectator/cardata.js"

/** An archive as the game's tools write one: each byte shifted up by the key. */
function pack(folder: string, files: Record<string, string>, marker = false): Buffer {
  const key = acdKey(folder)
  const parts: Buffer[] = []
  if (marker) {
    const head = Buffer.alloc(8)
    head.writeInt32LE(-1111, 0)
    head.writeInt32LE(912125, 4)
    parts.push(head)
  }
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text, "latin1")
    const head = Buffer.alloc(4)
    head.writeInt32LE(name.length)
    const len = Buffer.alloc(4)
    len.writeInt32LE(body.length)
    const slots = Buffer.alloc(body.length * 4)
    for (const [i, byte] of body.entries()) {
      slots.writeUInt32LE((byte + key.charCodeAt(i % key.length)) & 0xff, i * 4)
    }
    parts.push(head, Buffer.from(name, "latin1"), len, slots)
  }
  return Buffer.concat(parts)
}

// A Nissan R32 JTCC's own numbers, from its suspensions.ini.
const R32 = `[HEADER]
VERSION=4
[BASIC]
WHEELBASE=2.615 ; Wheelbase distance in meters
CG_LOCATION=0.5900
[FRONT]
TYPE=STRUT
BASEY=-0.150
TRACK=1.584
[REAR]
TYPE=DWB
BASEY=-0.138
TRACK=1.520
`

describe("acdKey", () => {
  // Published by, and agreed between, two independent open-source readers.
  it.each([
    ["", "0-0-0-131-66-101-171-171"],
    ["t", "116-0-0-131-66-101-171-171"],
    ["abc", "38-158-0-190-66-4-74-100"],
    ["test", "192-45-0-55-66-241-55-117"],
    ["testing", "254-7-113-249-206-21-55-104"],
    ["ks_ferrari_f2004", "179-44-163-59-166-193-14-53"],
  ])("%j", (folder, key) => {
    expect(acdKey(folder)).toBe(key)
  })
})

describe("readAcd", () => {
  it("decodes bytes published from another reader's tests", () => {
    // "example file contents" under the key for "test": e+'1' = 0x96, x+'9' = 0xB1.
    const buf = Buffer.concat([
      Buffer.from([12, 0, 0, 0]),
      Buffer.from("example-file", "latin1"),
      Buffer.from([2, 0, 0, 0, 0x96, 0, 0, 0, 0xb1, 0, 0, 0]),
    ])
    expect(readAcd(buf, "test").get("example-file")?.toString("latin1")).toBe("ex")
  })

  it.each([false, true])("reads every file back, Kunos header %s", (marker) => {
    const files = readAcd(
      pack("my_car", { "car.ini": "[HEADER]\nVERSION=1", "suspensions.ini": R32 }, marker),
      "my_car",
    )
    expect(files.get("car.ini")?.toString("latin1")).toBe("[HEADER]\nVERSION=1")
    expect(files.get("suspensions.ini")?.toString("latin1")).toBe(R32)
  })

  it("refuses a file that isn't an archive", () => {
    expect(() => readAcd(Buffer.from("not an archive at all"), "my_car")).toThrow(
      /isn't an archive/,
    )
  })
})

describe("wheelsFromSuspension", () => {
  it("puts an R32's wheels where the game did in a replay it wrote", () => {
    // Medians over a race: front-left and rear-left, x left, y up, z forward.
    const measured = [
      [0.791, -0.144, 1.072],
      [0.76, -0.122, -1.542],
    ]
    const w = wheelsFromSuspension(R32)
    for (const [got, want] of [
      [w[0], measured[0]!],
      [w[2], measured[1]!],
    ] as const) {
      expect(Math.abs(got[0] - want[0]!)).toBeLessThan(0.01)
      expect(Math.abs(got[2] - want[2]!)).toBeLessThan(0.01)
      // Height is unloaded geometry; the car sits lower on the road.
      expect(Math.abs(got[1] - want[1]!)).toBeLessThan(0.02)
    }
    expect(w[1]).toEqual([-w[0][0], w[0][1], w[0][2]])
  })

  it("says which number it couldn't find", () => {
    expect(() => wheelsFromSuspension(R32.replace(/WHEELBASE=.*/, ""))).toThrow(/BASIC.WHEELBASE/)
  })
})

describe("carWheels", () => {
  let cars: string
  beforeAll(async () => {
    cars = await mkdtemp(join(tmpdir(), "cars-"))
    await mkdir(join(cars, "unpacked", "data"), { recursive: true })
    await writeFile(
      join(cars, "unpacked", "data", "suspensions.ini"),
      R32.replace("2.615", "3.000"),
    )
    await mkdir(join(cars, "packed"))
    await writeFile(
      join(cars, "packed", "data.acd"),
      pack("packed", { "suspensions.ini": R32 }, true),
    )
  })
  afterAll(async () => {
    await rm(cars, { recursive: true, force: true })
  })

  it("reads an unpacked car's data folder, and a packed car's archive", async () => {
    expect((await carWheels(cars, "unpacked"))?.[0][2]).toBeCloseTo(3 * 0.41, 3)
    expect((await carWheels(cars, "packed"))?.[0][2]).toBeCloseTo(2.615 * 0.41, 3)
  })

  it("has nothing for a car it doesn't have", async () => {
    expect(await carWheels(cars, "missing")).toBeUndefined()
  })
})
