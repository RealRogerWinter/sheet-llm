// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

function req(headers: Record<string, string>): Request {
  return new Request('https://sheetllm.com/api/chat', { headers })
}
const CF = { 'cf-connecting-ip': '9.9.9.9', 'cf-ray': 'test-ray' }

afterEach(() => vi.unstubAllEnvs())

describe('isCfRequest', () => {
  it('requires cf-connecting-ip AND cf-ray', async () => {
    const { isCfRequest } = await import('@/lib/security/ipRisk')
    expect(isCfRequest(req(CF))).toBe(true)
    expect(isCfRequest(req({ 'cf-connecting-ip': '9.9.9.9' }))).toBe(false)
    expect(isCfRequest(req({}))).toBe(false)
  })
  it('also requires the edge-auth secret when SL_EDGE_AUTH_SECRET is set', async () => {
    vi.stubEnv('SL_EDGE_AUTH_SECRET', 'sekret')
    const { isCfRequest } = await import('@/lib/security/ipRisk')
    expect(isCfRequest(req(CF))).toBe(false)
    expect(isCfRequest(req({ ...CF, 'x-sl-edge-auth': 'sekret' }))).toBe(true)
    expect(isCfRequest(req({ ...CF, 'x-sl-edge-auth': 'wrong' }))).toBe(false)
  })
})

describe('parseAsnHeader', () => {
  it('accepts a pure integer and rejects multi-valued / non-integer (ADD-vs-SET footgun)', async () => {
    const { parseAsnHeader } = await import('@/lib/security/ipRisk')
    expect(parseAsnHeader('15169')).toBe(15169)
    expect(parseAsnHeader(' 15169 ')).toBe(15169)
    expect(parseAsnHeader('15169, 24940')).toBeNull()
    expect(parseAsnHeader('15169 24940')).toBeNull()
    expect(parseAsnHeader('abc')).toBeNull()
    expect(parseAsnHeader('0')).toBeNull()
    expect(parseAsnHeader(null)).toBeNull()
  })
})

describe('assessClientRisk', () => {
  it('is disabled (clear) when the master flag is off', async () => {
    const { assessClientRisk } = await import('@/lib/security/ipRisk')
    const v = assessClientRisk(req({ ...CF, 'cf-ipcountry': 'T1' }))
    expect(v.risky).toBe(false)
    expect(v.reason).toBe('disabled')
  })
  it('treats off-CF requests as clear (never trusts spoofable headers)', async () => {
    vi.stubEnv('SL_IP_RISK_ENABLED', '1')
    vi.stubEnv('SL_IP_RISK_TOR', '1')
    const { assessClientRisk } = await import('@/lib/security/ipRisk')
    const v = assessClientRisk(req({ 'cf-connecting-ip': '9.9.9.9', 'cf-ipcountry': 'T1' })) // no cf-ray
    expect(v.risky).toBe(false)
    expect(v.reason).toBe('off_cf')
  })
  it('flags TOR via cf-ipcountry=T1 only when enabled + on-CF', async () => {
    vi.stubEnv('SL_IP_RISK_ENABLED', '1')
    vi.stubEnv('SL_IP_RISK_TOR', '1')
    const { assessClientRisk } = await import('@/lib/security/ipRisk')
    expect(assessClientRisk(req({ ...CF, 'cf-ipcountry': 'T1' })).reason).toBe('tor')
    expect(assessClientRisk(req({ ...CF, 'cf-ipcountry': 'US' })).risky).toBe(false)
  })
  it('flags a denylisted ASN, and allow-list beats deny-list', async () => {
    vi.stubEnv('SL_IP_RISK_ENABLED', '1')
    vi.stubEnv('SL_IP_RISK_ASN', '1')
    vi.stubEnv('SL_IP_RISK_EXTRA_DENY_ASNS', '64500')
    const { assessClientRisk, __resetIpRiskCacheForTesting } = await import('@/lib/security/ipRisk')
    __resetIpRiskCacheForTesting()
    expect(assessClientRisk(req({ ...CF, 'x-sl-client-asn': '64500' })).reason).toBe('datacenter_asn')
    vi.stubEnv('SL_IP_RISK_ALLOW_ASNS', '64500')
    expect(assessClientRisk(req({ ...CF, 'x-sl-client-asn': '64500' })).risky).toBe(false)
  })
  it('treats a comma-joined ASN header (append footgun) as unknown, not risky', async () => {
    vi.stubEnv('SL_IP_RISK_ENABLED', '1')
    vi.stubEnv('SL_IP_RISK_ASN', '1')
    vi.stubEnv('SL_IP_RISK_EXTRA_DENY_ASNS', '24940')
    const { assessClientRisk } = await import('@/lib/security/ipRisk')
    // attacker sends a benign ASN; the edge appends the real one → "7922, 24940"
    expect(assessClientRisk(req({ ...CF, 'x-sl-client-asn': '7922, 24940' })).risky).toBe(false)
  })

  it('logs a verdict under SL_IP_RISK_DEBUG (reason/asn/country, never the raw IP)', async () => {
    vi.stubEnv('SL_IP_RISK_ENABLED', '1')
    vi.stubEnv('SL_IP_RISK_ASN', '1')
    vi.stubEnv('SL_IP_RISK_DEBUG', '1')
    vi.stubEnv('SL_IP_RISK_EXTRA_DENY_ASNS', '64500')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { assessClientRisk } = await import('@/lib/security/ipRisk')
    assessClientRisk(req({ ...CF, 'x-sl-client-asn': '64500', 'cf-ipcountry': 'DE' }))
    const logged = warn.mock.calls.map((c) => c.join(' ')).join('\n')
    warn.mockRestore()
    expect(logged).toMatch(/\[ip-risk\] verdict/)
    expect(logged).toContain('datacenter_asn')
    expect(logged).toContain('64500') // observed ASN, for verifying the Transform Rule
    expect(logged).not.toContain('9.9.9.9') // raw IP must never be logged
  })

  it('does not log a verdict when SL_IP_RISK_DEBUG is off', async () => {
    vi.stubEnv('SL_IP_RISK_ENABLED', '1')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { assessClientRisk } = await import('@/lib/security/ipRisk')
    assessClientRisk(req({ ...CF, 'cf-ipcountry': 'US' }))
    const logged = warn.mock.calls.map((c) => c.join(' ')).join('\n')
    warn.mockRestore()
    expect(logged).not.toMatch(/\[ip-risk\] verdict/)
  })
})
