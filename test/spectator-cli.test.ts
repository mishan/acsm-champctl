import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { UsageError } from "../src/cli/args.js"
import { parseArgs, replayWebhook } from "../src/cli/spectator.js"
import { fakeAcRoot, fakeAcServer } from "./support/fake-ac-server.js"
import { fakeRaceControl } from "./support/fake-race-control.js"

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
      park: [50000, -2000, 50000],
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
    [
      "collisions from both the plugin and race control",
      [
        ...record,
        "--plugin-listen",
        "12001",
        "--plugin-server",
        "h:12000",
        "--race-control",
        "https://a.example",
      ],
      /not both/,
    ],
    [
      "a race control address that isn't one",
      [...record, "--race-control", "acsm.example"],
      /ACSM address/,
    ],
    [
      "an empty car, as compose passes an unset one",
      [...record.slice(0, 5), "--car", "", ...record.slice(7)],
      /needs --car/,
    ],
    [
      "a clip that ends before it starts",
      ["replay", "j.ndjson.gz", "--from", "13:40", "--to", "12:35"],
      /later than --from/,
    ],
    [
      "a clip time that isn't one",
      ["replay", "j.ndjson.gz", "--from", "12m35s"],
      /time into the session/,
    ],
    ["cuts without the track", ["cuts", "j.ndjson.gz"], /needs --ac-root/],
    [
      "a replays address that isn't one",
      [...record, "--replay-url", "champctl.example/replays"],
      /replays page/,
    ],
    ["an option it doesn't know", [...record, "--pasword", "x"], /Unknown option --pasword/],
  ])("refuses %s", (_, argv, message) => {
    expect(() => parseArgs(argv)).toThrow(UsageError)
    expect(() => parseArgs(argv)).toThrow(message)
  })
})

describe("champctl-spectator record", () => {
  it("exits once stopped, though the race control feed never answers its close", async () => {
    // As ACSM behind Cloudflare didn't: the recorder had finished and the
    // process stayed up.
    const dir = await mkdtemp(join(tmpdir(), "record-cli-"))
    await fakeAcRoot(dir)
    const server = await fakeAcServer()
    const rc = await fakeRaceControl()
    const child = spawn(
      join("node_modules", ".bin", "tsx"),
      [
        "src/cli/spectator.ts",
        ...["record", "--server", `127.0.0.1:${server.port}`, "--ac-root", dir],
        ...["--car", "ks_mazda_mx5_cup", "--guid", "76561198000000001"],
        ...["--out", join(dir, "rec"), "--no-replay", "--race-control", rc.url],
      ],
      { stdio: "ignore" },
    )
    try {
      await server.joins(1)
      await rc.connections(1)
      const exited = new Promise<number | null>((r) => child.once("exit", r))
      child.kill("SIGINT")
      expect(await exited).toBe(0)
    } finally {
      child.kill("SIGKILL")
      await Promise.all([server.close(), rc.close()])
      await rm(dir, { recursive: true, force: true })
    }
  }, 20_000)
})

describe("replay clips", () => {
  it.each([
    ["12:35", 755_000],
    ["1:02:03", 3_723_000],
    ["90", 90_000],
    ["12:59.5", 779_500],
  ])("reads %s as a time into the session", (from, ms) => {
    expect(parseArgs(["replay", "j.ndjson.gz", "--from", from])).toMatchObject({
      window: { fromMs: ms, toMs: Number.POSITIVE_INFINITY },
    })
  })
})

describe("clip times", () => {
  it.each(["1e3", "0x10", " 5", "12:60", "-1", "Infinity"])("refuses %j", (from) => {
    expect(() => parseArgs(["replay", "j.ndjson.gz", "--from", from])).toThrow(
      /time into the session/,
    )
  })
})

describe("replayWebhook", () => {
  it("refuses a webhook it can't parse without repeating it, since the path is the token", () => {
    const pasted = '"https://discord.com/api/webhooks/1/SECRETTOKEN'
    expect(() => replayWebhook(pasted)).toThrow(UsageError)
    expect(() => replayWebhook(pasted)).not.toThrow(/SECRETTOKEN/)
  })

  it("takes an empty one as none", () => {
    expect(replayWebhook("")).toBeUndefined()
  })
})
