import type { Score } from './types'
import { scoreToAbcWithMap } from './scoreToAbcWithMap'

/**
 * Transpile a Score to ABC notation. Thin wrapper around
 * scoreToAbcWithMap that discards the source map for callers that
 * only need the ABC string.
 */
export function scoreToAbc(score: Score): string {
  return scoreToAbcWithMap(score).abc
}
