import { describe, it, expect } from 'vitest'
import {
  activeKeyAt,
  activeMeterAt,
  activeTempoAt,
  annotationsForMeasure,
  createAnnotation,
  createCoda,
  createJump,
  createMarker,
  createSegno,
  createSpan,
  createSpanId,
  createVolta,
  ensureSpanIds,
  HAIRPIN_KINDS,
  isHairpin,
  JUMP_KINDS,
  spansTouchingEvent,
  voltaForMeasureOnPass,
} from '@/lib/music/spans'
import {
  AnnotationSchema,
  CodaMarkerSchema,
  JumpKindSchema,
  JumpMarkerSchema,
  MarkerSchema,
  ScoreSchema,
  SegnoMarkerSchema,
  SpanSchema,
  VoltaSchema,
  type Score,
  type Span,
} from '@/lib/music/types'
import { validateScore } from '@/lib/music/validateScore'

const baseScore = (): Score => ({
  key: 'C',
  meter: '4/4',
  measures: [
    {
      events: [
        { id: 'evtestid01', pitches: [{ step: 'C', octave: 4 }], duration: 'whole' },
      ],
    },
  ],
})

describe('createSpanId', () => {
  it('returns a 10-char id', () => {
    expect(createSpanId()).toHaveLength(10)
  })
  it('returns unique ids', () => {
    const set = new Set<string>()
    for (let i = 0; i < 200; i++) set.add(createSpanId())
    expect(set.size).toBe(200)
  })
})

describe('createSpan / SpanSchema', () => {
  it('builds a minimal slur', () => {
    const s = createSpan('slur', 'evstart_aa', 'evend_bbbb')
    expect(s.kind).toBe('slur')
    expect(s.startEventId).toBe('evstart_aa')
    expect(s.endEventId).toBe('evend_bbbb')
    expect(s.staffIdx).toBe(0)
    expect(s.voiceIdx).toBe(0)
    expect(() => SpanSchema.parse(s)).not.toThrow()
  })

  it('supports hairpin terminal dynamics', () => {
    const s = createSpan('hairpin-cresc', 'a_idtest1', 'b_idtest2', {
      startDynamic: 'p',
      endDynamic: 'f',
    })
    expect(s.startDynamic).toBe('p')
    expect(s.endDynamic).toBe('f')
    expect(() => SpanSchema.parse(s)).not.toThrow()
  })

  it('supports glissando style + text', () => {
    const s = createSpan('glissando', 'a_idtest1', 'b_idtest2', {
      glissStyle: 'wavy',
      glissText: true,
    })
    expect(s.glissStyle).toBe('wavy')
    expect(s.glissText).toBe(true)
    expect(() => SpanSchema.parse(s)).not.toThrow()
  })

  it('rejects voiceIdx > 3', () => {
    expect(() =>
      SpanSchema.parse({ ...createSpan('slur', 'aaaaaaaa', 'bbbbbbbb'), voiceIdx: 4 }),
    ).toThrow()
  })

  it('accepts the pedal span kind', () => {
    const s = createSpan('pedal', 'aaaaaaaa', 'bbbbbbbb')
    expect(s.kind).toBe('pedal')
    expect(() => SpanSchema.parse(s)).not.toThrow()
  })

  it('preserves glissText:false (regression guard on conditional spread)', () => {
    const s = createSpan('glissando', 'aaaaaaaa', 'bbbbbbbb', { glissText: false })
    expect(s.glissText).toBe(false)
  })
})

describe('spansTouchingEvent', () => {
  it('returns spans where start or end matches the eventId', () => {
    const sc = baseScore()
    sc.spans = [
      createSpan('slur', 'evtestid01', 'evtestid02'),
      createSpan('hairpin-cresc', 'evtestid02', 'evtestid03'),
      createSpan('slur', 'evtestid04', 'evtestid05'),
    ]
    const touching = spansTouchingEvent(sc, 'evtestid02')
    expect(touching).toHaveLength(2)
  })

  it('returns [] when no spans defined', () => {
    expect(spansTouchingEvent(baseScore(), 'evtestid01')).toEqual([])
  })
})

