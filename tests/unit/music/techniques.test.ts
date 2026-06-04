import { describe, it, expect } from 'vitest'
import {
  activeTechniqueAt,
  createTechniqueChange,
  createTechniqueId,
  ensureTechniqueIds,
  techniquesAtPosition,
  techniquesOnVoice,
} from '@/lib/music/techniques'
import { TechniqueChangeSchema, TechniqueKindSchema, type Score } from '@/lib/music/types'
import { validateScore } from '@/lib/music/validateScore'

const baseScore = (): Score => ({
  key: 'C',
  meter: '4/4',
  measures: [
    {
      events: [
        { pitches: [{ step: 'C', octave: 4 }], duration: 'whole' },
      ],
    },
    {
      events: [
        { pitches: [{ step: 'D', octave: 4 }], duration: 'whole' },
      ],
    },
    {
      events: [
        { pitches: [{ step: 'E', octave: 4 }], duration: 'whole' },
      ],
    },
  ],
})

describe('TechniqueKindSchema', () => {
  it('accepts the canonical techniques', () => {
    for (const k of [
      'pizz', 'arco', 'col-legno-battuto', 'col-legno-tratto',
      'sul-ponticello', 'sul-tasto', 'flautando', 'ord',
      'snap-pizz', 'LH-pizz', 'tremolo', 'mute-on', 'mute-off',
    ]) {
      expect(() => TechniqueKindSchema.parse(k)).not.toThrow()
    }
  })
  it('rejects unknown kinds', () => {
    expect(() => TechniqueKindSchema.parse('vibrato')).toThrow()
    expect(() => TechniqueKindSchema.parse('detache')).toThrow()
  })
})

describe('createTechniqueChange / Schema', () => {
  it('builds a valid technique change', () => {
    const t = createTechniqueChange(5, 0, 0, 'pizz')
    expect(t.measureIdx).toBe(5)
    expect(t.kind).toBe('pizz')
    expect(typeof t.id).toBe('string')
    expect(() => TechniqueChangeSchema.parse(t)).not.toThrow()
  })

  it('rejects voiceIdx > 3 or staffIdx > 1', () => {
    expect(() =>
      TechniqueChangeSchema.parse({ ...createTechniqueChange(0, 0, 0, 'pizz'), voiceIdx: 4 }),
    ).toThrow()
    expect(() =>
      TechniqueChangeSchema.parse({ ...createTechniqueChange(0, 0, 0, 'pizz'), staffIdx: 2 }),
    ).toThrow()
  })

  it('createTechniqueId returns a 10-char id', () => {
    expect(createTechniqueId()).toHaveLength(10)
  })

  it('accepts a change WITHOUT an id (LLM-shaped, the wire form)', () => {
    // The LLM emits techniqueStates without ids; the schema must accept
    // this and ensureTechniqueIds backfills downstream.
    expect(() =>
      TechniqueChangeSchema.parse({
        measureIdx: 1,
        staffIdx: 0,
        voiceIdx: 0,
        kind: 'pizz',
      }),
    ).not.toThrow()
  })
})

describe('ensureTechniqueIds', () => {
  it('backfills missing ids on techniqueStates', () => {
    const sc: Score = {
      ...baseScore(),
      techniqueStates: [
        // no id
        { measureIdx: 0, staffIdx: 0, voiceIdx: 0, kind: 'pizz' },
        { measureIdx: 2, staffIdx: 0, voiceIdx: 0, kind: 'arco' },
      ] as Score['techniqueStates'],
    }
    ensureTechniqueIds(sc)
    expect(sc.techniqueStates![0].id).toBeDefined()
    expect(sc.techniqueStates![1].id).toBeDefined()
    expect(typeof sc.techniqueStates![0].id).toBe('string')
    expect(sc.techniqueStates![0].id!.length).toBeGreaterThanOrEqual(8)
  })

  it('mints unique ids for distinct changes', () => {
    const sc: Score = {
      ...baseScore(),
      techniqueStates: [
        { measureIdx: 0, staffIdx: 0, voiceIdx: 0, kind: 'pizz' },
        { measureIdx: 1, staffIdx: 0, voiceIdx: 0, kind: 'arco' },
        { measureIdx: 2, staffIdx: 0, voiceIdx: 0, kind: 'pizz' },
      ] as Score['techniqueStates'],
    }
    ensureTechniqueIds(sc)
    const ids = sc.techniqueStates!.map((t) => t.id)
    expect(new Set(ids).size).toBe(3)
  })

  it('preserves existing valid ids', () => {
    const sc: Score = {
      ...baseScore(),
      techniqueStates: [
        createTechniqueChange(0, 0, 0, 'pizz'),
        // mixed: second one has no id
        { measureIdx: 2, staffIdx: 0, voiceIdx: 0, kind: 'arco' },
      ] as Score['techniqueStates'],
    }
    const originalFirstId = sc.techniqueStates![0].id
    ensureTechniqueIds(sc)
    expect(sc.techniqueStates![0].id).toBe(originalFirstId)
    expect(sc.techniqueStates![1].id).toBeDefined()
  })

  it('replaces out-of-bound ids (too short / too long)', () => {
    const sc = {
      ...baseScore(),
      techniqueStates: [
        { id: 'short', measureIdx: 0, staffIdx: 0, voiceIdx: 0, kind: 'pizz' },
        { id: 'x'.repeat(20), measureIdx: 1, staffIdx: 0, voiceIdx: 0, kind: 'arco' },
      ],
    }
    ensureTechniqueIds(sc as unknown as Score)
    expect((sc.techniqueStates[0] as { id: string }).id.length).toBeGreaterThanOrEqual(8)
    expect((sc.techniqueStates[0] as { id: string }).id.length).toBeLessThanOrEqual(16)
    expect((sc.techniqueStates[1] as { id: string }).id.length).toBeLessThanOrEqual(16)
  })

  it('no-ops when techniqueStates is missing or empty', () => {
    const sc = baseScore()
    expect(() => ensureTechniqueIds(sc)).not.toThrow()
    sc.techniqueStates = []
    expect(() => ensureTechniqueIds(sc)).not.toThrow()
  })

  it('tolerates non-Score input (returns it unchanged)', () => {
    expect(ensureTechniqueIds(null)).toBeNull()
    expect(ensureTechniqueIds(undefined)).toBeUndefined()
    expect(ensureTechniqueIds('not a score' as unknown)).toBe('not a score')
    expect(ensureTechniqueIds(42 as unknown)).toBe(42)
  })

  it('tolerates malformed techniqueStates entries without throwing', () => {
    const sc = { techniqueStates: [null, undefined, 42, 'string', {}] }
    expect(() => ensureTechniqueIds(sc as unknown as Score)).not.toThrow()
  })

  it('returns the input for chaining', () => {
    const sc = baseScore()
    expect(ensureTechniqueIds(sc)).toBe(sc)
  })
})

