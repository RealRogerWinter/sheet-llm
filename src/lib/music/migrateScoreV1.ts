import { ensureEventIds } from './eventIds'
import { ensureAnnotationIds } from './annotations'
import { ensureMarkerIds } from './markers'
import {
  ensureCodaMarkerIds,
  ensureJumpMarkerIds,
  ensureSegnoMarkerIds,
  ensureSpanIds,
  ensureVoltaIds,
} from './spans'
import { ensureTechniqueIds } from './techniques'

/**
 * Current Phase 1 schema version. Bump when the schema changes in a
 * way that requires re-migration of stored scores. Migration helpers
 * read this constant to decide whether a row is up-to-date.
 */
export const CURRENT_SCORE_SCHEMA_VERSION = 1

/**
 * Result of migrating a single score from v0 to v1.
 *
 * `migrated` — the score after applying Phase 1 defaults (id
 *   backfill via ensureEventIds, and any other field-normalizations
 *   listed below).
 * `original` — the input verbatim, suitable for sidecar storage
 *   in case rollback is needed.
 * `changed` — true when the migration actually mutated something.
 *   Useful to skip an unnecessary DB write when a row is already
 *   at v1 (re-running the migration is idempotent).
 */
export type MigrateScoreV1Result = {
  migrated: unknown
  original: unknown
  changed: boolean
}

/**
 * Migrate a stored score-JSON value (raw, untyped, possibly malformed)
 * from v0 (pre-Phase-1) to v1.
 *
 * Today's migration steps:
 *  1. Backfill `id` on every event via `ensureEventIds()`. This is
 *     the foundational change PR-1 added; later span / volta / jump
 *     features reference these IDs.
 *
 * The migration is intentionally MINIMAL — every PR-2..PR-11 schema
 * change made the new fields OPTIONAL, so an un-migrated score still
 * parses. We only forcibly normalize what's load-bearing for spans
 * (the IDs). Other Phase 1 fields (kind, per-pitch ties, lyrics,
 * spans, markers, etc.) are written by new code paths but not
 * backfilled here — there's nothing to derive them FROM in legacy
 * data.
 *
 * Idempotent: running twice produces the same result. The `changed`
 * flag tracks whether the FIRST application of the migration found
 * anything to alter, so callers can avoid a no-op DB write.
 */
export function migrateScoreToV1(raw: unknown): MigrateScoreV1Result {
  // Preserve the raw input as the rollback original — clone so the
  // ensureEventIds mutation below doesn't corrupt it.
  const original = deepCloneJson(raw)

  // ensureEventIds mutates in place AND returns the input. Clone
  // first so we can detect whether mutation occurred.
  const cloned = deepCloneJson(raw)
  ensureEventIds(cloned)
  // No legacy v0 score has techniqueStates — the field was introduced
  // in M1-PR-8 (#88) — but call ensureTechniqueIds for parity with
  // ensureEventIds. Safe no-op on data without the field.
  ensureTechniqueIds(cloned)
  // Parity for annotations (M8-PR-1): legacy v0 scores can't carry
  // annotations[] either, but call ensureAnnotationIds for symmetry
  // so migrate-then-edit cycles see ids on any LLM-emitted entries
  // that arrived before migration ran.
  ensureAnnotationIds(cloned)
  // Same parity for mid-piece markers (M9-PR-1).
  ensureMarkerIds(cloned)
  // Same parity for spans (M11-PR-1). Legacy v0 scores can't carry
  // spans[] (introduced in M1-PR-5), but call ensureSpanIds for
  // symmetry so migrate-then-edit cycles see ids on any LLM-emitted
  // entries that arrived before migration ran.
  ensureSpanIds(cloned)
  // Same parity for voltas (M17-PR-1). VoltaSchema.id is REQUIRED
  // (unlike SpanIdSchema which is optional), so backfilling here
  // means an LLM-emitted volta missing an id survives the
  // post-migrate validateScore pass instead of hard-failing.
  ensureVoltaIds(cloned)
  // Same parity for jumpMarkers (M18-PR-1). JumpMarkerSchema.id is
  // REQUIRED (same as VoltaSchema.id), so backfilling here mirrors
  // the volta wiring.
  ensureJumpMarkerIds(cloned)
  // Segno + Coda landmarks (M18-PR-4). Both ids REQUIRED in the
  // schema. The wire layer (renderScoreTool.ts) also requires id +
  // the JUMP_MARKERS_REFERENCE prompt instructs the LLM to mint
  // unique 8-16 char ids, so these helpers are defensive safety
  // nets for the migrate path on rare malformed-input cases.
  ensureSegnoMarkerIds(cloned)
  ensureCodaMarkerIds(cloned)

  const changed = !jsonEqual(cloned, original)

  return { migrated: cloned, original, changed }
}

/**
 * Returns true if the given parsed-JSON score has any event without
 * an id. Useful as a quick "is this v0 or v1?" check at read time
 * without doing the full migration.
 */
export function scoreNeedsV1Migration(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false
  const score = raw as Record<string, unknown>
  if (hasUntaggedEvent(score.measures)) return true
  if (hasUntaggedEvent(extractMeasuresFromVoices(score.extraVoices))) return true
  if (score.secondStaff && typeof score.secondStaff === 'object') {
    const s2 = score.secondStaff as Record<string, unknown>
    if (hasUntaggedEvent(s2.measures)) return true
    if (hasUntaggedEvent(extractMeasuresFromVoices(s2.extraVoices))) return true
  }
  return false
}

function hasUntaggedEvent(measuresUnknown: unknown): boolean {
  if (!Array.isArray(measuresUnknown)) return false
  for (const m of measuresUnknown) {
    if (!m || typeof m !== 'object') continue
    const events = (m as Record<string, unknown>).events
    if (!Array.isArray(events)) continue
    for (const ev of events) {
      if (!ev || typeof ev !== 'object') continue
      const id = (ev as Record<string, unknown>).id
      if (typeof id !== 'string' || id.length < 8) return true
    }
  }
  return false
}

function extractMeasuresFromVoices(voicesUnknown: unknown): unknown[] {
  if (!Array.isArray(voicesUnknown)) return []
  const out: unknown[] = []
  for (const v of voicesUnknown) {
    if (!v || typeof v !== 'object') continue
    const m = (v as Record<string, unknown>).measures
    if (Array.isArray(m)) out.push(...m)
  }
  return out
}

/**
 * Reverse the v1 migration by returning the sidecar original. Used
 * when a defect in the migration is discovered and rows need to
 * revert. Returns null when no rollback is possible (the sidecar
 * was already trimmed by the janitor's retention sweep, or the
 * row was never migrated).
 */
export function rollbackScoreFromSidecar(
  sidecarJson: string | null | undefined,
): unknown | null {
  if (!sidecarJson) return null
  try {
    return JSON.parse(sidecarJson)
  } catch {
    return null
  }
}

function deepCloneJson<T>(value: T): T {
  // structuredClone is available in Node 18+ and modern browsers.
  // Fallback to JSON for any edge case.
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value)
    } catch {
      // fall through
    }
  }
  return JSON.parse(JSON.stringify(value))
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
