import { describe, it, expect } from 'vitest'
import {
  applyOperation,
  captureRangeContent,
  cloneCapturedRangeWithFreshIdsMapped,
  remapSpansToFreshIds,
  spansFullyInsideRange,
} from '@/lib/music/editOperations'
import { copyMeasureRange, pasteMeasuresInsertOp, pasteMeasuresReplaceOp } from '@/lib/chat/clipboard'
import type { Score, Span } from '@/lib/music/types'

// validateScore requires ids of >=8 chars, so use padded deterministic ids.
const eid = (n: number) => `event${String(n).padStart(3, '0')}` // 'event001'
const ev = (n: number, step: string) => ({ id: eid(n), pitches: [{ step, octave: 4 }], duration: 'quarter' })
const span = (id: string, startEventId: string, endEventId: string): Span =>
  ({ id, kind: 'slur', startEventId, endEventId, staffIdx: 0, voiceIdx: 0 }) as Span

const S_ID = 'spanaaa1'

/** Two full 4/4 bars; a slur span S lives entirely inside m0 (e1 → e3). */
function scoreWithSpan(): Score {
  return {
    key: 'C',
    meter: '4/4',
    measures: [
      { events: [ev(1, 'C'), ev(2, 'D'), ev(3, 'E'), ev(4, 'F')] },
      { events: [ev(5, 'G'), ev(6, 'A'), ev(7, 'B'), ev(8, 'C')] },
    ],
    spans: [span(S_ID, eid(1), eid(3))],
  } as unknown as Score
}

describe('spansFullyInsideRange (D4)', () => {
  it('returns spans with both endpoints inside the range', () => {
    expect(spansFullyInsideRange(scoreWithSpan(), 0, 0).map((s) => s.id)).toEqual([S_ID])
  })

  it('excludes a span entirely outside the range', () => {
    expect(spansFullyInsideRange(scoreWithSpan(), 1, 1)).toHaveLength(0)
  })

  it('excludes a span straddling the range boundary (one endpoint outside)', () => {
    const score = scoreWithSpan()
    score.spans!.push(span('spanaaa2', eid(3), eid(5))) // e3 in m0, e5 in m1
    // [0,1] covers both → both inside; [0,0] → only S (e5 is outside).
    expect(spansFullyInsideRange(score, 0, 1).map((s) => s.id).sort()).toEqual([S_ID, 'spanaaa2'])
    expect(spansFullyInsideRange(score, 0, 0).map((s) => s.id)).toEqual([S_ID])
  })

  it('returns [] when the score has no spans', () => {
    const { spans: _drop, ...noSpans } = scoreWithSpan()
    void _drop
    expect(spansFullyInsideRange(noSpans as Score, 0, 0)).toEqual([])
  })
})

describe('remapSpansToFreshIds (D4)', () => {
  it('remaps both endpoints and mints a fresh span id, keeping other fields', () => {
    const idMap = new Map([
      [eid(1), 'freshid01'],
      [eid(3), 'freshid03'],
    ])
    const [out] = remapSpansToFreshIds([span(S_ID, eid(1), eid(3))], idMap)
    expect(out.startEventId).toBe('freshid01')
    expect(out.endEventId).toBe('freshid03')
    expect(out.id).not.toBe(S_ID)
    expect(out.kind).toBe('slur')
  })

  it('drops a span whose endpoint is missing from the map', () => {
    const idMap = new Map([[eid(1), 'freshid01']]) // eid(3) absent
    expect(remapSpansToFreshIds([span(S_ID, eid(1), eid(3))], idMap)).toEqual([])
  })
})

describe('cloneCapturedRangeWithFreshIdsMapped (D4)', () => {
  it('mints fresh ids, records old→new, and preserves the primary-v0 shared ref', () => {
    const captured = captureRangeContent(scoreWithSpan(), 0, 0)
    const { primaryMeasures, perVoiceContent, idMap } = cloneCapturedRangeWithFreshIdsMapped(captured)
    expect(primaryMeasures).toBe(perVoiceContent[0].voices[0]) // shared ref
    expect(idMap.get(eid(1))).toBeDefined()
    expect(idMap.get(eid(1))).not.toBe(eid(1))
    // The mapped fresh id is exactly what landed in the cloned measure.
    expect(primaryMeasures[0].events[0].id).toBe(idMap.get(eid(1)))
  })
})

describe('measure copy/paste carries spans end-to-end (D4)', () => {
  it('insert-paste carries the interior span onto the fresh copies', () => {
    const score = scoreWithSpan()
    const entry = copyMeasureRange(score, { fromStart: 0, fromEnd: 0 })
    if (entry.kind !== 'measures') throw new Error('expected measures')
    expect(entry.captured.spans).toHaveLength(1) // S captured

    const op = pasteMeasuresInsertOp(entry.captured, 1) // insert after m1 → new bar at idx 2
    const next = applyOperation(score, op)

    expect(next.measures).toHaveLength(3)
    expect(next.spans).toHaveLength(2) // original + carried copy
    const original = next.spans!.find((s) => s.id === S_ID)!
    const carried = next.spans!.find((s) => s.id !== S_ID)!
    // Carried span points at fresh ids that live in the inserted bar.
    expect(carried.startEventId).not.toBe(eid(1))
    expect(carried.endEventId).not.toBe(eid(3))
    const insertedIds = new Set(next.measures[2].events.map((e) => e.id))
    expect(insertedIds.has(carried.startEventId)).toBe(true)
    expect(insertedIds.has(carried.endEventId)).toBe(true)
    // Original span still resolves to m0.
    expect(original.startEventId).toBe(eid(1))
  })

  it('region-replace-paste carries the span onto the replacement bar', () => {
    const score = scoreWithSpan()
    const entry = copyMeasureRange(score, { fromStart: 0, fromEnd: 0 })
    if (entry.kind !== 'measures') throw new Error('expected measures')

    const op = pasteMeasuresReplaceOp(entry.captured, 1, 1) // overwrite m1 with a copy of m0
    const next = applyOperation(score, op)

    expect(next.measures).toHaveLength(2)
    expect(next.spans).toHaveLength(2)
    const carried = next.spans!.find((s) => s.id !== S_ID)!
    const replIds = new Set(next.measures[1].events.map((e) => e.id))
    expect(replIds.has(carried.startEventId)).toBe(true)
    expect(replIds.has(carried.endEventId)).toBe(true)
  })

  it('a measure copy with no interior spans omits the spans field', () => {
    const { spans: _drop, ...noSpans } = scoreWithSpan()
    void _drop
    const entry = copyMeasureRange(noSpans as Score, { fromStart: 0, fromEnd: 0 })
    if (entry.kind !== 'measures') throw new Error('expected measures')
    expect(entry.captured.spans).toBeUndefined()
  })
})
