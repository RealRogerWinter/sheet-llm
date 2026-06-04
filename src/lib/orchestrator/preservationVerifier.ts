import type { Score } from '@/lib/music/types'
import { hashMeasure } from '@/lib/music/scoreDiff'

/**
 * Server-side hash verification of "preserved" measure claims
 * (M3.5-PR-3 red-team fold #2).
 *
 * The contract: any handler that takes a `claimedRetainedMeasureIdxs`
 * list from the LLM (or implies one by construction — e.g.
 * `extend_composition` implicitly claims all original measures are
 * retained) MUST verify that each claimed-retained measure hashes
 * identically before and after the op is applied. Trust nothing the
 * LLM self-reports.
 *
 * `hashMeasure` lives in scoreDiff.ts and computes a canonical
 * FNV1a hash over (kind, duration, per-pitch step+octave+accidental,
 * articulations, dynamic, ornament, fermata) — the musically-meaning
 * fields. Re-emitted measures with new event uuids but identical
 * content still hash the same; cosmetic re-orderings (e.g. articulation
 * ordering) are normalized inside `canonEvent` so they don't trigger
 * spurious mismatches.
 */
export interface PreservationVerifyResult {
  ok: boolean
  /** Indices that the LLM (or by-construction) claimed retained but
   *  whose before/after hashes diverge. Empty when ok=true. */
  mismatches: number[]
}

/**
 * Compare per-measure hashes at every claimed-retained index. Out-of-
 * range indices (negative or >= measure count on either side) are
 * counted as mismatches — they're impossible to verify and treating
 * them as silent passes would defeat the point.
 */
export function verifyPreservation(
  beforeScore: Score,
  afterScore: Score,
  claimedRetainedMeasureIdxs: ReadonlyArray<number>,
): PreservationVerifyResult {
  const mismatches: number[] = []
  for (const idx of claimedRetainedMeasureIdxs) {
    if (idx < 0 || idx >= beforeScore.measures.length || idx >= afterScore.measures.length) {
      mismatches.push(idx)
      continue
    }
    const beforeHash = hashMeasure(beforeScore.measures[idx])
    const afterHash = hashMeasure(afterScore.measures[idx])
    if (beforeHash !== afterHash) {
      mismatches.push(idx)
    }
  }
  return { ok: mismatches.length === 0, mismatches }
}

/**
 * Convenience: verify that ALL measures from index 0..(beforeLen-1)
 * are preserved. Used by `extend_composition` where the op only
 * emits new tail bars — every existing bar must be untouched.
 */
export function verifyAllOriginalsPreserved(
  beforeScore: Score,
  afterScore: Score,
): PreservationVerifyResult {
  const idxs = Array.from({ length: beforeScore.measures.length }, (_, i) => i)
  return verifyPreservation(beforeScore, afterScore, idxs)
}
