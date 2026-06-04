import type { SystemBlock } from './types'

/**
 * Normalize a string-or-blocks system prompt into a SystemBlock array.
 * Single strings become a single block with no cache hint (cache flag
 * is governed by the provider's `cacheControl` option for back-compat).
 */
export function toSystemBlocks(prompt: string | SystemBlock[]): SystemBlock[] {
  if (typeof prompt === 'string') return [{ text: prompt }]
  return prompt
}

/**
 * Flatten a string-or-blocks system prompt to a single concatenated
 * string with double-newline separators. Providers without per-block
 * caching (Groq, Ollama, future OpenAI-compatible adapters) use this.
 */
export function flattenSystemPrompt(prompt: string | SystemBlock[]): string {
  if (typeof prompt === 'string') return prompt
  return prompt.map((b) => b.text).join('\n\n')
}
