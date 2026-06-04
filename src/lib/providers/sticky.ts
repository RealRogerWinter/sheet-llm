import type { ProviderName, Tier } from './types'

/**
 * Sticky-per-chat provider selection. The first call that resolves
 * a provider per tier on a given chatId is remembered for the rest
 * of the conversation, so the same chat doesn't drift between
 * provider "voices" turn to turn.
 *
 * In-memory; cleared via `clearStickyForChat(chatId)` when the
 * conversation is deleted.
 */

type TierMap = Partial<Record<Tier, ProviderName>>

const store = new Map<string, TierMap>()

export function getSticky(chatId: string, tier: Tier): ProviderName | undefined {
  return store.get(chatId)?.[tier]
}

export function setSticky(chatId: string, tier: Tier, provider: ProviderName): void {
  const existing = store.get(chatId) ?? {}
  existing[tier] = provider
  store.set(chatId, existing)
}

export function clearStickyForChat(chatId: string): void {
  store.delete(chatId)
  // Also clear degradation tracking for this chat to keep the two
  // structures in lockstep (degradation requires a sticky key shape).
  // Imported lazily to avoid a circular import.
  void import('./degradation').then((m) => m.clearDegradationForChat(chatId))
}

/** Test-only: clear all sticky state. */
export function _resetSticky(): void {
  store.clear()
}
