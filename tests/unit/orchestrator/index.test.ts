import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * Phase 5+: route.ts is the sole mode gate; orchestrator.run always
 * runs once called. The interesting dispatch + fall-through assertions
 * live in dispatch.test.ts (with classify mocked); the integration
 * coverage lives in tests/integration/api-chat-orchestrator-phase*.ts.
 *
 * This file keeps a smoke that the module's top-level imports resolve
 * and the run() export exists.
 */
describe('orchestrator module surface', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.stubEnv('ORCHESTRATOR_LOG_SILENT', '1')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('exports run() as an async function', async () => {
    const mod = await import('@/lib/orchestrator')
    expect(typeof mod.run).toBe('function')
  })
})
