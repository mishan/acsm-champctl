/**
 * "Is this host a throwaway test container?"
 *
 * The recon scripts and the live test suite write to the manager they point
 * at — recon imports championships and does not clean up after itself; the
 * live tests import and then delete. Pointing either at a league's production
 * manager would be the worst thing in this repo, so both ask here first.
 *
 * The rule is *private network reachability*, not certainty. A league could in
 * principle run ACSM on a private address, so this is a speed bump against the
 * obvious mistake — pasting a public hostname — rather than a guarantee. The
 * explicit override exists for everything else.
 */

import ipaddr from "ipaddr.js"

export const OVERRIDE_ENV = "CHAMPCTL_I_KNOW_THIS_ISNT_LOCAL"

/**
 * Address ranges that count as "your own machine or network", by ipaddr.js's
 * names for them.
 *
 * An allow-list rather than a deny-list, because that is the direction this
 * guard has to fail in: a range nobody here thought about — `reserved`,
 * `deprecatedSiteLocal`, `6to4`, `teredo`, plain global `unicast` — is not
 * disposable, and needs the explicit override.
 *
 * `unspecified` covers 0.0.0.0 and ::, which mean "this host" when bound.
 */
const DISPOSABLE_RANGES: ReadonlySet<string> = new Set([
  "loopback",
  "private", // 10/8, 172.16/12, 192.168/16
  "linkLocal", // 169.254/16 and fe80::/10
  "uniqueLocal", // fc00::/7
  "carrierGradeNat", // 100.64/10, which some home routers hand out
  "unspecified",
])

const LOOPBACK_NAMES = new Set([
  "localhost",
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
 * Two separate questions, in order. If the host parses as an IP address its
 * range decides, and nothing below is consulted. Otherwise it is a name, and
 * the DNS rules apply: mDNS and container suffixes, then a bare single-label
 * host.
 *
 * That ordering is load-bearing. The name rules end in "no dots means local",
 * and no IPv6 address contains a dot — so when address matching was hand-rolled
 * and simply fell through on a miss, every global IPv6 address
 * (`2606:4700:4700::1111`) reached that rule and was called disposable.
 * Deciding addresses and names in separate branches is what rules out that
 * whole class of mistake.
 */
export function isDisposableHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "")
  if (!host) return false
  if (LOOPBACK_NAMES.has(host)) return true

  // Addresses: ipaddr.js rather than regexes. These ranges have more edges
  // than they look — fe80::/10 is a ten-bit prefix, so it runs fe80..febf and
  // not fe80 alone; fec0::/10 sits immediately next to it and is *not* local;
  // ::ffff:192.168.1.5 has to be read as its IPv4 form; and `10.0.0` is
  // inet_aton for 10.0.0.0, which is where a browser would send you. Each of
  // those was wrong when this was written by hand.
  if (ipaddr.isValid(host)) {
    const addr = ipaddr.parse(host)
    // An IPv4 address wearing an IPv6 coat; judge the address it really is.
    // Only IPv6 has that range, hence the instanceof.
    if (addr instanceof ipaddr.IPv6 && addr.range() === "ipv4Mapped") {
      return DISPOSABLE_RANGES.has(addr.toIPv4Address().range())
    }
    return DISPOSABLE_RANGES.has(addr.range())
  }

  // A colon here is an IPv6 literal that failed to parse: a DNS name cannot
  // contain one, and a URL's port is already stripped by the time we see the
  // hostname. Malformed, so no. Checked before the name rules because those
  // end in "no dots means local", and no IPv6 literal has dots.
  if (host.includes(":")) return false

  // Names. mDNS and container-DNS suffixes, plus a bare single-label hostname,
  // which can only resolve on a local network anyway.
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
        `They write to it: recon imports championships, and the live tests import and ` +
        `delete them. If you really mean it, set ${OVERRIDE_ENV}=yes.`,
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
