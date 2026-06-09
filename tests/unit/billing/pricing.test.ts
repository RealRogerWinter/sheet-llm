import { describe, it, expect } from 'vitest'
import { estimateCostUsd } from '@/lib/billing/pricing'

// SHE-15: Groq candidate models must be priced so the eval cost telemetry is
// not silently $0. Rates verified at groq.com/pricing on 2026-06-09.
describe('Groq model pricing (SHE-15)', () => {
  it('prices openai/gpt-oss-20b input + output', () => {
    // 1M in @ $0.075 + 1M out @ $0.30 = $0.375
    expect(estimateCostUsd('openai/gpt-oss-20b', 1_000_000, 1_000_000)).toBeCloseTo(0.375, 6)
  })

  it('prices llama-3.1-8b-instant (cheapest candidate)', () => {
    // 1M in @ $0.05 + 1M out @ $0.08 = $0.13
    expect(estimateCostUsd('llama-3.1-8b-instant', 1_000_000, 1_000_000)).toBeCloseTo(0.13, 6)
  })

  it('applies the gpt-oss-20b cached-input discount', () => {
    // 1M fully-cached input @ $0.0375, no output
    expect(estimateCostUsd('openai/gpt-oss-20b', 1_000_000, 0, 1_000_000)).toBeCloseTo(0.0375, 6)
  })

  it('prices openai/gpt-oss-120b', () => {
    // 1M in @ $0.15 + 1M out @ $0.60 = $0.75
    expect(estimateCostUsd('openai/gpt-oss-120b', 1_000_000, 1_000_000)).toBeCloseTo(0.75, 6)
  })

  it('prices qwen/qwen3-32b and llama-3.3-70b-versatile', () => {
    expect(estimateCostUsd('qwen/qwen3-32b', 1_000_000, 1_000_000)).toBeCloseTo(0.88, 6) // 0.29 + 0.59
    expect(estimateCostUsd('llama-3.3-70b-versatile', 1_000_000, 1_000_000)).toBeCloseTo(1.38, 6) // 0.59 + 0.79
  })

  it('models no Groq cache-WRITE premium (cacheWrite5m == input rate)', () => {
    // 1M cache-creation input on gpt-oss-120b bills at the $0.15 input rate, not a 1.25x premium
    expect(estimateCostUsd('openai/gpt-oss-120b', 1_000_000, 0, 0, 1_000_000)).toBeCloseTo(0.15, 6)
  })
})
