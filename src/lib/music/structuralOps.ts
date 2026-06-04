import type {
  Annotation,
  CodaMarker,
  JumpMarker,
  Marker,
  Measure,
  Score,
  SegnoMarker,
  Span,
  TechniqueChange,
  Volta,
} from './types'
import { getStaffCount, getVoiceCount, getVoiceMeasures } from './scoreAccessors'

/**
 * Structural ops for additive/replacement edits (M3.5-PR-3).
 *
 * The three ops (appendMeasures, insertMeasuresAfter, regionReplace)
 * share the same shape — they all add/remove/replace whole measures
 * at a position — and the same set of side-effects: per-voice
 * fanout, technique-state / volta / marker / annotation / jump-marker
 * index remap, and span integrity check.
 *
 * The functions here are pure transforms; `transformScore` in
 * editOperations.ts wraps them in the Operation discriminated union.
 */

/** Per-(staff, voice) measure content. Outer key is staffIdx (0 = primary,
 *  1 = secondStaff). For each staff, the entry is a list of voices —
 *  voice 0 = primary measures, voice N = extraVoices[N-1].
 *
 *  Missing entries default to rests at meter capacity (handled by the
 *  caller — keep this struct content-shaped). */
export interface PerVoiceMeasures {
  /** Per-staff array; outer index = staffIdx. */
  staves: Array<{
    /** Per-voice measures; voices[0] = primary, voices[N] = extraVoices[N-1]. */
    voices: Measure[][]
  }>
}

/**
 * Compute new measure positions after inserting `count` measures at
 * the position immediately AFTER `afterMeasureIdx`. Indices ≤
 * afterMeasureIdx stay; indices > afterMeasureIdx shift by +count.
 */
export function remapIndexAfterInsert(
  idx: number,
  afterMeasureIdx: number,
  count: number,
): number {
  if (idx <= afterMeasureIdx) return idx
  return idx + count
}

/**
 * Compute new positions after replacing measures in
 * [startMeasureIdx..endMeasureIdx] (inclusive) with `count` new
 * measures. Indices BEFORE the range stay. Indices INSIDE the range
 * collapse to `startMeasureIdx + (count - 1)` (the last new measure;
 * for an empty replacement count=0 the marker is effectively orphaned
 * — the caller decides to drop or warn). Indices AFTER the range
 * shift by (count - (endMeasureIdx - startMeasureIdx + 1)).
 *
 * Returns null when the input idx lies inside the replaced range and
 * `count === 0` (the range was deleted with no replacement) — the
 * caller MUST drop the corresponding marker/volta entry.
 */
export function remapIndexAfterRegionReplace(
  idx: number,
  startMeasureIdx: number,
  endMeasureIdx: number,
  count: number,
): number | null {
  if (idx < startMeasureIdx) return idx
  if (idx >= startMeasureIdx && idx <= endMeasureIdx) {
    if (count === 0) return null
    // Pin orphans inside the replaced range to the LAST new measure.
    // Conservative choice; callers may prefer to drop these entries
    // explicitly via the span-severance warning path.
    return startMeasureIdx + count - 1
  }
  const replacedLen = endMeasureIdx - startMeasureIdx + 1
  return idx + (count - replacedLen)
}

/**
 * Apply an index remapper to every Score top-level structure that
 * carries a measureIdx (or startMeasureIdx/endMeasureIdx) reference.
 *
 * `remap(idx)`:
 *   - returns the new measureIdx, OR
 *   - returns null to indicate the entry should be DROPPED.
 *
 * Voltas with endpoints that map differently (e.g. start INSIDE the
 * replaced range but end OUTSIDE) keep whichever endpoints remap
 * to non-null; if both endpoints drop the volta is removed.
 *
 * Markers: drop on null. Annotations: drop on null. JumpMarkers:
 * drop on null. TechniqueStates: drop on null. (All conservative —
 * spurious marker re-emit would confuse the renderer worse than
 * a clean drop.)
 *
 * H3 — JumpMarkers ALSO get a post-pass: after segno/coda markers
 * are remapped (some may have been dropped because their target
 * measure was inside the replaced range), any jumpMarker referencing
 * a NOW-MISSING segno/coda id is dropped and a warning is recorded
 * via the optional `warnings` array. This prevents validateScore from
 * throwing `jump_ref_missing` downstream when region-replace removes
 * the Segno but keeps the D.S.
 */
