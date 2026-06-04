import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  reportProviderFailure,
  isProviderDegraded,
  _resetDegradation,
  DEGRADATION_THRESHOLD,
} from '@/lib/providers/degradation'

describe('providers/degradation', () => {
  beforeEach(() => {
    _resetDegradation()
    vi.unstubAllEnvs()
  })
  afterEach(() => {
    _resetDegradation()
    vi.unstubAllEnvs()
  })

  it('reports false until the threshold is reached', () => {
    expect(isProviderDegraded('chat-1', 'small', 'ollama')).toBe(false)
    for (let i = 0; i < DEGRADATION_THRESHOLD - 1; i++) {
      reportProviderFailure('chat-1', 'small', 'ollama')
    }
    expect(isProviderDegraded('chat-1', 'small', 'ollama')).toBe(false)
  })

  it('flips to degraded once the threshold is hit', () => {
    for (let i = 0; i < DEGRADATION_THRESHOLD; i++) {
      reportProviderFailure('chat-1', 'small', 'ollama')
    }
    expect(isProviderDegraded('chat-1', 'small', 'ollama')).toBe(true)
  })

  it('degradation is per-chat per-tier per-provider', () => {
    for (let i = 0; i < DEGRADATION_THRESHOLD; i++) {
      reportProviderFailure('chat-1', 'small', 'ollama')
    }
    // Different chat, same tier+provider: not degraded.
    expect(isProviderDegraded('chat-2', 'small', 'ollama')).toBe(false)
    // Same chat, different tier: not degraded.
    expect(isProviderDegraded('chat-1', 'medium', 'ollama')).toBe(false)
    // Same chat+tier, different provider: not degraded.
    expect(isProviderDegraded('chat-1', 'small', 'groq')).toBe(false)
  })

  it('threshold is configurable via DEGRADATION_THRESHOLD constant (default 2)', () => {
    expect(DEGRADATION_THRESHOLD).toBe(2)
  })
})
