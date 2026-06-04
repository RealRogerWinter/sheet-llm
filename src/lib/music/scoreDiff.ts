import { getMeasureCount, getStaffCount, getVoiceCount } from './scoreAccessors'
import type { Event, Measure, Score } from './types'

/**
 * Bump this when the per-measure hash function or the retention ratio
 * computation changes. Persisted alongside each `orchestrator_turns`
 * row as `diff_algo_version`. Replay tools can then know which rows
 * are comparable without re-running the diff.
 *
 * v1 — initial: per-measure FNV1a hash over a canonical event tuple
 *               (kind, pitch step+octave+accidental, duration,
 *               articulations[], dynamic, ornament).
 * v2 — preservation-verifier fold: canonEvent additionally captures
 *      event-level `tied_to_next`, per-pitch `tied_to_next`, `tuplet`,
 *      `lyrics` (sorted by verse), `fingerings` (sorted by index),
 *      and `chord_symbol` (`chordSymbol.display` or canonical form).
 *      Catches silent LLM mutation of ties/lyrics/fingerings/chord
 *      symbols that v1 missed.
 */
export const DIFF_ALGO_VERSION = 2

export interface ScoreDiffResult {
  measureCountBefore: number
  measureCountAfter: number
  /** Sum of voice counts across every staff. */
  voiceCountBefore: number
  voiceCountAfter: number
  /**
   * Whether the top-level key changed between before and after. Null
   * when either side is undefined — the "did it change?" question is
   * meaningless without two operands, and writing `false` would
   * falsely imply the key was preserved.
   */
  keyChanged: boolean | null
  meterChanged: boolean | null
  titleChanged: boolean | null
  /**
   * Measure-identity retention ratio. For each measure index up to
   * min(beforeLen, afterLen), we compute a stable hash of the measure's
   * primary-staff/voice-0 events; the ratio is
   *   (measures whose before-hash === after-hash) / measureCountBefore
   * Null when either side is missing or beforeLen is 0. This is the
   * metric used by the future replacement-as-confirmation gate (M3.5
   * PR-4) — additive edits that append to the end leave the original
   * bars byte-identical (ratio = 1.0); replacements that rewrite the
   * piece score near zero.
   */
  retainedEventRatio: number | null
}

/**
 * Pure diff between two Scores. No I/O, no DB; safe to call inside
 * `recordTurn` regardless of context. Returns measure/voice counts,
 * top-level metadata-change booleans, and the measure-identity
 * retention ratio that drives M3.5's replacement detection.
 *
 * When `before` or `after` is undefined the counts on that side are
 * zero and `retainedEventRatio` is null. This is the normal case for
 * non-score-producing turns (converse, refuse) — recordTurn skips the
 * diff entirely then; this guard is here for defensive callers.
 */
export function scoreDiff(before: Score | undefined, after: Score | undefined): ScoreDiffResult {
  const measureCountBefore = before ? getMeasureCount(before) : 0
  const measureCountAfter = after ? getMeasureCount(after) : 0
  const voiceCountBefore = before ? sumVoiceCounts(before) : 0
  const voiceCountAfter = after ? sumVoiceCounts(after) : 0
  const bothPresent = !!before && !!after
  const keyChanged = bothPresent ? before.key !== after.key : null
  const meterChanged = bothPresent ? before.meter !== after.meter : null
  const titleChanged = bothPresent
    ? (before.title ?? null) !== (after.title ?? null)
    : null

  let retainedEventRatio: number | null = null
  if (before && after && measureCountBefore > 0) {
    const overlap = Math.min(measureCountBefore, measureCountAfter)
    let retained = 0
    for (let i = 0; i < overlap; i++) {
      const beforeMeasure = before.measures[i]
      const afterMeasure = after.measures[i]
      if (!beforeMeasure || !afterMeasure) continue
      if (hashMeasure(beforeMeasure) === hashMeasure(afterMeasure)) {
        retained++
      }
    }
    retainedEventRatio = retained / measureCountBefore
  }

  return {
    measureCountBefore,
    measureCountAfter,
    voiceCountBefore,
    voiceCountAfter,
    keyChanged,
    meterChanged,
    titleChanged,
    retainedEventRatio,
  }
}

