import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

describe('orchestrator/flags', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.stubEnv('ORCHESTRATOR_ENABLED', '')
    vi.stubEnv('ORCHESTRATOR_KILL', '')
    vi.stubEnv('ORCHESTRATOR_MODE', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('mode is primary by default (Phase 5 flip)', async () => {
    const { getOrchestratorMode } = await import('@/lib/orchestrator/flags')
    expect(getOrchestratorMode()).toBe('primary')
  })

  it('mode is off when ORCHESTRATOR_ENABLED=false (explicit opt-out)', async () => {
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'false')
    const { getOrchestratorMode } = await import('@/lib/orchestrator/flags')
    expect(getOrchestratorMode()).toBe('off')
  })

  it('mode is off when ORCHESTRATOR_ENABLED=0', async () => {
    vi.stubEnv('ORCHESTRATOR_ENABLED', '0')
    const { getOrchestratorMode } = await import('@/lib/orchestrator/flags')
    expect(getOrchestratorMode()).toBe('off')
  })

  it('mode is primary when ORCHESTRATOR_ENABLED=true (explicit on)', async () => {
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')
    const { getOrchestratorMode } = await import('@/lib/orchestrator/flags')
    expect(getOrchestratorMode()).toBe('primary')
  })

  it('mode is shadow when ORCHESTRATOR_MODE=shadow (regardless of ENABLED)', async () => {
    vi.stubEnv('ORCHESTRATOR_MODE', 'shadow')
    const { getOrchestratorMode } = await import('@/lib/orchestrator/flags')
    expect(getOrchestratorMode()).toBe('shadow')
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')
    expect(getOrchestratorMode()).toBe('shadow')
  })

  it('explicit ENABLED=false beats ORCHESTRATOR_MODE=shadow (opt-out wins)', async () => {
    vi.stubEnv('ORCHESTRATOR_MODE', 'shadow')
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'false')
    const { getOrchestratorMode } = await import('@/lib/orchestrator/flags')
    expect(getOrchestratorMode()).toBe('off')
  })

  it('kill switch overrides everything', async () => {
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'true')
    vi.stubEnv('ORCHESTRATOR_MODE', 'shadow')
    vi.stubEnv('ORCHESTRATOR_KILL', '1')
    const { getOrchestratorMode } = await import('@/lib/orchestrator/flags')
    expect(getOrchestratorMode()).toBe('off')
  })

  it('isOrchestratorEnabled returns true for primary and shadow, false for off', async () => {
    const { isOrchestratorEnabled } = await import('@/lib/orchestrator/flags')
    // Default is primary now.
    expect(isOrchestratorEnabled()).toBe(true)
    vi.stubEnv('ORCHESTRATOR_ENABLED', 'false')
    expect(isOrchestratorEnabled()).toBe(false)
    vi.stubEnv('ORCHESTRATOR_ENABLED', '')
    vi.stubEnv('ORCHESTRATOR_MODE', 'shadow')
    expect(isOrchestratorEnabled()).toBe(true)
  })

  it('reads env fresh on every call (no module-load cache)', async () => {
    const { getOrchestratorMode } = await import('@/lib/orchestrator/flags')
    expect(getOrchestratorMode()).toBe('primary')
    vi.stubEnv('ORCHESTRATOR_KILL', '1')
    expect(getOrchestratorMode()).toBe('off')
    vi.stubEnv('ORCHESTRATOR_KILL', '')
    expect(getOrchestratorMode()).toBe('primary')
  })
})