export function remapScoreReferences(
  score: Score,
  remap: (idx: number) => number | null,
  warnings?: string[],
): Score {
  let next = score

  // techniqueStates: remap measureIdx; drop entries with null result.
  if (next.techniqueStates && next.techniqueStates.length > 0) {
    const out: TechniqueChange[] = []
    for (const t of next.techniqueStates) {
      const r = remap(t.measureIdx)
      if (r === null) continue
      out.push({ ...t, measureIdx: r })
    }
    if (out.length === 0) {
      const { techniqueStates: _drop, ...rest } = next
      void _drop
      next = rest
    } else {
      next = { ...next, techniqueStates: out }
    }
  }

  // voltas: remap both endpoints; keep only if BOTH remap non-null.
  if (next.voltas && next.voltas.length > 0) {
    const out: Volta[] = []
    for (const v of next.voltas) {
      const s = remap(v.startMeasureIdx)
      const e = remap(v.endMeasureIdx)
      if (s === null || e === null) continue
      out.push({ ...v, startMeasureIdx: s, endMeasureIdx: e })
    }
    if (out.length === 0) {
      const { voltas: _drop, ...rest } = next
      void _drop
      next = rest
    } else {
      next = { ...next, voltas: out }
    }
  }

  // markers: remap measureIdx.
  if (next.markers && next.markers.length > 0) {
    const out: Marker[] = []
    for (const m of next.markers) {
      const r = remap(m.measureIdx)
      if (r === null) continue
      out.push({ ...m, measureIdx: r })
    }
    if (out.length === 0) {
      const { markers: _drop, ...rest } = next
      void _drop
      next = rest
    } else {
      next = { ...next, markers: out }
    }
  }

  // jumpMarkers: remap measureIdx.
  if (next.jumpMarkers && next.jumpMarkers.length > 0) {
    const out: JumpMarker[] = []
    for (const j of next.jumpMarkers) {
      const r = remap(j.measureIdx)
      if (r === null) continue
      out.push({ ...j, measureIdx: r })
    }
    if (out.length === 0) {
      const { jumpMarkers: _drop, ...rest } = next
      void _drop
      next = rest
    } else {
      next = { ...next, jumpMarkers: out }
    }
  }

  // segnoMarkers + codaMarkers: remap measureIdx.
  if (next.segnoMarkers && next.segnoMarkers.length > 0) {
    const out = next.segnoMarkers
      .map((s) => {
        const r = remap(s.measureIdx)
        return r === null ? null : { ...s, measureIdx: r }
      })
      .filter((s): s is NonNullable<typeof s> => s !== null)
    next = out.length === 0
      ? (() => { const { segnoMarkers: _d, ...r } = next; void _d; return r })()
      : { ...next, segnoMarkers: out }
  }
  if (next.codaMarkers && next.codaMarkers.length > 0) {
    const out = next.codaMarkers
      .map((s) => {
        const r = remap(s.measureIdx)
        return r === null ? null : { ...s, measureIdx: r }
      })
      .filter((s): s is NonNullable<typeof s> => s !== null)
    next = out.length === 0
      ? (() => { const { codaMarkers: _d, ...r } = next; void _d; return r })()
      : { ...next, codaMarkers: out }
  }

  // H3 — Sweep jumpMarkers for dangling segnoRef / codaRef / toCodaRef
  // IDs. After the remap above, some segno/coda markers may have been
  // dropped (their measure landed inside a deleted range). A D.S.
  // pointing at a now-missing Segno would cause validateScore to throw
  // jump_ref_missing; drop the orphaned jumpMarker entry instead, and
  // surface a warning if the caller supplied a sink.
  if (next.jumpMarkers && next.jumpMarkers.length > 0) {
    const segnoIds = new Set((next.segnoMarkers ?? []).map((s) => s.id))
    const codaIds = new Set((next.codaMarkers ?? []).map((c) => c.id))
    const surviving: JumpMarker[] = []
    for (const j of next.jumpMarkers) {
      const missingSegno = j.segnoRef !== undefined && !segnoIds.has(j.segnoRef)
      const missingCoda = j.codaRef !== undefined && !codaIds.has(j.codaRef)
      const missingToCoda = j.toCodaRef !== undefined && !codaIds.has(j.toCodaRef)
      if (missingSegno || missingCoda || missingToCoda) {
        if (warnings) {
          const refs: string[] = []
          if (missingSegno) refs.push(`segnoRef=${j.segnoRef}`)
          if (missingCoda) refs.push(`codaRef=${j.codaRef}`)
          if (missingToCoda) refs.push(`toCodaRef=${j.toCodaRef}`)
          warnings.push(
            `JumpMarker ${j.id} (${j.kind} at measure ${j.measureIdx}) was dropped because its reference(s) no longer resolve: ${refs.join(', ')}.`,
          )
        }
        continue
      }
      surviving.push(j)
    }
    if (surviving.length === 0) {
      const { jumpMarkers: _drop, ...rest } = next
      void _drop
      next = rest as Score
    } else if (surviving.length !== next.jumpMarkers.length) {
      next = { ...next, jumpMarkers: surviving }
    }
  }

  // annotations: remap target.measureIdx (and spanEnd.measureIdx if set).
  if (next.annotations && next.annotations.length > 0) {
    const out: Annotation[] = []
    for (const a of next.annotations) {
      const tRemap = remap(a.target.measureIdx)
      if (tRemap === null) continue
      let nextAnn: Annotation = {
        ...a,
        target: { ...a.target, measureIdx: tRemap },
      }
      if (a.spanEnd) {
        const eRemap = remap(a.spanEnd.measureIdx)
        if (eRemap === null) continue
        nextAnn = { ...nextAnn, spanEnd: { ...a.spanEnd, measureIdx: eRemap } }
      }
      out.push(nextAnn)
    }
    if (out.length === 0) {
      const { annotations: _drop, ...rest } = next
      void _drop
      next = rest
    } else {
      next = { ...next, annotations: out }
    }
  }

  return next
}

