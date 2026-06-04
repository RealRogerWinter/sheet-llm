import type { LLMClient } from './wrapper'
import { stubClient } from './stubClient'
import { realClient } from './client'

/**
 * Choose the LLM client based on environment.
 *
 * - If ANTHROPIC_API_KEY is set, use the real Anthropic-backed client.
 * - Otherwise fall back to the in-memory stub (used in CI without a
 *   key and as a quick local-dev default).
 *
 * Function-based selection so tests can override the env between
 * cases. Realistically the env doesn't change per request in prod,
 * so the cost is negligible.
 */
export function getLLMClient(): LLMClient {
  if (process.env.ANTHROPIC_API_KEY) {
    return realClient
  }
  return stubClient
}
