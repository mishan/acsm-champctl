/**
 * "Is this host a throwaway test container?"
 *
 * The recon scripts and the live test suite create, modify and delete
 * championships. Pointing one at a league's production manager would be the
 * worst thing in this repo, so both ask here first.
 *
 * The rule is *private network reachability*, not certainty. A league could in
 * principle run ACSM on a private address, so this is a speed bump against the
 * obvious mistake — pasting a public hostname — rather than a guarantee. The
 * explicit override exists for everything else.
 */

export const OVERRIDE_ENV = "CHAMPCTL_I_KNOW_THIS_ISNT_LOCAL"

const LOOPBACK_NAMES = new Set([
  "localhost",
  "0.0.0.0",
  "host.docker.internal",
  // Compose service names, for running champctl inside the same network.
  "acsm",
  "champctl-acsm",
  "acsm-oss",
  "champctl-acsm-oss",
])

/**
 * True for a host that is plausibly a container on your own machine or LAN.
 *
 * Covers loopback, RFC1918 private ranges, RFC6598 carrier-grade NAT (which
 * some home routers hand out), link-local, and the `.local`/`.internal`
 * suffixes mDNS and container DNS use.
 */
export function isDisposableHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "")
  if (!host) return false
  if (LOOPBACK_NAMES.has(host)) return true

  // IPv6 loopback and unique-local/link-local prefixes.
  if (host === "::1" || host === "::") return true
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true // fc00::/7 unique local
  if (/^fe80:/.test(host)) return true // link local

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) {
    const parts = v4.slice(1, 5).map(Number)
    if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
    const [a, b] = parts as [number, number, number, number]
    if (a === 127) return true // loopback
    if (a === 10) return true // 10/8
    if (a === 192 && b === 168) return true // 192.168/16
    if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12
    if (a === 100 && b >= 64 && b <= 127) return true // 100.64/10 CGNAT
    if (a === 169 && b === 254) return true // link local
    return false
  }

  // mDNS and container-DNS suffixes, plus a bare single-label hostname, which
  // can only resolve on a local network anyway.
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost")) {
    return true
  }
  return !host.includes(".")
}

export class NotDisposableError extends Error {
  constructor(
    readonly hostname: string,
    what: string,
  ) {
    super(
      `Refusing to run ${what} against ${hostname}: it doesn't look like a local test container. ` +
        `These create and delete championships. If you really mean it, set ${OVERRIDE_ENV}=yes.`,
    )
    this.name = "NotDisposableError"
  }
}

/** Throws unless the URL's host is disposable or the override is set. */
export function assertDisposable(
  baseUrl: string,
  what: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  let hostname: string
  try {
    hostname = new URL(baseUrl).hostname
  } catch {
    throw new Error(`${baseUrl} is not a usable URL`)
  }
  if (isDisposableHost(hostname)) return
  if (env[OVERRIDE_ENV] === "yes") return
  throw new NotDisposableError(hostname, what)
}