// ─────────────────────────────────────────────────────────────────────
// dragMeasureRange support (M19-PR-2): extract + re-anchor for the
// move mode. The move semantic preserves score-level entries that were
// scoped to the source range (markers / jumpMarkers / segno / coda /
// voltas / annotations / techniqueStates) and re-attaches them at the
// destination. Entries STRADDLING the source-range boundary (volta or
// annotation with one endpoint inside and one outside) get dropped
// with a warning — fully-inside entries are preserved.
// ─────────────────────────────────────────────────────────────────────

/**
 * The bundle of score-level entries extracted from a measure range,
 * with positions normalized to be relative to `fromStart` so the
 * caller can re-anchor them at the destination via a single offset.
 *
 * Entries scoped to a single measure carry `relativeMeasureIdx`
 * (originalIdx - fromStart). Entries with two endpoints (voltas,
 * annotations with spanEnd) carry both `relativeStart` +
 * `relativeEnd` so they can be reconstructed at the new range.
 *
 * Annotations: only those whose target.measureIdx AND optional
 * spanEnd.measureIdx are BOTH inside [fromStart..fromEnd] are
 * extracted. Voltas: both endpoints inside. Straddlers are dropped
 * with a warning (caller passes the sink).
 */
export interface ExtractedRangeEntries {
  techniqueStates: Array<TechniqueChange & { relativeMeasureIdx: number }>
  markers: Array<Marker & { relativeMeasureIdx: number }>
  jumpMarkers: Array<JumpMarker & { relativeMeasureIdx: number }>
  segnoMarkers: Array<SegnoMarker & { relativeMeasureIdx: number }>
  codaMarkers: Array<CodaMarker & { relativeMeasureIdx: number }>
  voltas: Array<Volta & { relativeStart: number; relativeEnd: number }>
  annotations: Array<
    Annotation & { relativeMeasureIdx: number; relativeSpanEndMeasureIdx?: number }
  >
}

