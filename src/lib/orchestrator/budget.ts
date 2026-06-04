export interface SessionUsage {
  inputTokens: number
  outputTokens: number
}

export interface BudgetCap {
  inputTokens: number
  outputTokens: number
}

const DEFAULT_INPUT_CAP = 200_000
const DEFAULT_OUTPUT_CAP = 50_000

const usage = new Map<string, SessionUsage>()
const attemptCounters = new Map<string, number>()
let cap: BudgetCap | undefined

const MAX_BUDGET_ENTRIES = 50_000

// Bound the in-memory maps so a caller rotating chatId can't grow them
// unboundedly (memory DoS). Map preserves insertion order, so dropping from the
// front evicts the oldest (most likely-abandoned) chats first.
function evictIfFull<V>(map: Map<string, V>): void {
  if (map.size < MAX_BUDGET_ENTRIES) return
  const drop = Math.ceil(MAX_BUDGET_ENTRIES * 0.1)
  let i = 0
  for (const key of map.keys()) {
    map.delete(key)
    if (++i >= drop) break
  }
}

function getCap(): BudgetCap {
  if (cap) return cap
  const envIn = Number(process.env.ORCHESTRATOR_BUDGET_INPUT_TOKENS)
  const envOut = Number(process.env.ORCHESTRATOR_BUDGET_OUTPUT_TOKENS)
  return {
    inputTokens: Number.isFinite(envIn) && envIn > 0 ? envIn : DEFAULT_INPUT_CAP,
    outputTokens: Number.isFinite(envOut) && envOut > 0 ? envOut : DEFAULT_OUTPUT_CAP,
  }
}

export function getSessionUsage(chatId: string): SessionUsage {
  return usage.get(chatId) ?? { inputTokens: 0, outputTokens: 0 }
}

export function recordUsage(
  chatId: string,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
): void {
  const current = getSessionUsage(chatId)
  evictIfFull(usage)
  usage.set(chatId, {
    inputTokens: current.inputTokens + (inputTokens ?? 0),
    outputTokens: current.outputTokens + (outputTokens ?? 0),
  })
}

export function exceedsBudget(chatId: string): boolean {
  const u = getSessionUsage(chatId)
  const c = getCap()
  return u.inputTokens >= c.inputTokens || u.outputTokens >= c.outputTokens
}

/** Test-only: override the budget cap explicitly. */
export function _setBudgetCap(next: BudgetCap | undefined): void {
  cap = next
}

/** Test-only: clear all session usage. */
export function _resetBudget(): void {
  usage.clear()
  attemptCounters.clear()
  cap = undefined
}

export interface UsageAttempt {
  /** 0-indexed attempt number within this chat. */
  attemptIndex: number
  /** Record token usage for this attempt. Safe to call inside try
   *  blocks — the outer `withUsageRecording` commits in a finally,
   *  so failed attempts still bill the user. */
  record(tokens: { inputTokens?: number; outputTokens?: number }): void
}

/**
 * Run a callback that may make 1+ LLM calls; record token usage to
 * the session budget regardless of whether the callback resolves or
 * throws. Tokens recorded via `attempt.record()` always land in
 * `getSessionUsage(chatId)`, so a fallback-chain that fails on
 * provider A and retries on B still bills for both.
 */
export async function withUsageRecording<T>(
  chatId: string,
  fn: (attempt: UsageAttempt) => Promise<T>,
): Promise<T> {
  const attemptIndex = attemptCounters.get(chatId) ?? 0
  evictIfFull(attemptCounters)
  attemptCounters.set(chatId, attemptIndex + 1)
  let pendingInput = 0
  let pendingOutput = 0
  const attempt: UsageAttempt = {
    attemptIndex,
    record(tokens) {
      pendingInput += tokens.inputTokens ?? 0
      pendingOutput += tokens.outputTokens ?? 0
    },
  }
  try {
    return await fn(attempt)
  } finally {
    if (pendingInput !== 0 || pendingOutput !== 0) {
      recordUsage(chatId, pendingInput, pendingOutput)
    }
  }
}