describe('MarkerSchema + active{Key,Meter,Tempo}At', () => {
  it('activeKeyAt returns score.key when no markers', () => {
    expect(activeKeyAt(baseScore(), 0)).toBe('C')
  })

  it('activeKeyAt returns the marker key at or before the index', () => {
    const sc = baseScore()
    sc.markers = [createMarker(2, { key: 'G' }), createMarker(5, { key: 'D' })]
    expect(activeKeyAt(sc, 0)).toBe('C')
    expect(activeKeyAt(sc, 1)).toBe('C')
    expect(activeKeyAt(sc, 2)).toBe('G')
    expect(activeKeyAt(sc, 4)).toBe('G')
    expect(activeKeyAt(sc, 5)).toBe('D')
    expect(activeKeyAt(sc, 99)).toBe('D')
  })

  it('activeKeyAt handles unsorted markers', () => {
    const sc = baseScore()
    sc.markers = [createMarker(5, { key: 'D' }), createMarker(2, { key: 'G' })]
    expect(activeKeyAt(sc, 3)).toBe('G')
    expect(activeKeyAt(sc, 5)).toBe('D')
  })

  it('activeMeterAt falls back to score.meter', () => {
    expect(activeMeterAt(baseScore(), 0)).toBe('4/4')
  })

  it('activeMeterAt respects mid-piece meter changes', () => {
    const sc = baseScore()
    sc.markers = [createMarker(4, { meter: '5/8' })]
    expect(activeMeterAt(sc, 3)).toBe('4/4')
    expect(activeMeterAt(sc, 4)).toBe('5/8')
  })

  it('activeTempoAt returns undefined when no tempo set anywhere', () => {
    expect(activeTempoAt(baseScore(), 0)).toBeUndefined()
  })

  it('activeTempoAt respects mid-piece tempo changes', () => {
    const sc = baseScore()
    sc.tempo_bpm = 120
    sc.markers = [createMarker(2, { tempo_bpm: 80 })]
    expect(activeTempoAt(sc, 0)).toBe(120)
    expect(activeTempoAt(sc, 2)).toBe(80)
  })

  it('MarkerSchema accepts clef changes per staff', () => {
    const m = createMarker(5, {
      clefs: [{ staffIdx: 0, clef: 'bass' }],
    })
    expect(() => MarkerSchema.parse(m)).not.toThrow()
  })

  it('MarkerSchema rejects a no-op marker (only measureIdx, no field changes)', () => {
    expect(() => MarkerSchema.parse({ measureIdx: 5 })).toThrow()
  })

  it('activeKeyAt: when two markers share a measureIdx, the LAST in array order wins (tie-break)', () => {
    const sc = baseScore()
    sc.markers = [createMarker(3, { key: 'G' }), createMarker(3, { key: 'D' })]
    expect(activeKeyAt(sc, 3)).toBe('D')
  })
})

describe('Volta + voltaForMeasureOnPass', () => {
  it('createVolta builds a valid volta', () => {
    const v = createVolta(7, 8, [1])
    expect(v.endings).toEqual([1])
    expect(() => VoltaSchema.parse(v)).not.toThrow()
  })

  it('rejects empty endings array', () => {
    expect(() => VoltaSchema.parse({ ...createVolta(7, 8, [1]), endings: [] })).toThrow()
  })

  it('voltaForMeasureOnPass returns the matching volta', () => {
    const sc = baseScore()
    sc.voltas = [createVolta(7, 8, [1]), createVolta(9, 10, [2])]
    expect(voltaForMeasureOnPass(sc, 7, 1)).toBeDefined()
    expect(voltaForMeasureOnPass(sc, 8, 1)).toBeDefined()
    expect(voltaForMeasureOnPass(sc, 8, 2)).toBeUndefined()
    expect(voltaForMeasureOnPass(sc, 9, 2)).toBeDefined()
  })

  it('voltaForMeasureOnPass returns undefined outside volta range', () => {
    const sc = baseScore()
    sc.voltas = [createVolta(7, 8, [1])]
    expect(voltaForMeasureOnPass(sc, 6, 1)).toBeUndefined()
    expect(voltaForMeasureOnPass(sc, 9, 1)).toBeUndefined()
  })

  it('multi-pass volta (endings=[1,2]) matches both pass numbers', () => {
    // A "first and second time" bracket spanning a passage that's
    // played twice with the same ending.
    const sc = baseScore()
    const v = createVolta(7, 8, [1, 2])
    sc.voltas = [v]
    expect(voltaForMeasureOnPass(sc, 7, 1)?.id).toBe(v.id)
    expect(voltaForMeasureOnPass(sc, 7, 2)?.id).toBe(v.id)
    expect(voltaForMeasureOnPass(sc, 7, 3)).toBeUndefined()
  })
})

