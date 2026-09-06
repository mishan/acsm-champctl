/**
 * A stand-in for ACSM's read side, over real HTTP.
 *
 * The drain builds its own `HttpAcsmReader` from `--base-url`, so there is no
 * seam to inject a fake through, and a test that reached past that would not be
 * testing the thing the operator runs. Serving the export over a loopback
 * socket costs a millisecond and exercises the reader as well.
 */
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

import type { Championship } from "../../src/acsm/types.js"

export interface AcsmStub {
  baseUrl: string
  /** Every path the stub was asked for, in order. */
  requests: string[]
  close(): Promise<void>
}

/**
 * Serves one championship's export, and 404s everything else.
 *
 * Anything the drain asks for beyond the export is a change worth noticing, so
 * the unknown paths are recorded rather than quietly answered.
 */
export async function acsmStub(
  championshipId: string,
  championship: Championship,
): Promise<AcsmStub> {
  const requests: string[] = []
  const server: Server = createServer((req, res) => {
    const path = req.url ?? ""
    requests.push(path)
    if (path === `/championship/${encodeURIComponent(championshipId)}/export`) {
      const body = JSON.stringify(championship)
      res.writeHead(200, { "content-type": "application/json" })
      res.end(body)
      return
    }
    res.writeHead(404, { "content-type": "text/plain" })
    res.end("no\n")
  })

  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready))
  const { port } = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((done) => server.close(() => done())),
  }
}