/**
 * Walk `score` and pull out every score-level entry whose
 * measureIdx lies in [fromStart..fromEnd] (inclusive). Mutates
 * nothing — the caller is expected to remove the originals
 * separately when re-attaching.
 *
 * For voltas + annotations: requires BOTH endpoints inside; entries
 * with one endpoint inside and one outside are reported via `warnings`
 * but NOT included in the returned bundle. The caller then drops
 * those originals (they cannot be cleanly preserved across a move).
 *
 * Pure: returns a fresh bundle each call.
 */
export function extractRangeEntries(
  score: Score,
  fromStart: number,
  fromEnd: number,
  warnings?: string[],
): ExtractedRangeEntries {
  const inRange = (i: number) => i >= fromStart && i <= fromEnd

  const techniqueStates: ExtractedRangeEntries['techniqueStates'] = []
  for (const t of score.techniqueStates ?? []) {
    if (inRange(t.measureIdx)) {
      techniqueStates.push({ ...t, relativeMeasureIdx: t.measureIdx - fromStart })
    }
  }

  const markers: ExtractedRangeEntries['markers'] = []
  for (const m of score.markers ?? []) {
    if (inRange(m.measureIdx)) {
      markers.push({ ...m, relativeMeasureIdx: m.measureIdx - fromStart })
    }
  }

  const jumpMarkers: ExtractedRangeEntries['jumpMarkers'] = []
  for (const j of score.jumpMarkers ?? []) {
    if (inRange(j.measureIdx)) {
      jumpMarkers.push({ ...j, relativeMeasureIdx: j.measureIdx - fromStart })
    }
  }

  const segnoMarkers: ExtractedRangeEntries['segnoMarkers'] = []
  for (const s of score.segnoMarkers ?? []) {
    if (inRange(s.measureIdx)) {
      segnoMarkers.push({ ...s, relativeMeasureIdx: s.measureIdx - fromStart })
    }
  }

  const codaMarkers: ExtractedRangeEntries['codaMarkers'] = []
  for (const c of score.codaMarkers ?? []) {
    if (inRange(c.measureIdx)) {
      codaMarkers.push({ ...c, relativeMeasureIdx: c.measureIdx - fromStart })
    }
  }

  // Voltas — both endpoints must lie inside. Straddlers warn + drop.
  const voltas: ExtractedRangeEntries['voltas'] = []
  for (const v of score.voltas ?? []) {
    const startIn = inRange(v.startMeasureIdx)
    const endIn = inRange(v.endMeasureIdx)
    if (startIn && endIn) {
      voltas.push({
        ...v,
        relativeStart: v.startMeasureIdx - fromStart,
        relativeEnd: v.endMeasureIdx - fromStart,
      })
    } else if (startIn !== endIn) {
      // Straddler — neither extracted nor preserved-as-is. The caller
      // drops it from the surviving score; record a warning.
      if (warnings) {
        warnings.push(
          `Volta ${v.id} (measures ${v.startMeasureIdx}..${v.endMeasureIdx}) was dropped because the moved range [${fromStart}..${fromEnd}] split its endpoints.`,
        )
      }
    }
  }

  // Annotations — target.measureIdx required-in-range; spanEnd
  // (optional) also required-in-range when present. Mixed → warn + drop.
  const annotations: ExtractedRangeEntries['annotations'] = []
  for (const a of score.annotations ?? []) {
    const targetIn = inRange(a.target.measureIdx)
    if (a.spanEnd === undefined) {
      if (targetIn) {
        annotations.push({
          ...a,
          relativeMeasureIdx: a.target.measureIdx - fromStart,
        })
      }
      continue
    }
    const spanEndIn = inRange(a.spanEnd.measureIdx)
    if (targetIn && spanEndIn) {
      annotations.push({
        ...a,
        relativeMeasureIdx: a.target.measureIdx - fromStart,
        relativeSpanEndMeasureIdx: a.spanEnd.measureIdx - fromStart,
      })
    } else if (targetIn !== spanEndIn) {
      if (warnings) {
        warnings.push(
          `Annotation${a.id ? ` ${a.id}` : ''} (measure ${a.target.measureIdx}${a.spanEnd ? ` → ${a.spanEnd.measureIdx}` : ''}) was dropped because the moved range [${fromStart}..${fromEnd}] split its endpoints.`,
        )
      }
    }
  }

  return {
    techniqueStates,
    markers,
    jumpMarkers,
    segnoMarkers,
    codaMarkers,
    voltas,
    annotations,
  }
}

