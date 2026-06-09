import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { skipReason, type LiveCaseSpec } from '../../../evals/lib/buildLiveCase'

// skipReason only reads spec.expensive, so a minimal cast is sufficient.
const spec = (expensive = false) => ({ expensive }) as unknown as LiveCaseSpec

function setEnv(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
}

describe('buildLiveCase gate — provider-key-aware (SHE-15)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    // Known-empty baseline for every knob the gate consults.
    setEnv({
      RUN_LIVE_EVALS: '',
      RUN_LIVE_FULL: '',
      ANTHROPIC_API_KEY: '',
      GROQ_API_KEY: '',
      PROVIDER_MEDIUM: '',
      PROVIDER_FALLBACK: '',
    })
  })
  afterEach(() => vi.unstubAllEnvs())

  it('skips when RUN_LIVE_EVALS is unset', () => {
    expect(skipReason(spec())).toBe('no_run_flag')
  })

  it('skips (no_api_key) when no provider key is configured', () => {
    setEnv({ RUN_LIVE_EVALS: '1' })
    expect(skipReason(spec())).toBe('no_api_key')
  })

  it('runs on the default Anthropic medium tier when ANTHROPIC_API_KEY is set', () => {
    setEnv({ RUN_LIVE_EVALS: '1', ANTHROPIC_API_KEY: 'sk-ant-test' })
    expect(skipReason(spec())).toBeNull()
  })

  it('runs a Groq-only sweep (PROVIDER_MEDIUM=groq + GROQ_API_KEY, no Anthropic key)', () => {
    setEnv({ RUN_LIVE_EVALS: '1', PROVIDER_MEDIUM: 'groq', PROVIDER_FALLBACK: 'groq', GROQ_API_KEY: 'gsk-test' })
    expect(skipReason(spec())).toBeNull()
  })

  it('blocks a Groq route with no GROQ_API_KEY and no Anthropic fallback key', () => {
    setEnv({ RUN_LIVE_EVALS: '1', PROVIDER_MEDIUM: 'groq', PROVIDER_FALLBACK: 'groq' })
    expect(skipReason(spec())).toBe('no_api_key')
  })

  it('gates expensive cases behind RUN_LIVE_FULL', () => {
    setEnv({ RUN_LIVE_EVALS: '1', ANTHROPIC_API_KEY: 'sk-ant-test' })
    expect(skipReason(spec(true))).toBe('expensive_off')
    setEnv({ RUN_LIVE_FULL: '1' })
    expect(skipReason(spec(true))).toBeNull()
  })
})
