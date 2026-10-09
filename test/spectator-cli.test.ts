import { describe, expect, it } from "vitest"

import { UsageError } from "../src/cli/args.js"
import { parseArgs } from "../src/cli/spectator.js"

const record = [
  "record",
  "--server",
  "127.0.0.1:9600",
  "--ac-root",
  "/ac",
  "--car",
  "mx5",
  "--guid",
  "76561198000000001",
  "--out",
  "/rec",
]

describe("champctl-spectator parseArgs", () => {
  it("reads a record command, plugin feed included", () => {
    expect(
      parseArgs([...record, "--plugin-listen", "12001", "--plugin-server", "127.0.0.1:12000"]),
    ).toMatchObject({
      command: "record",
      host: "127.0.0.1",
      port: 9600,
      park: [0, 1000, 0],
      plugin: {
        listenHost: "127.0.0.1",
        listenPort: 12001,
        serverHost: "127.0.0.1",
        serverPort: 12000,
      },
      replay: true,
    })
  })

  it.each([
    ["no server", record.filter((_, i) => i !== 1 && i !== 2), /needs --server/],
    [
      "a server without a port",
      [...record.slice(0, 2), "localhost", ...record.slice(3)],
      /host:port/,
    ],
    [
      "a GUID that isn't a Steam64 ID",
      [...record.slice(0, 8), "123", ...record.slice(9)],
      /17-digit/,
    ],
    ["half a plugin config", [...record, "--plugin-listen", "12001"], /go together/],
    ["a park position with two numbers", [...record, "--park", "1,2"], /x,y,z/],
    ["a park position with an empty number", [...record, "--park", "1,2,"], /x,y,z/],
    ["--plugin-from without the feed", [...record, "--plugin-from", "10.0.0.1"], /plugin-listen/],
    ["an option it doesn't know", [...record, "--pasword", "x"], /Unknown option --pasword/],
  ])("refuses %s", (_, argv, message) => {
    expect(() => parseArgs(argv)).toThrow(UsageError)
    expect(() => parseArgs(argv)).toThrow(message)
  })
})