/**
 * Strip ALL score-level entries that lie in [fromStart..fromEnd] from
 * `score`. Used by the move path: after extracting the entries we
 * want to re-attach, we strip the originals so the subsequent
 * regionReplace-empty pass doesn't see them (its remap would drop
 * them anyway, but stripping first keeps the warning channel clean).
 *
 * Voltas + annotations with mixed endpoints are also dropped here
 * (they were warned about during extract).
 */
export function stripRangeEntries(
  score: Score,
  fromStart: number,
  fromEnd: number,
): Score {
  const inRange = (i: number) => i >= fromStart && i <= fromEnd
  const outRange = (i: number) => !inRange(i)
  let next = score

  if (next.techniqueStates) {
    const filtered = next.techniqueStates.filter((t) => outRange(t.measureIdx))
    next =
      filtered.length === 0
        ? (() => {
            const { techniqueStates: _d, ...r } = next
            void _d
            return r
          })()
        : { ...next, techniqueStates: filtered }
  }
  if (next.markers) {
    const filtered = next.markers.filter((m) => outRange(m.measureIdx))
    next =
      filtered.length === 0
        ? (() => {
            const { markers: _d, ...r } = next
            void _d
            return r
          })()
        : { ...next, markers: filtered }
  }
  if (next.jumpMarkers) {
    const filtered = next.jumpMarkers.filter((j) => outRange(j.measureIdx))
    next =
      filtered.length === 0
        ? (() => {
            const { jumpMarkers: _d, ...r } = next
            void _d
            return r
          })()
        : { ...next, jumpMarkers: filtered }
  }
  if (next.segnoMarkers) {
    const filtered = next.segnoMarkers.filter((s) => outRange(s.measureIdx))
    next =
      filtered.length === 0
        ? (() => {
            const { segnoMarkers: _d, ...r } = next
            void _d
            return r
          })()
        : { ...next, segnoMarkers: filtered }
  }
  if (next.codaMarkers) {
    const filtered = next.codaMarkers.filter((c) => outRange(c.measureIdx))
    next =
      filtered.length === 0
        ? (() => {
            const { codaMarkers: _d, ...r } = next
            void _d
            return r
          })()
        : { ...next, codaMarkers: filtered }
  }
  if (next.voltas) {
    // Drop voltas with EITHER endpoint inside (fully-inside +
    // straddlers both leave; straddlers were already warned about
    // upstream in extractRangeEntries).
    const filtered = next.voltas.filter(
      (v) => outRange(v.startMeasureIdx) && outRange(v.endMeasureIdx),
    )
    next =
      filtered.length === 0
        ? (() => {
            const { voltas: _d, ...r } = next
            void _d
            return r
          })()
        : { ...next, voltas: filtered }
  }
  if (next.annotations) {
    const filtered = next.annotations.filter((a) => {
      const targetOut = outRange(a.target.measureIdx)
      if (a.spanEnd === undefined) return targetOut
      const spanOut = outRange(a.spanEnd.measureIdx)
      return targetOut && spanOut
    })
    next =
      filtered.length === 0
        ? (() => {
            const { annotations: _d, ...r } = next
            void _d
            return r
          })()
        : { ...next, annotations: filtered }
  }
  return next
}

