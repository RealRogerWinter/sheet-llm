// Pure IP-address math shared by the IP-risk verdict (CIDR matching) and the
// daily-quota key normalization (prefix truncation). No I/O, no env, no deps.
//
// Why this exists: the shared clientIp.normalizeIp (clientIp.ts) has a known bug
// — it fails to collapse abbreviated IPv6 forms ('2001:db8::1' is left intact),
// so per-/64 rotation can dodge a limiter. Rather than touch that shared
// primitive (used by the burst limiter + Turnstile cookie binding), the quota
// layer does its own correct expand-then-truncate here. Addresses are held as a
// group array (IPv4 = 4×8-bit octets, IPv6 = 8×16-bit hextets) so '::' and
// IPv4-mapped forms normalize deterministically to the same network as their
// expanded equivalents — and it needs no BigInt (the repo targets ES2017).

export type IpAddr = { version: 4 | 6; groups: number[] }

function parseIpv4Groups(ip: string): number[] | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return null
  const g = [1, 2, 3, 4].map((i) => Number(m[i]))
  return g.some((o) => o > 255) ? null : g
}

/** Expand an IPv6 string to exactly 8 hextet numbers (handles '::' and a
 *  trailing IPv4-mapped dotted-quad), or null if malformed. */
export function expandIpv6(ip: string): number[] | null {
  let s = ip.trim().split('%')[0] // drop any zone id
  // Convert a trailing embedded IPv4 ('::ffff:1.2.3.4') to two hextets.
  const v4 = s.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (v4) {
    const quad = parseIpv4Groups(v4[2])
    if (!quad) return null
    s = v4[1] + ((quad[0] << 8) | quad[1]).toString(16) + ':' + ((quad[2] << 8) | quad[3]).toString(16)
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  if (halves.length === 1 && head.length !== 8) return null
  const fill = 8 - head.length - tail.length
  if (fill < 0 || (halves.length === 2 && fill < 1)) return null
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...tail]
  if (groups.length !== 8) return null
  const nums = groups.map((g) => (g === '' ? NaN : parseInt(g, 16)))
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null
  return nums
}

/** Parse an IPv4 or IPv6 address. Strips a trailing zone id and any '/prefix'
 *  so already-truncated inputs still parse. */
export function parseIp(ip: string): IpAddr | null {
  const clean = ip.trim().split('%')[0].split('/')[0]
  if (clean.includes(':')) {
    const g = expandIpv6(clean)
    return g ? { version: 6, groups: g } : null
  }
  const g = parseIpv4Groups(clean)
  return g ? { version: 4, groups: g } : null
}

const groupBits = (v: 4 | 6): number => (v === 4 ? 8 : 16)
const addrWidth = (v: 4 | 6): number => (v === 4 ? 32 : 128)

/** Zero every bit at or beyond `prefix`, group by group. */
function maskGroups(groups: number[], gbits: number, prefix: number): number[] {
  const full = (1 << gbits) - 1
  return groups.map((val, i) => {
    const start = i * gbits
    if (start + gbits <= prefix) return val // fully within the prefix
    if (start >= prefix) return 0 // fully outside
    const keep = prefix - start // 1..gbits-1 bits of this group survive
    return val & ((full << (gbits - keep)) & full)
  })
}

/** True iff `ip` is inside `cidr` (e.g. "10.0.0.0/8", "2001:db8::/32"). */
export function cidrContains(cidr: string, ip: string): boolean {
  const slash = cidr.lastIndexOf('/')
  if (slash < 0) return false
  const net = parseIp(cidr.slice(0, slash))
  const addr = parseIp(ip)
  const prefix = Number(cidr.slice(slash + 1))
  if (!net || !addr || net.version !== addr.version) return false
  const w = addrWidth(net.version)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > w) return false
  const gb = groupBits(net.version)
  const a = maskGroups(net.groups, gb, prefix)
  const b = maskGroups(addr.groups, gb, prefix)
  return a.every((v, i) => v === b[i])
}

/** Canonical "<network>/<prefix>" string for `ip` truncated to the given prefix
 *  (IPv4 uses `v4Prefix`, IPv6 uses `v6Prefix`). This is the stable seed the
 *  quota layer HMACs into a key. Returns null for an unparseable address. */
export function networkPrefix(ip: string, v4Prefix: number, v6Prefix: number): string | null {
  const p = parseIp(ip)
  if (!p) return null
  const w = addrWidth(p.version)
  const prefix = p.version === 4 ? v4Prefix : v6Prefix
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > w) return null
  const masked = maskGroups(p.groups, groupBits(p.version), prefix)
  const str = p.version === 4 ? masked.join('.') : masked.map((n) => n.toString(16)).join(':')
  return `${str}/${prefix}`
}