function sumVoiceCounts(score: Score): number {
  let total = 0
  for (let s = 0; s < getStaffCount(score); s++) {
    total += getVoiceCount(score, s)
  }
  return total
}

/**
 * Canonical, JSON-free encoding of a single Event. Captures the
 * musically-meaningful fields that determine whether two events
 * represent "the same note" for retention purposes. We intentionally
 * do NOT include event ids — a re-emitted measure with new uuids but
 * identical content should still be classed as retained.
 *
 * Fields covered (DIFF_ALGO_VERSION=2):
 *   - kind, duration
 *   - per-pitch step+octave+accidental, per-pitch tied_to_next
 *   - articulations[] (order-insensitive)
 *   - dynamic, ornament, fermata
 *   - event-level tied_to_next (legacy whole-event tie)
 *   - tuplet (3/5/6/7)
 *   - lyrics (sorted by verse; verse|syllable|hyphen|extender)
 *   - fingerings (per-index; null slots encoded)
 *   - chordSymbol (display string when present, else canonical join)
 */
function canonEvent(e: Event): string {
  const parts: string[] = [e.kind ?? 'note', e.duration ?? '?']
  // PR-7 fix (PR-3 M3): a rest event may be represented either by
  // `kind: 'rest'` + an empty `pitches[]` or by `pitches: [{ step:
  // 'rest', ... }]`. Treat an empty pitches list as an explicit rest
  // marker so canonEvent collapses both representations to the same
  // canonical form for the given duration. Without this, an empty-
  // pitches event would silently round-trip as "note with no pitches"
  // and hash-match against other empty-pitches events of unrelated
  // durations, masking real diffs.
  if (e.pitches.length === 0) {
    parts.push('rest')
  }
  for (const p of e.pitches) {
    const tie = p.tied_to_next === true ? 'T' : p.tied_to_next === false ? 'F' : '-'
    parts.push(`${p.step}${p.octave}${p.accidental ?? 'none'}${tie}`)
  }
  if (e.articulations && e.articulations.length > 0) {
    parts.push(`art:${[...e.articulations].sort().join(',')}`)
  }
  if (e.dynamic) parts.push(`dyn:${e.dynamic}`)
  if (e.ornament) parts.push(`orn:${e.ornament}`)
  if (e.fermata) parts.push(`ferm:${e.fermata}`)
  if (e.tied_to_next === true) parts.push('tie:1')
  if (e.tuplet !== undefined) parts.push(`tup:${e.tuplet}`)
  if (e.lyrics && e.lyrics.length > 0) {
    const sorted = [...e.lyrics].sort((a, b) => a.verse - b.verse)
    const enc = sorted
      .map((l) => `${l.verse}|${l.syllable}|${l.hyphen ? 'h' : ''}|${l.extender ? 'e' : ''}`)
      .join(';')
    parts.push(`lyr:${enc}`)
  }
  if (e.fingerings && e.fingerings.length > 0) {
    const enc = e.fingerings
      .map((f) => (f == null ? '_' : canonFingering(f)))
      .join(';')
    parts.push(`fng:${enc}`)
  }
  if (e.chordSymbol) {
    parts.push(`chd:${canonChordSymbol(e.chordSymbol)}`)
  }
  return parts.join('|')
}

/**
 * Compact serialization of a Fingering (tagged union). Used only by
 * canonEvent — not exported. Stable across reorderings of the input
 * object's keys because the discriminator + fields are emitted in a
 * fixed order.
 */
function canonFingering(f: NonNullable<Event['fingerings']>[number]): string {
  if (f == null) return '_'
  switch (f.system) {
    case 'piano':
      return `p:${f.value}${f.substitution ? `:${f.substitution}` : ''}`
    case 'string':
      return `s:${f.finger}${f.stringRoman ? `:${f.stringRoman}` : ''}`
    case 'guitar-lh':
      return `gl:${f.value}${f.stringNum !== undefined ? `:${f.stringNum}` : ''}${f.fret ? `:${f.fret}` : ''}`
    case 'guitar-rh':
      return `gr:${f.value}`
    case 'organ':
      return `o:${f.value}${f.foot ? `:${f.foot}` : ''}${f.thumbDirection ? `:${f.thumbDirection}` : ''}`
  }
}

