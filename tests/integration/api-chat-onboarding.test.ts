// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { installTestDb, mockAuthSession } from '../factories/testEnv'
import { ProviderNotConfiguredError } from '@/lib/llm/errors'

// SHE-8 BYOK correctness — when a request reaches a provider with no API key
// configured (and no BYOK override), the route must return a clean onboarding
// CTA instead of leaking the raw `<ENV_VAR> is not set` upstream 5xx. We mock
// the orchestrator `run` to throw the typed error the providers now throw.

vi.mock('@/lib/auth/session', () => mockAuthSession())

const runMock = vi.fn()
vi.mock('@/lib/orchestrator', async (orig) => ({
  ...(await orig<typeof import('@/lib/orchestrator')>()),
  run: runMock,
}))

const { POST } = await import('@/app/api/chat/route')

function req(body: unknown) {
  return new Request('http://localhost:3000/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('/api/chat provider-not-configured → onboarding (SHE-8)', () => {
  installTestDb()
  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')
    runMock.mockReset()
    runMock.mockRejectedValue(new ProviderNotConfiguredError('Anthropic', 'ANTHROPIC_API_KEY'))
  })
  afterEach(() => vi.unstubAllEnvs())

  it('maps ProviderNotConfiguredError to 503 provider_not_configured with an onboarding CTA', async () => {
    const res = await POST(req({ message: 'write a short tune' }))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.code).toBe('provider_not_configured')
    // Never leak the env-var name to the user.
    expect(body.error).not.toContain('ANTHROPIC_API_KEY')
    expect(body.cta).toMatchObject({ kind: 'onboarding', primaryHref: '/settings' })
    expect(body.cta.primaryLabel).toBeTruthy()
  })
})
