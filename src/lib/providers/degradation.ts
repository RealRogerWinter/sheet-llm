import type { ProviderName, Tier } from './types'

/**
 * Provider-degradation tracking. When a per-chat-per-tier provider
 * accumulates `DEGRADATION_THRESHOLD` schema-validation failures
 * (ProviderSchemaError), the rest of the conversation is auto-routed
 * to the fallback provider for that tier.
 *
 * In-memory only; cleared by `clearStickyForChat(chatId)` /
 * `_resetDegradation()`.
 */

export const DEGRADATION_THRESHOLD = 2

type Key = `${string}:${Tier}:${ProviderName}`

const failureCounts = new Map<Key, number>()

function key(chatId: string, tier: Tier, provider: ProviderName): Key {
  return `${chatId}:${tier}:${provider}`
}

export function reportProviderFailure(
  chatId: string,
  tier: Tier,
  provider: ProviderName,
): void {
  const k = key(chatId, tier, provider)
  failureCounts.set(k, (failureCounts.get(k) ?? 0) + 1)
}

export function isProviderDegraded(
  chatId: string,
  tier: Tier,
  provider: ProviderName,
): boolean {
  return (failureCounts.get(key(chatId, tier, provider)) ?? 0) >= DEGRADATION_THRESHOLD
}

export function clearDegradationForChat(chatId: string): void {
  for (const k of failureCounts.keys()) {
    if (k.startsWith(`${chatId}:`)) failureCounts.delete(k)
  }
}

/** Test-only: clear all degradation state. */
export function _resetDegradation(): void {
  failureCounts.clear()
}