describe('orchestrator/flags — isNewToolDispatchEnabled (PR-6 default-on)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.stubEnv('SL_NEW_TOOL_DISPATCH', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('is ON by default (unset env)', async () => {
    const { isNewToolDispatchEnabled } = await import('@/lib/orchestrator/flags')
    expect(isNewToolDispatchEnabled()).toBe(true)
  })

  it('is OFF when SL_NEW_TOOL_DISPATCH=0', async () => {
    vi.stubEnv('SL_NEW_TOOL_DISPATCH', '0')
    const { isNewToolDispatchEnabled } = await import('@/lib/orchestrator/flags')
    expect(isNewToolDispatchEnabled()).toBe(false)
  })

  it('is OFF when SL_NEW_TOOL_DISPATCH=false', async () => {
    vi.stubEnv('SL_NEW_TOOL_DISPATCH', 'false')
    const { isNewToolDispatchEnabled } = await import('@/lib/orchestrator/flags')
    expect(isNewToolDispatchEnabled()).toBe(false)
  })

  it('is OFF when SL_NEW_TOOL_DISPATCH=FALSE (case-insensitive)', async () => {
    vi.stubEnv('SL_NEW_TOOL_DISPATCH', 'FALSE')
    const { isNewToolDispatchEnabled } = await import('@/lib/orchestrator/flags')
    expect(isNewToolDispatchEnabled()).toBe(false)
  })

  it('is ON when SL_NEW_TOOL_DISPATCH=1 (explicit on)', async () => {
    vi.stubEnv('SL_NEW_TOOL_DISPATCH', '1')
    const { isNewToolDispatchEnabled } = await import('@/lib/orchestrator/flags')
    expect(isNewToolDispatchEnabled()).toBe(true)
  })

  it('is ON when SL_NEW_TOOL_DISPATCH=true', async () => {
    vi.stubEnv('SL_NEW_TOOL_DISPATCH', 'true')
    const { isNewToolDispatchEnabled } = await import('@/lib/orchestrator/flags')
    expect(isNewToolDispatchEnabled()).toBe(true)
  })

  it('is ON for any other value (anything-not-explicit-false → on)', async () => {
    vi.stubEnv('SL_NEW_TOOL_DISPATCH', 'maybe')
    const { isNewToolDispatchEnabled } = await import('@/lib/orchestrator/flags')
    expect(isNewToolDispatchEnabled()).toBe(true)
  })

  it('reads env fresh on every call (no module-load cache)', async () => {
    const { isNewToolDispatchEnabled } = await import('@/lib/orchestrator/flags')
    expect(isNewToolDispatchEnabled()).toBe(true)
    vi.stubEnv('SL_NEW_TOOL_DISPATCH', '0')
    expect(isNewToolDispatchEnabled()).toBe(false)
    vi.stubEnv('SL_NEW_TOOL_DISPATCH', '')
    expect(isNewToolDispatchEnabled()).toBe(true)
  })
})

describe('orchestrator/flags — isGhostPreviewEnabled (M24-PR-6 default-on)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.stubEnv('SL_GHOST_PREVIEW', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('is ON by default (unset env) — flipped in M24-PR-6', async () => {
    const { isGhostPreviewEnabled } = await import('@/lib/orchestrator/flags')
    expect(isGhostPreviewEnabled()).toBe(true)
  })

  it('is OFF when SL_GHOST_PREVIEW=0 (opt-out)', async () => {
    vi.stubEnv('SL_GHOST_PREVIEW', '0')
    const { isGhostPreviewEnabled } = await import('@/lib/orchestrator/flags')
    expect(isGhostPreviewEnabled()).toBe(false)
  })

  it('is OFF when SL_GHOST_PREVIEW=false', async () => {
    vi.stubEnv('SL_GHOST_PREVIEW', 'false')
    const { isGhostPreviewEnabled } = await import('@/lib/orchestrator/flags')
    expect(isGhostPreviewEnabled()).toBe(false)
  })

  it('is OFF when SL_GHOST_PREVIEW=FALSE (case-insensitive)', async () => {
    vi.stubEnv('SL_GHOST_PREVIEW', 'FALSE')
    const { isGhostPreviewEnabled } = await import('@/lib/orchestrator/flags')
    expect(isGhostPreviewEnabled()).toBe(false)
  })

  it('is ON when SL_GHOST_PREVIEW=1 (explicit on)', async () => {
    vi.stubEnv('SL_GHOST_PREVIEW', '1')
    const { isGhostPreviewEnabled } = await import('@/lib/orchestrator/flags')
    expect(isGhostPreviewEnabled()).toBe(true)
  })

  it('is ON when SL_GHOST_PREVIEW=true', async () => {
    vi.stubEnv('SL_GHOST_PREVIEW', 'true')
    const { isGhostPreviewEnabled } = await import('@/lib/orchestrator/flags')
    expect(isGhostPreviewEnabled()).toBe(true)
  })

  it('is ON for any other value (anything-not-explicit-false → on)', async () => {
    vi.stubEnv('SL_GHOST_PREVIEW', 'maybe')
    const { isGhostPreviewEnabled } = await import('@/lib/orchestrator/flags')
    expect(isGhostPreviewEnabled()).toBe(true)
  })

  it('reads env fresh on every call (no module-load cache)', async () => {
    const { isGhostPreviewEnabled } = await import('@/lib/orchestrator/flags')
    expect(isGhostPreviewEnabled()).toBe(true)
    vi.stubEnv('SL_GHOST_PREVIEW', '0')
    expect(isGhostPreviewEnabled()).toBe(false)
    vi.stubEnv('SL_GHOST_PREVIEW', '')
    expect(isGhostPreviewEnabled()).toBe(true)
  })
})
