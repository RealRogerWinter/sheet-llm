import { AsyncLocalStorage } from 'node:async_hooks'
import type { ProviderUsage } from '@/lib/providers/types'
import { billableCostUsd } from './pricing'

/**
 * Request-scoped LLM usage + cost meter.
 *
 * The orchestrator wraps a request in {@link runWithUsageMeter}; every
 * provider call inside that scope calls {@link recordProviderCall} at the
 * chokepoint, so the per-request total sums EVERY billable call — the
 * dispatcher, the handler, and each validation retry — not just the one
 * usage object a handler happens to return. This is observability only
 * (the cost is our RAW Anthropic spend, in micro-USD); customer billing
 * (PR-5) marks it up.
 *
 * Streaming paths (sectional score / converse) are pumped by the route
 * OUTSIDE this scope; their calls no-op here and are metered separately
 * in a follow-up. Capturing them here would require threading the request
 * id through the stream, which is deliberately deferred.
 */
export interface MeterTotals {
  inputTokens: number
  cachedInputTokens: number
  cacheCreationInputTokens: number
  outputTokens: number
  /** Raw Anthropic cost, USD (float). Round to micro-USD at the persist edge. */
  costUsd: number
  /** Number of provider calls metered. */
  callCount: number
  /** Calls whose model had no pricing entry (cost left unchanged, flagged). */
  unpricedCalls: number
}

interface MeterStore {
  requestId: string
  totals: MeterTotals
}

const als = new AsyncLocalStorage<MeterStore>()

function emptyTotals(): MeterTotals {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    callCount: 0,
    unpricedCalls: 0,
  }
}

/**
 * Run `fn` with a fresh per-request usage meter in scope. Concurrent
 * requests get isolated meters (AsyncLocalStorage), and the store is
 * garbage-collected with the scope — no map, no eviction, no leak.
 */
export function runWithUsageMeter<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
  return als.run({ requestId, totals: emptyTotals() }, fn)
}

/**
 * Record one provider call's usage + cost into the ambient request meter.
 * No-op outside a {@link runWithUsageMeter} scope. NEVER throws —
 * observability must not break a live provider call — so an unpriced or
 * invalid model is flagged (`unpricedCalls`) rather than propagated.
 */
export function recordProviderCall(model: string, usage: ProviderUsage | undefined): void {
  const store = als.getStore()
  if (!store) return
  const t = store.totals
  t.callCount++
  t.inputTokens += usage?.inputTokens ?? 0
  t.cachedInputTokens += usage?.cachedInputTokens ?? 0
  t.cacheCreationInputTokens += usage?.cacheCreationInputTokens ?? 0
  t.outputTokens += usage?.outputTokens ?? 0
  try {
    t.costUsd += billableCostUsd(model, {
      uncachedInputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      cacheReadInputTokens: usage?.cachedInputTokens ?? 0,
      cacheCreationInputTokens: usage?.cacheCreationInputTokens ?? 0,
    })
  } catch {
    // Unpriced / invalid model — keep the token tally, flag the gap, leave
    // cost untouched. (The strict billing path in PR-5 fails closed instead.)
    t.unpricedCalls++
  }
}

/** Snapshot of the ambient request meter (undefined outside a scope). */
export function currentMeterTotals(): MeterTotals | undefined {
  return als.getStore()?.totals
}

/** Convert a USD float to integer micro-USD (1e-6 USD) for the ledger column. */
export function toMicroUsd(usd: number): number {
  return Math.round(usd * 1_000_000)
}