describe('activeTechniqueAt', () => {
  it('returns undefined when no technique states defined', () => {
    expect(activeTechniqueAt(baseScore(), 0, 0, 5)).toBeUndefined()
  })

  it('returns pizz from the marker forward', () => {
    const sc = baseScore()
    sc.techniqueStates = [createTechniqueChange(1, 0, 0, 'pizz')]
    expect(activeTechniqueAt(sc, 0, 0, 0)).toBeUndefined()
    expect(activeTechniqueAt(sc, 0, 0, 1)).toBe('pizz')
    expect(activeTechniqueAt(sc, 0, 0, 2)).toBe('pizz')
  })

  it('arco cancels a preceding pizz', () => {
    const sc = baseScore()
    sc.techniqueStates = [
      createTechniqueChange(1, 0, 0, 'pizz'),
      createTechniqueChange(2, 0, 0, 'arco'),
    ]
    expect(activeTechniqueAt(sc, 0, 0, 1)).toBe('pizz')
    expect(activeTechniqueAt(sc, 0, 0, 2)).toBeUndefined()
  })

  it('ord cancels a preceding sul-ponticello', () => {
    const sc = baseScore()
    sc.techniqueStates = [
      createTechniqueChange(0, 0, 0, 'sul-ponticello'),
      createTechniqueChange(2, 0, 0, 'ord'),
    ]
    expect(activeTechniqueAt(sc, 0, 0, 0)).toBe('sul-ponticello')
    expect(activeTechniqueAt(sc, 0, 0, 1)).toBe('sul-ponticello')
    expect(activeTechniqueAt(sc, 0, 0, 2)).toBeUndefined()
  })

  it('mute-on / mute-off pair cancel each other', () => {
    const sc = baseScore()
    sc.techniqueStates = [
      createTechniqueChange(0, 0, 0, 'mute-on'),
      createTechniqueChange(2, 0, 0, 'mute-off'),
    ]
    expect(activeTechniqueAt(sc, 0, 0, 1)).toBe('mute-on')
    expect(activeTechniqueAt(sc, 0, 0, 2)).toBeUndefined()
  })

  it('isolates each voice independently', () => {
    const sc = baseScore()
    sc.techniqueStates = [
      createTechniqueChange(0, 0, 0, 'pizz'),
      createTechniqueChange(0, 0, 1, 'sul-ponticello'),
    ]
    expect(activeTechniqueAt(sc, 0, 0, 1)).toBe('pizz')
    expect(activeTechniqueAt(sc, 0, 1, 1)).toBe('sul-ponticello')
    expect(activeTechniqueAt(sc, 0, 2, 1)).toBeUndefined()
  })

  it('isolates each staff independently', () => {
    const sc = baseScore()
    sc.techniqueStates = [
      createTechniqueChange(0, 0, 0, 'pizz'),
      createTechniqueChange(0, 1, 0, 'sul-tasto'),
    ]
    expect(activeTechniqueAt(sc, 0, 0, 1)).toBe('pizz')
    expect(activeTechniqueAt(sc, 1, 0, 1)).toBe('sul-tasto')
  })

  it('within a measure, eventIdx ordering matters', () => {
    const sc = baseScore()
    sc.techniqueStates = [
      createTechniqueChange(1, 0, 0, 'pizz', 0),
      createTechniqueChange(1, 0, 0, 'arco', 5),
    ]
    expect(activeTechniqueAt(sc, 0, 0, 1, 0)).toBe('pizz')
    expect(activeTechniqueAt(sc, 0, 0, 1, 3)).toBe('pizz')
    expect(activeTechniqueAt(sc, 0, 0, 1, 5)).toBeUndefined()
    expect(activeTechniqueAt(sc, 0, 0, 1, 10)).toBeUndefined()
  })

  it('handles unsorted technique state input', () => {
    const sc = baseScore()
    sc.techniqueStates = [
      createTechniqueChange(2, 0, 0, 'arco'),
      createTechniqueChange(1, 0, 0, 'pizz'),
    ]
    expect(activeTechniqueAt(sc, 0, 0, 1)).toBe('pizz')
    expect(activeTechniqueAt(sc, 0, 0, 2)).toBeUndefined()
  })

  it('sequential pizz → snap-pizz → arco walks through cleanly', () => {
    const sc = baseScore()
    sc.techniqueStates = [
      createTechniqueChange(0, 0, 0, 'pizz'),
      createTechniqueChange(1, 0, 0, 'snap-pizz'),
      createTechniqueChange(2, 0, 0, 'arco'),
    ]
    expect(activeTechniqueAt(sc, 0, 0, 0)).toBe('pizz')
    expect(activeTechniqueAt(sc, 0, 0, 1)).toBe('snap-pizz')
    expect(activeTechniqueAt(sc, 0, 0, 2)).toBeUndefined()
  })

  it('an unmatched cancel marker (arco with no prior pizz) is a no-op', () => {
    const sc = baseScore()
    sc.techniqueStates = [createTechniqueChange(0, 0, 0, 'arco')]
    expect(activeTechniqueAt(sc, 0, 0, 0)).toBeUndefined()
  })
})