describe('JumpMarker / Segno / Coda', () => {
  it('createSegno / createCoda produce valid markers', () => {
    expect(() => SegnoMarkerSchema.parse(createSegno(0))).not.toThrow()
    expect(() => CodaMarkerSchema.parse(createCoda(5))).not.toThrow()
  })

  it('createJump with ref ids passes schema', () => {
    const segno = createSegno(0)
    const coda = createCoda(20)
    const j = createJump('D.S. al Coda', 15, 'end', {
      segnoRef: segno.id,
      codaRef: coda.id,
      toCodaRef: 'tcoda_abc1',
    })
    expect(() => JumpMarkerSchema.parse(j)).not.toThrow()
    expect(j.segnoRef).toBe(segno.id)
    expect(j.codaRef).toBe(coda.id)
  })

  it('JumpKindSchema rejects unknown jump kinds', () => {
    expect(() =>
      JumpMarkerSchema.parse({
        id: 'invalid_jp',
        measureIdx: 0,
        side: 'end',
        kind: 'D.X. al Random',
      }),
    ).toThrow()
  })
})

describe('Annotation + helpers', () => {
  it('createAnnotation builds a rehearsal mark', () => {
    const a = createAnnotation(8, 'A', 'rehearsal-mark')
    expect(a.target.position).toBe('above')
    expect(a.style).toBe('rehearsal-mark')
    expect(() => AnnotationSchema.parse(a)).not.toThrow()
  })

  it('createAnnotation with spanEnd builds a rit. ____ extension', () => {
    const a = createAnnotation(5, 'rit.', 'expression', {
      spanEnd: { measureIdx: 8 },
    })
    expect(a.spanEnd?.measureIdx).toBe(8)
    expect(() => AnnotationSchema.parse(a)).not.toThrow()
  })

  it('annotationsForMeasure filters by measureIdx', () => {
    const sc = baseScore()
    sc.annotations = [
      createAnnotation(3, 'A'),
      createAnnotation(5, 'rit.', 'expression'),
      createAnnotation(5, 'cresc.', 'expression'),
    ]
    expect(annotationsForMeasure(sc, 5)).toHaveLength(2)
    expect(annotationsForMeasure(sc, 3)).toHaveLength(1)
    expect(annotationsForMeasure(sc, 99)).toHaveLength(0)
  })
})

describe('ScoreSchema accepts all Phase 1 extensions', () => {
  it('legacy score with no Phase 1 fields validates (back-compat pin)', () => {
    expect(() => validateScore(baseScore())).not.toThrow()
  })

  it('score with spans, markers, voltas, jumpMarkers, annotations validates', () => {
    const sc = baseScore()
    sc.composer = 'J.S. Bach'
    sc.copyright = '© 2026'
    sc.spans = [createSpan('slur', 'evtestid01', 'evtestid01')]
    sc.markers = [createMarker(0, { key: 'G' })]
    sc.voltas = [createVolta(0, 0, [1])]
    sc.segnoMarkers = [createSegno(0)]
    sc.codaMarkers = [createCoda(0)]
    sc.jumpMarkers = [createJump('Fine', 0)]
    sc.annotations = [createAnnotation(0, 'Allegro', 'tempo-text')]
    expect(() => validateScore(sc)).not.toThrow()
  })

  it('Measure barline fields validate', () => {
    const sc = baseScore()
    sc.measures[0].startBarline = 'repeat-start'
    sc.measures[0].endBarline = 'repeat-end'
    sc.measures[0].isPickup = true
    sc.measures[0].systemBreakAfter = true
    expect(() => ScoreSchema.parse(sc)).not.toThrow()
  })
})

describe('JUMP_KINDS / JumpKindSchema parity (M18-PR-1)', () => {
  it('runtime const matches the Zod enum options exactly (no drift)', () => {
    // Source-of-truth pin: if a new JumpKind is added to
    // JumpKindSchema or to JUMP_KINDS, the other MUST change too.
    // Order is asserted because both are stable across the codebase
    // and the LLM JSON-schema enum mirrors them in order.
    expect([...JUMP_KINDS]).toEqual(JumpKindSchema.options)
  })

  it('lists exactly the 8 expected jump-marker kinds', () => {
    expect(JUMP_KINDS).toEqual([
      'D.C.',
      'D.S.',
      'D.C. al Coda',
      'D.S. al Coda',
      'D.C. al Fine',
      'D.S. al Fine',
      'To Coda',
      'Fine',
    ])
  })
})

