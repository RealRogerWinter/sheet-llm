import { createHash } from 'node:crypto'
import type { Score } from '@/lib/music/types'

/**
 * Stable canonical-JSON hash of a Score. Used as an optional
 * `score_version` field in chat requests so the server can detect
 * stale editedScore submissions (e.g. UI race with an in-flight
 * orchestrator edit).
 *
 * Canonicalization: keys are sorted recursively so cosmetic key
 * reordering on the wire does not invalidate the hash. We use
 * SHA-256 truncated to 32 hex chars (128 bits) — collision-resistant
 * for this use case, short enough to ship in request bodies.
 */
export function scoreHash(score: Score): string {
  const canonical = JSON.stringify(score, sortReplacer())
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32)
}

function sortReplacer() {
  return (_key: string, value: unknown) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const sortedKeys = Object.keys(value as Record<string, unknown>).sort()
      const out: Record<string, unknown> = {}
      for (const k of sortedKeys) {
        out[k] = (value as Record<string, unknown>)[k]
      }
      return out
    }
    return value
  }
}