describe('techniquesOnVoice', () => {
  it('returns techniques on the requested voice, sorted', () => {
    const sc = baseScore()
    sc.techniqueStates = [
      createTechniqueChange(2, 0, 0, 'arco'),
      createTechniqueChange(0, 0, 1, 'sul-ponticello'),
      createTechniqueChange(1, 0, 0, 'pizz'),
    ]
    const v0 = techniquesOnVoice(sc, 0, 0)
    expect(v0).toHaveLength(2)
    expect(v0[0].kind).toBe('pizz')
    expect(v0[1].kind).toBe('arco')
    const v1 = techniquesOnVoice(sc, 0, 1)
    expect(v1).toHaveLength(1)
    expect(v1[0].kind).toBe('sul-ponticello')
  })

  it('returns empty when no technique states', () => {
    expect(techniquesOnVoice(baseScore(), 0, 0)).toEqual([])
  })
})

describe('techniquesAtPosition', () => {
  it('returns markers placed exactly at the (staff, voice, measure, event) tuple', () => {
    const sc = baseScore()
    sc.techniqueStates = [
      createTechniqueChange(0, 0, 0, 'pizz', 1),
      createTechniqueChange(0, 0, 0, 'sul-ponticello', 1),
      createTechniqueChange(1, 0, 0, 'arco', 0),
    ]
    const here = techniquesAtPosition(sc, 0, 0, 0, 1)
    expect(here).toHaveLength(2)
    expect(here.map((t) => t.kind)).toEqual(['pizz', 'sul-ponticello'])
  })

  it('treats omitted eventIdx on a change as event 0', () => {
    const sc = baseScore()
    sc.techniqueStates = [createTechniqueChange(2, 0, 0, 'pizz')]
    expect(techniquesAtPosition(sc, 0, 0, 2, 0)).toHaveLength(1)
    expect(techniquesAtPosition(sc, 0, 0, 2, 1)).toHaveLength(0)
  })

  it('isolates by staffIdx and voiceIdx', () => {
    const sc = baseScore()
    sc.techniqueStates = [
      createTechniqueChange(0, 0, 0, 'pizz', 0),
      createTechniqueChange(0, 0, 1, 'sul-tasto', 0),
    ]
    expect(techniquesAtPosition(sc, 0, 0, 0, 0)).toHaveLength(1)
    expect(techniquesAtPosition(sc, 0, 1, 0, 0)).toHaveLength(1)
    expect(techniquesAtPosition(sc, 1, 0, 0, 0)).toHaveLength(0)
  })

  it('returns empty when techniqueStates is missing or empty', () => {
    expect(techniquesAtPosition(baseScore(), 0, 0, 0, 0)).toEqual([])
  })
})

describe('Score-level round-trip with techniqueStates', () => {
  it('validates a score with pizz/arco markers', () => {
    const sc = baseScore()
    sc.techniqueStates = [
      createTechniqueChange(0, 0, 0, 'pizz'),
      createTechniqueChange(2, 0, 0, 'arco'),
    ]
    expect(() => validateScore(sc)).not.toThrow()
  })

  it('back-compat: a legacy score without techniqueStates still validates', () => {
    expect(() => validateScore(baseScore())).not.toThrow()
  })
})
