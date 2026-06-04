import { describe, it, expect } from 'vitest'
import {
  createAnnotation,
  createAnnotationId,
  ensureAnnotationIds,
} from '@/lib/music/annotations'
import type { Annotation, Score } from '@/lib/music/types'
import { validateScore } from '@/lib/music/validateScore'

function buildScore(annotations?: Annotation[]): Score {
  return {
    key: 'C',
    meter: '4/4',
    measures: [
      {
        events: [
          { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
        ],
      },
    ],
    ...(annotations ? { annotations } : {}),
  }
}

describe('createAnnotationId', () => {
  it('returns a 10-character string within the schema bounds (8..16)', () => {
    const id = createAnnotationId()
    expect(id.length).toBe(10)
  })

  it('returns unique ids on successive calls', () => {
    const ids = new Set(Array.from({ length: 100 }, () => createAnnotationId()))
    expect(ids.size).toBe(100)
  })
})

describe('createAnnotation', () => {
  it('mints an id and assembles a valid Annotation', () => {
    const a = createAnnotation({
      measureIdx: 0,
      position: 'above',
      text: 'Allegro',
      style: 'tempo-text',
    })
    expect(typeof a.id).toBe('string')
    expect(a.target.measureIdx).toBe(0)
    expect(a.target.position).toBe('above')
    expect(a.target.eventIdx).toBeUndefined()
    expect(a.text).toBe('Allegro')
    expect(a.style).toBe('tempo-text')
    expect(a).not.toHaveProperty('spanEnd')
  })

  it('includes eventIdx and spanEnd when provided', () => {
    const a = createAnnotation({
      measureIdx: 0,
      eventIdx: 1,
      position: 'above',
      text: 'rit.',
      style: 'expression',
      spanEnd: { measureIdx: 0, eventIdx: 3 },
    })
    expect(a.target.eventIdx).toBe(1)
    expect(a.spanEnd).toEqual({ measureIdx: 0, eventIdx: 3 })
  })

  it('passes validateScore when attached to a Score', () => {
    const a = createAnnotation({
      measureIdx: 0,
      position: 'above',
      text: 'A',
      style: 'rehearsal-mark',
    })
    expect(() => validateScore(buildScore([a]))).not.toThrow()
  })
})

describe('ensureAnnotationIds', () => {
  it('returns the same Score reference when there are no annotations', () => {
    const score = buildScore()
    expect(ensureAnnotationIds(score)).toBe(score)
  })

  it('returns the same Score reference when every annotation already has an id', () => {
    const score = buildScore([
      createAnnotation({ measureIdx: 0, position: 'above', text: 'X', style: 'plain' }),
    ])
    expect(ensureAnnotationIds(score)).toBe(score)
  })

  it('backfills missing ids in place without disturbing already-present ones', () => {
    const existing = createAnnotation({
      measureIdx: 0,
      position: 'above',
      text: 'A',
      style: 'rehearsal-mark',
    })
    const existingId = existing.id
    // Construct an annotation without an id (the LLM-emission case).
    const incoming = {
      target: { measureIdx: 0, position: 'above' as const },
      text: 'B',
      style: 'rehearsal-mark' as const,
    }
    const score = buildScore([existing, incoming as Annotation])
    const fixed = ensureAnnotationIds(score)
    // Mutate in place — same reference returned (parity with
    // ensureTechniqueIds; migrateScoreV1 relies on this so its
    // jsonEqual change-detection sees the new ids on cloned).
    expect(fixed).toBe(score)
    expect(fixed.annotations![0].id).toBe(existingId)
    expect(typeof fixed.annotations![1].id).toBe('string')
    expect(fixed.annotations![1].id!.length).toBeGreaterThanOrEqual(8)
  })

  it('backfills produce ids that survive validateScore', () => {
    const incoming = {
      target: { measureIdx: 0, position: 'above' as const },
      text: 'X',
      style: 'plain' as const,
    }
    const score = buildScore([incoming as Annotation])
    const fixed = ensureAnnotationIds(score)
    expect(() => validateScore(fixed)).not.toThrow()
  })
})
