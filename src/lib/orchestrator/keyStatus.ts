import type { Tier } from '@/lib/providers/types'
import { isProviderConfigured } from '@/lib/providers/registry'

/**
 * Per-tier API-key configuration status for the debug panel.
 *
 * As of PR C, this consults the active provider per tier (read from
 * PROVIDER_<TIER> env vars, default 'anthropic') and reports whether
 * that provider's API key is configured. Falls through to the
 * PROVIDER_FALLBACK provider if the primary is unconfigured.
 */

export interface KeyStatus {
  small: boolean
  medium: boolean
  large: boolean
}

const ENV_BY_TIER: Record<Tier, string> = {
  small: 'PROVIDER_SMALL',
  medium: 'PROVIDER_MEDIUM',
  large: 'PROVIDER_LARGE',
}

function readActiveProviderForTier(tier: Tier): string {
  return process.env[ENV_BY_TIER[tier]] || 'anthropic'
}

function readFallback(): string {
  return process.env.PROVIDER_FALLBACK || 'anthropic'
}

function tierConfigured(tier: Tier): boolean {
  const primary = readActiveProviderForTier(tier)
  if (isValidProvider(primary) && isProviderConfigured(primary)) return true
  const fb = readFallback()
  return isValidProvider(fb) && isProviderConfigured(fb)
}

function isValidProvider(name: string): name is Parameters<typeof isProviderConfigured>[0] {
  return name === 'anthropic' || name === 'groq' || name === 'ollama'
}

export function computeKeyStatus(): KeyStatus {
  return {
    small: tierConfigured('small'),
    medium: tierConfigured('medium'),
    large: tierConfigured('large'),
  }
}