/**
 * Re-attach a previously-extracted bundle of score-level entries to
 * `score` at a new range that begins at `destinationStart` (the
 * 0-indexed measureIdx of the first re-anchored measure in the
 * destination layout). Pure transform.
 *
 * For each entry we add `destinationStart` to its relative position(s).
 * Existing arrays on `score` are extended (not replaced) — the caller
 * should have already stripped the originals via `stripRangeEntries`.
 */
export function reattachExtractedEntries(
  score: Score,
  extracted: ExtractedRangeEntries,
  destinationStart: number,
): Score {
  let next = score

  if (extracted.techniqueStates.length > 0) {
    const reattached = extracted.techniqueStates.map(
      ({ relativeMeasureIdx, ...t }) => ({
        ...t,
        measureIdx: destinationStart + relativeMeasureIdx,
      }),
    )
    next = {
      ...next,
      techniqueStates: [...(next.techniqueStates ?? []), ...reattached],
    }
  }
  if (extracted.markers.length > 0) {
    const reattached = extracted.markers.map(({ relativeMeasureIdx, ...m }) => ({
      ...m,
      measureIdx: destinationStart + relativeMeasureIdx,
    }))
    next = { ...next, markers: [...(next.markers ?? []), ...reattached] }
  }
  if (extracted.jumpMarkers.length > 0) {
    const reattached = extracted.jumpMarkers.map(
      ({ relativeMeasureIdx, ...j }) => ({
        ...j,
        measureIdx: destinationStart + relativeMeasureIdx,
      }),
    )
    next = {
      ...next,
      jumpMarkers: [...(next.jumpMarkers ?? []), ...reattached],
    }
  }
  if (extracted.segnoMarkers.length > 0) {
    const reattached = extracted.segnoMarkers.map(
      ({ relativeMeasureIdx, ...s }) => ({
        ...s,
        measureIdx: destinationStart + relativeMeasureIdx,
      }),
    )
    next = {
      ...next,
      segnoMarkers: [...(next.segnoMarkers ?? []), ...reattached],
    }
  }
  if (extracted.codaMarkers.length > 0) {
    const reattached = extracted.codaMarkers.map(
      ({ relativeMeasureIdx, ...c }) => ({
        ...c,
        measureIdx: destinationStart + relativeMeasureIdx,
      }),
    )
    next = { ...next, codaMarkers: [...(next.codaMarkers ?? []), ...reattached] }
  }
  if (extracted.voltas.length > 0) {
    const reattached = extracted.voltas.map(
      ({ relativeStart, relativeEnd, ...v }) => ({
        ...v,
        startMeasureIdx: destinationStart + relativeStart,
        endMeasureIdx: destinationStart + relativeEnd,
      }),
    )
    next = { ...next, voltas: [...(next.voltas ?? []), ...reattached] }
  }
  if (extracted.annotations.length > 0) {
    const reattached = extracted.annotations.map((a) => {
      const { relativeMeasureIdx, relativeSpanEndMeasureIdx, ...rest } = a
      const nextAnn: Annotation = {
        ...rest,
        target: {
          ...rest.target,
          measureIdx: destinationStart + relativeMeasureIdx,
        },
      }
      if (relativeSpanEndMeasureIdx !== undefined && nextAnn.spanEnd) {
        nextAnn.spanEnd = {
          ...nextAnn.spanEnd,
          measureIdx: destinationStart + relativeSpanEndMeasureIdx,
        }
      }
      return nextAnn
    })
    next = {
      ...next,
      annotations: [...(next.annotations ?? []), ...reattached],
    }
  }
  return next
}