/**
 * Compact, stable serialization of a chord symbol. Prefers the
 * `display` field when present (already canonical); falls back to a
 * structured join over root/quality/seventh/extensions/alterations.
 */
function canonChordSymbol(c: NonNullable<Event['chordSymbol']>): string {
  if (c.display) return c.display
  const parts: string[] = [c.root, c.quality, c.seventh]
  if (c.extensions && c.extensions.length > 0) {
    parts.push(`ext:${[...c.extensions].sort((a, b) => a - b).join(',')}`)
  }
  if (c.alterations && c.alterations.length > 0) {
    parts.push(`alt:${[...c.alterations].sort().join(',')}`)
  }
  if (c.add && c.add.length > 0) {
    parts.push(`add:${[...c.add].sort((a, b) => a - b).join(',')}`)
  }
  if (c.omit && c.omit.length > 0) {
    parts.push(`omit:${[...c.omit].sort((a, b) => a - b).join(',')}`)
  }
  if (c.modal) parts.push(`mod:${c.modal}`)
  if (c.bass) {
    if (c.bass.type === 'note') parts.push(`bn:${c.bass.value}`)
    else parts.push(`bc:${canonChordSymbol(c.bass.value)}`)
  }
  return parts.join('|')
}

/**
 * Per-measure FNV1a hash over the canonical event sequence. Stable
 * across processes; no crypto dependency. The hash output is a 32-bit
 * hex string — collision rate is negligible at the scale of one
 * session's measures.
 *
 * Exported for use by the eval harness (`evals/lib/assertions.ts`)
 * so `firstNMeasuresIdentical` invariants can verify byte-identical
 * preservation of leading bars without re-implementing the canonical
 * form. Kept named after its semantic role — production callers
 * should continue to use `scoreDiff` rather than touching the hash
 * directly.
 */
export function hashMeasure(m: Measure): string {
  const canon = m.events.map(canonEvent).join('\n')
  return fnv1a(canon)
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * M24-PR-2 — compute the set of AFTER-side event ids whose content
 * differs from the BEFORE side (or which were inserted). Drives:
 *   - inline-overlay vs docked-panel choice (via length, see
 *     `computeProposalPresentation` in src/lib/chat/state.ts)
 *   - PR-3 inline overlay: highlights exactly these ids in warm-amber
 *
 * Pair-up strategy: per measure, walk events by index. Two events at
 * the same (measureIdx, eventIdx) are paired and compared via
 * canonEvent. We index-pair rather than id-pair because LLM handlers
 * may re-emit identical measures with fresh uuids (canonEvent is
 * intentionally id-free for retention purposes) — id-matching would
 * over-report on a no-op rewrite.
 *
 * Treats:
 *   - Modified event at index i → emit afterMeasure.events[i].id
 *   - Inserted event past beforeMeasure.events.length → emit its id
 *   - Inserted measure past beforeScore.measures.length → emit every
 *     event id in that measure
 *   - Deleted events → no contribution (no after-side id to highlight)
 *
 * Events without an `id` field are silently skipped (no stable handle
 * the UI can attach an overlay to). Realistic LLM-emitted scores get
 * ids assigned at the validation/round-trip boundary, so this is rare.
 */
export function computeAffectedEventIds(before: Score, after: Score): string[] {
  const affected: string[] = []
  const overlap = Math.min(before.measures.length, after.measures.length)
  for (let m = 0; m < overlap; m++) {
    const beforeMeasure = before.measures[m]
    const afterMeasure = after.measures[m]
    if (hashMeasure(beforeMeasure) === hashMeasure(afterMeasure)) continue
    const evOverlap = Math.min(beforeMeasure.events.length, afterMeasure.events.length)
    for (let e = 0; e < evOverlap; e++) {
      if (canonEvent(beforeMeasure.events[e]) !== canonEvent(afterMeasure.events[e])) {
        const id = afterMeasure.events[e].id
        if (id) affected.push(id)
      }
    }
    for (let e = evOverlap; e < afterMeasure.events.length; e++) {
      const id = afterMeasure.events[e].id
      if (id) affected.push(id)
    }
  }
  for (let m = overlap; m < after.measures.length; m++) {
    for (const ev of after.measures[m].events) {
      if (ev.id) affected.push(ev.id)
    }
  }
  return affected
}