describe('HAIRPIN_KINDS / isHairpin', () => {
  it('lists exactly hairpin-cresc and hairpin-dim', () => {
    expect(HAIRPIN_KINDS).toEqual(['hairpin-cresc', 'hairpin-dim'])
  })

  it('isHairpin returns true for cresc and dim', () => {
    expect(isHairpin(createSpan('hairpin-cresc', 'aaaaaaaa', 'bbbbbbbb'))).toBe(true)
    expect(isHairpin(createSpan('hairpin-dim', 'aaaaaaaa', 'bbbbbbbb'))).toBe(true)
  })

  it('isHairpin returns false for non-hairpin span kinds', () => {
    expect(isHairpin(createSpan('slur', 'aaaaaaaa', 'bbbbbbbb'))).toBe(false)
    expect(isHairpin(createSpan('glissando', 'aaaaaaaa', 'bbbbbbbb'))).toBe(false)
    expect(isHairpin(createSpan('8va', 'aaaaaaaa', 'bbbbbbbb'))).toBe(false)
    expect(isHairpin(createSpan('pedal', 'aaaaaaaa', 'bbbbbbbb'))).toBe(false)
  })
})

describe('ensureSpanIds', () => {
  it('returns the same Score reference when there are no spans', () => {
    const score = baseScore()
    expect(ensureSpanIds(score)).toBe(score)
  })

  it('returns the same Score reference when every span already has an id', () => {
    const score = baseScore()
    score.spans = [createSpan('slur', 'evtestid01', 'evtestid01')]
    expect(ensureSpanIds(score)).toBe(score)
    expect(score.spans[0].id!.length).toBeGreaterThanOrEqual(8)
  })

  it('backfills missing ids in place without disturbing already-present ones', () => {
    const existing = createSpan('slur', 'evtestid01', 'evtestid01')
    const existingId = existing.id
    // Construct a span without an id (the LLM-emission case).
    const incoming = {
      kind: 'hairpin-cresc' as const,
      startEventId: 'evtestid01',
      endEventId: 'evtestid01',
      staffIdx: 0,
      voiceIdx: 0,
    }
    const score = baseScore()
    // Cast through unknown to bypass the now-optional `id` field still
    // being typed as required at the call site.
    score.spans = [existing, incoming as unknown as Span]
    const fixed = ensureSpanIds(score)
    expect(fixed).toBe(score)
    expect(fixed.spans![0].id).toBe(existingId)
    expect(typeof fixed.spans![1].id).toBe('string')
    expect(fixed.spans![1].id!.length).toBeGreaterThanOrEqual(8)
  })

  it('replaces ids shorter than the 8-char lower bound', () => {
    const score = baseScore()
    const incoming = {
      id: 'short',
      kind: 'hairpin-dim' as const,
      startEventId: 'evtestid01',
      endEventId: 'evtestid01',
      staffIdx: 0,
      voiceIdx: 0,
    }
    score.spans = [incoming as unknown as Span]
    const fixed = ensureSpanIds(score)
    expect(fixed.spans![0].id).not.toBe('short')
    expect(fixed.spans![0].id!.length).toBeGreaterThanOrEqual(8)
  })

  it('replaces ids longer than the 16-char upper bound', () => {
    const score = baseScore()
    const incoming = {
      id: 'a'.repeat(17),
      kind: 'hairpin-cresc' as const,
      startEventId: 'evtestid01',
      endEventId: 'evtestid01',
      staffIdx: 0,
      voiceIdx: 0,
    }
    score.spans = [incoming as unknown as Span]
    const fixed = ensureSpanIds(score)
    expect(fixed.spans![0].id).not.toBe('a'.repeat(17))
    expect(fixed.spans![0].id!.length).toBeLessThanOrEqual(16)
  })

  it('is a safe no-op on non-Score inputs', () => {
    expect(ensureSpanIds(null)).toBe(null)
    expect(ensureSpanIds(undefined)).toBe(undefined)
    expect(ensureSpanIds(42)).toBe(42)
    expect(ensureSpanIds('hello')).toBe('hello')
    expect(ensureSpanIds({})).toEqual({})
    expect(ensureSpanIds({ spans: 'not-an-array' })).toEqual({ spans: 'not-an-array' })
  })

  it('backfilled spans survive validateScore', () => {
    const incoming = {
      kind: 'hairpin-cresc' as const,
      startEventId: 'evtestid01',
      endEventId: 'evtestid01',
      staffIdx: 0,
      voiceIdx: 0,
    }
    const score = baseScore()
    score.spans = [incoming as unknown as Span]
    const fixed = ensureSpanIds(score)
    expect(() => validateScore(fixed)).not.toThrow()
  })
})