/**
 * Span integrity check for region-replace: a span is "severed" if
 * its start OR end event lives at a measureIdx INSIDE the replaced
 * range, while the OTHER endpoint lives outside the range.
 *
 * Returns the list of span ids that would be severed by replacing
 * measures [startMeasureIdx..endMeasureIdx]. The caller emits a
 * warning per id — the spans themselves are kept (the LLM may re-
 * emit them in the new region) but the user is warned that the
 * renderer may not draw them coherently.
 */
export function detectSeveredSpans(
  score: Score,
  startMeasureIdx: number,
  endMeasureIdx: number,
): string[] {
  if (!score.spans || score.spans.length === 0) return []

  // Build event-id → measureIdx map across all (staff, voice) lines.
  const eventToMeasure = new Map<string, number>()
  for (let s = 0; s < getStaffCount(score); s++) {
    for (let v = 0; v < getVoiceCount(score, s); v++) {
      const measures = getVoiceMeasures(score, s, v)
      measures.forEach((m, mi) => {
        m.events.forEach((ev) => {
          if (ev.id) eventToMeasure.set(ev.id, mi)
        })
      })
    }
  }

  const severed: string[] = []
  for (const span of score.spans) {
    const startMi = eventToMeasure.get(span.startEventId)
    const endMi = eventToMeasure.get(span.endEventId)
    if (startMi === undefined || endMi === undefined) continue
    const startInside = startMi >= startMeasureIdx && startMi <= endMeasureIdx
    const endInside = endMi >= startMeasureIdx && endMi <= endMeasureIdx
    if (startInside !== endInside) {
      // Span.id is optional during M11-PR-1 rollout; in practice the
      // span passed through ensureSpanIds before reaching here, but
      // skip defensively for unminted ones (caller can't address an
      // unnamed span in a warning anyway).
      if (span.id !== undefined) severed.push(span.id)
    }
  }
  return severed
}

/**
 * Build a Span[] with severed-span ids removed. Spans that are FULLY
 * inside the replaced range are also dropped — they referenced events
 * that no longer exist. Spans fully outside the range are kept verbatim.
 */
export function dropSeveredAndInteriorSpans(
  score: Score,
  startMeasureIdx: number,
  endMeasureIdx: number,
): Span[] | undefined {
  if (!score.spans || score.spans.length === 0) return score.spans

  const eventToMeasure = new Map<string, number>()
  for (let s = 0; s < getStaffCount(score); s++) {
    for (let v = 0; v < getVoiceCount(score, s); v++) {
      const measures = getVoiceMeasures(score, s, v)
      measures.forEach((m, mi) => {
        m.events.forEach((ev) => {
          if (ev.id) eventToMeasure.set(ev.id, mi)
        })
      })
    }
  }

  const out: Span[] = []
  for (const span of score.spans) {
    const startMi = eventToMeasure.get(span.startEventId)
    const endMi = eventToMeasure.get(span.endEventId)
    if (startMi === undefined || endMi === undefined) {
      // Orphan span (pre-existing data integrity issue); drop.
      continue
    }
    const startInside = startMi >= startMeasureIdx && startMi <= endMeasureIdx
    const endInside = endMi >= startMeasureIdx && endMi <= endMeasureIdx
    if (startInside && endInside) continue // fully inside → drop
    if (startInside !== endInside) continue // severed → drop (caller warns)
    out.push(span)
  }
  return out
}
