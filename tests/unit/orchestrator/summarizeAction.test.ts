import { describe, it, expect } from 'vitest'
import type { Score } from '@/lib/music/types'
import type { Operation } from '@/lib/music/editOperations'
import { summarizeAction } from '@/lib/orchestrator/summarizeAction'
import type { Classification, OrchestratorResult, ScoreLevelOperation } from '@/lib/orchestrator/types'

const BASE_SCORE: Score = {
  title: 'Sketch',
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
}

function buildResult(
  kind: Classification['kind'],
  patch: Partial<OrchestratorResult> & {
    scoreLevelOps?: ScoreLevelOperation[]
    appliedOps?: Operation[]
    score?: Score
  } = {},
): OrchestratorResult {
  const { scoreLevelOps, appliedOps, score, ...rest } = patch
  return {
    score: score ?? BASE_SCORE,
    classification: {
      kind,
      scope: 'snippet',
      complexity: 'simple',
      confidence: 0.95,
      ...(scoreLevelOps ? { score_level_ops: scoreLevelOps } : {}),
    },
    model: null,
    latencyMs: 0,
    ...(appliedOps ? { appliedOps } : {}),
    ...rest,
  }
}

const noteTarget = { measureIdx: 0, eventIdx: 0 }

describe('summarizeAction — edit_score_level', () => {
  it('summarizes a single changeKey op', () => {
    const r = buildResult('edit_score_level', {
      scoreLevelOps: [{ kind: 'changeKey', key: 'F#' }],
    })
    expect(summarizeAction(r)).toBe('Changed key to F#')
  })

  it('summarizes a single changeMeter op', () => {
    const r = buildResult('edit_score_level', {
      scoreLevelOps: [{ kind: 'changeMeter', meter: '3/4' }],
    })
    expect(summarizeAction(r)).toBe('Changed meter to 3/4')
  })

  it('summarizes a single changeTempo op', () => {
    const r = buildResult('edit_score_level', {
      scoreLevelOps: [{ kind: 'changeTempo', tempo_bpm: 120 }],
    })
    expect(summarizeAction(r)).toBe('Changed tempo to ♪ = 120')
  })

  it('summarizes a single changeTitle op with title', () => {
    const r = buildResult('edit_score_level', {
      scoreLevelOps: [{ kind: 'changeTitle', title: 'Etude' }],
    })
    expect(summarizeAction(r)).toBe('Changed title to “Etude”')
  })

  it('joins two ops with a semicolon, lowercasing the second', () => {
    const r = buildResult('edit_score_level', {
      scoreLevelOps: [
        { kind: 'changeKey', key: 'G' },
        { kind: 'changeMeter', meter: '6/8' },
      ],
    })
    expect(summarizeAction(r)).toBe('Changed key to G; changed meter to 6/8')
  })

  it('collapses three+ ops to a count', () => {
    const r = buildResult('edit_score_level', {
      scoreLevelOps: [
        { kind: 'changeKey', key: 'G' },
        { kind: 'changeMeter', meter: '6/8' },
        { kind: 'changeTempo', tempo_bpm: 90 },
      ],
    })
    expect(summarizeAction(r)).toBe('Made 3 score-level changes')
  })

  it('falls back to "Score updated" when score_level_ops is absent', () => {
    const r = buildResult('edit_score_level')
    expect(summarizeAction(r)).toBe('Score updated')
  })
})

describe('summarizeAction — edit_intra_measure', () => {
  it('describes a single changePitch op', () => {
    const r = buildResult('edit_intra_measure', {
      appliedOps: [{ kind: 'changePitch', target: noteTarget, deltaStep: 1 }],
    })
    expect(summarizeAction(r)).toBe('Edited 1 note')
  })

  it('describes a single deleteEvent op', () => {
    const r = buildResult('edit_intra_measure', {
      appliedOps: [{ kind: 'deleteEvent', target: noteTarget }],
    })
    expect(summarizeAction(r)).toBe('Deleted a note')
  })

  it('describes a single insertEventAfter op', () => {
    const r = buildResult('edit_intra_measure', {
      appliedOps: [
        {
          kind: 'insertEventAfter',
          target: noteTarget,
          event: { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
        },
      ],
    })
    expect(summarizeAction(r)).toBe('Inserted a note')
  })

  it('describes a single insertMeasureAfter op', () => {
    const r = buildResult('edit_intra_measure', {
      appliedOps: [{ kind: 'insertMeasureAfter', measureIdx: 0 }],
    })
    expect(summarizeAction(r)).toBe('Inserted a measure')
  })

  it('aggregates same-kind pitch edits into a single "Edited N notes"', () => {
    const r = buildResult('edit_intra_measure', {
      appliedOps: [
        { kind: 'changePitch', target: noteTarget, deltaStep: 1 },
        { kind: 'changePitch', target: { ...noteTarget, eventIdx: 1 }, deltaStep: 1 },
        { kind: 'changePitch', target: { ...noteTarget, eventIdx: 2 }, deltaStep: 1 },
      ],
    })
    expect(summarizeAction(r)).toBe('Edited 3 notes')
  })

  it('aggregates mixed note-edit kinds into "Edited N notes"', () => {
    const r = buildResult('edit_intra_measure', {
      appliedOps: [
        { kind: 'changePitch', target: noteTarget, deltaStep: 1 },
        { kind: 'changeDuration', target: { ...noteTarget, eventIdx: 1 }, duration: 'eighth' },
        { kind: 'setAccidental', target: { ...noteTarget, eventIdx: 2 }, accidental: 'sharp' },
      ],
    })
    expect(summarizeAction(r)).toBe('Edited 3 notes')
  })

  it('aggregates 3 inserts into "Inserted 3 notes"', () => {
    const insert: Operation = {
      kind: 'insertEventAfter',
      target: noteTarget,
      event: { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
    }
    const r = buildResult('edit_intra_measure', { appliedOps: [insert, insert, insert] })
    expect(summarizeAction(r)).toBe('Inserted 3 notes')
  })

  it('aggregates 2 deletes into "Deleted 2 notes"', () => {
    const del: Operation = { kind: 'deleteEvent', target: noteTarget }
    const r = buildResult('edit_intra_measure', { appliedOps: [del, del] })
    expect(summarizeAction(r)).toBe('Deleted 2 notes')
  })

  it('reports structural changes as a measure delta when no note edits accompany', () => {
    const r = buildResult('edit_intra_measure', {
      appliedOps: [
        { kind: 'insertMeasureAfter', measureIdx: 0 },
        { kind: 'insertMeasureAfter', measureIdx: 1 },
        { kind: 'insertMeasureAfter', measureIdx: 2 },
      ],
    })
    expect(summarizeAction(r)).toBe('Added 3 measures')
  })

  it('reports a single insert+delete combo as a measure delta', () => {
    const r = buildResult('edit_intra_measure', {
      appliedOps: [
        { kind: 'insertMeasureAfter', measureIdx: 0 },
        { kind: 'insertMeasureAfter', measureIdx: 1 },
        { kind: 'deleteMeasure', measureIdx: 5 },
      ],
    })
    expect(summarizeAction(r)).toBe('Added 1 measure')
  })

  it('reports net measure removal', () => {
    const r = buildResult('edit_intra_measure', {
      appliedOps: [
        { kind: 'deleteMeasure', measureIdx: 1 },
        { kind: 'deleteMeasure', measureIdx: 2 },
      ],
    })
    expect(summarizeAction(r)).toBe('Removed 2 measures')
  })

  it('falls back to "Made N edits" when ops are heterogeneous (measures + notes)', () => {
    const r = buildResult('edit_intra_measure', {
      appliedOps: [
        { kind: 'insertMeasureAfter', measureIdx: 0 },
        { kind: 'changePitch', target: noteTarget, deltaStep: 1 },
      ],
    })
    expect(summarizeAction(r)).toBe('Made 2 edits')
  })

  it('falls back to "Score updated" when appliedOps is absent', () => {
    const r = buildResult('edit_intra_measure')
    expect(summarizeAction(r)).toBe('Score updated')
  })

  it('describes a single insertTechniqueChange op with the technique kind', () => {
    const r = buildResult('edit_intra_measure', {
      appliedOps: [
        {
          kind: 'insertTechniqueChange',
          techniqueChange: {
            measureIdx: 0,
            staffIdx: 0,
            voiceIdx: 0,
            kind: 'pizz',
          },
        },
      ],
    })
    expect(summarizeAction(r)).toBe('Added a pizz marker')
  })

  it('describes a single removeTechniqueChange op', () => {
    const r = buildResult('edit_intra_measure', {
      appliedOps: [{ kind: 'removeTechniqueChange', id: 'whatever' }],
    })
    expect(summarizeAction(r)).toBe('Removed a technique marker')
  })
})

describe('summarizeAction — compose / generate', () => {
  it('summarizes a compose with a title', () => {
    const r = buildResult('compose', {
      score: { ...BASE_SCORE, title: 'Aubade', key: 'Am', measures: makeMeasures(8) },
    })
    expect(summarizeAction(r)).toBe('Composed “Aubade” — 8 bars in Am')
  })

  it('summarizes a compose without a title', () => {
    const r = buildResult('compose', {
      score: { ...BASE_SCORE, title: undefined, key: 'D', measures: makeMeasures(16) },
    })
    expect(summarizeAction(r)).toBe('Composed 16 bars in D')
  })

  it('summarizes generate_complex with the title verb "Generated"', () => {
    const r = buildResult('generate_complex', {
      score: { ...BASE_SCORE, title: 'Fugue', key: 'F', measures: makeMeasures(32) },
    })
    expect(summarizeAction(r)).toBe('Generated “Fugue” — 32 bars in F')
  })

  it('summarizes generate_simple with no title and 1 bar (singular)', () => {
    const r = buildResult('generate_simple', {
      score: { ...BASE_SCORE, title: undefined, key: 'G', measures: makeMeasures(1) },
    })
    expect(summarizeAction(r)).toBe('Generated 1 bar in G')
  })
})

describe('summarizeAction — setChordSymbol (M10-PR-2)', () => {
  it('uses the canonical formatted form in the phrasing', async () => {
    const { parseChordSymbol } = await import('@/lib/music/chordSymbols')
    const r = buildResult('edit_intra_measure', {
      appliedOps: [
        {
          kind: 'setChordSymbol',
          target: { measureIdx: 0, eventIdx: 0 },
          chordSymbol: parseChordSymbol('Cmaj7')!,
        },
      ],
    })
    expect(summarizeAction(r)).toBe('Set chord symbol (Cmaj7)')
  })

  it('phrasing for slash chord uses formatted bass', async () => {
    const { parseChordSymbol } = await import('@/lib/music/chordSymbols')
    const r = buildResult('edit_intra_measure', {
      appliedOps: [
        {
          kind: 'setChordSymbol',
          target: { measureIdx: 0, eventIdx: 0 },
          chordSymbol: parseChordSymbol('C/E')!,
        },
      ],
    })
    expect(summarizeAction(r)).toBe('Set chord symbol (C/E)')
  })

  it('cleared chord symbol uses generic phrasing', () => {
    const r = buildResult('edit_intra_measure', {
      appliedOps: [
        {
          kind: 'setChordSymbol',
          target: { measureIdx: 0, eventIdx: 0 },
        },
      ],
    })
    expect(summarizeAction(r)).toBe('Cleared a chord symbol')
  })
})

describe('summarizeAction — annotation ops + metadata (M8-PR-1)', () => {
  it('insertAnnotation rehearsal-mark surfaces the letter in the phrasing', () => {
    const r = buildResult('edit_intra_measure', {
      appliedOps: [
        {
          kind: 'insertAnnotation',
          annotation: {
            measureIdx: 0,
            position: 'above',
            text: 'A',
            style: 'rehearsal-mark',
          },
        },
      ],
    })
    expect(summarizeAction(r)).toBe('Added a rehearsal mark "A"')
  })

  it('insertAnnotation tempo-text surfaces the text', () => {
    const r = buildResult('edit_intra_measure', {
      appliedOps: [
        {
          kind: 'insertAnnotation',
          annotation: {
            measureIdx: 0,
            position: 'above',
            text: 'Allegro',
            style: 'tempo-text',
          },
        },
      ],
    })
    expect(summarizeAction(r)).toBe('Added tempo text "Allegro"')
  })

  it('insertAnnotation plain/italic/bold/expression falls back to generic phrasing', () => {
    const r = buildResult('edit_intra_measure', {
      appliedOps: [
        {
          kind: 'insertAnnotation',
          annotation: {
            measureIdx: 0,
            position: 'above',
            text: 'cantabile',
            style: 'expression',
          },
        },
      ],
    })
    expect(summarizeAction(r)).toBe('Added an annotation "cantabile"')
  })

  it('removeAnnotation phrasing', () => {
    const r = buildResult('edit_intra_measure', {
      appliedOps: [{ kind: 'removeAnnotation', id: 'rehearse01' }],
    })
    expect(summarizeAction(r)).toBe('Removed an annotation')
  })

  it('updateAnnotation phrasing', () => {
    const r = buildResult('edit_intra_measure', {
      appliedOps: [
        { kind: 'updateAnnotation', id: 'rehearse01', patch: { text: 'B' } },
      ],
    })
    expect(summarizeAction(r)).toBe('Updated an annotation')
  })

  it('setScoreMetadata single field phrasing', () => {
    const r = buildResult('edit_intra_measure', {
      appliedOps: [{ kind: 'setScoreMetadata', patch: { composer: 'Bach' } }],
    })
    expect(summarizeAction(r)).toBe('Set score composer')
  })

  it('setScoreMetadata multi-field phrasing iterates in canonical order (title, composer, …)', () => {
    // Insertion order in the patch object is {composer, title} but the
    // canonical field order in summarizeAction is title→composer→…, so
    // the result must show title FIRST. Locks the determinism fix
    // applied for the M8-PR-1 review.
    const r = buildResult('edit_intra_measure', {
      appliedOps: [
        { kind: 'setScoreMetadata', patch: { composer: 'Bach', title: 'Invention' } },
      ],
    })
    expect(summarizeAction(r)).toBe('Set score metadata (title, composer)')
  })

  it('setScoreMetadata empty patch falls back to no-op phrasing', () => {
    const r = buildResult('edit_intra_measure', {
      appliedOps: [{ kind: 'setScoreMetadata', patch: {} }],
    })
    expect(summarizeAction(r)).toBe('Score metadata (no-op)')
  })
})

describe('summarizeAction — dragMeasureRange (M19-PR-2)', () => {
  it('delete: single bar produces a 1-indexed summary', () => {
    const r = buildResult('edit_intra_measure', {
      appliedOps: [
        { kind: 'dragMeasureRange', mode: 'delete', fromStart: 2, fromEnd: 2 },
      ],
    })
    expect(summarizeAction(r)).toBe('Deleted 1 bar (bar 3)')
  })

  it('delete: range produces a 1-indexed range summary', () => {
    const r = buildResult('edit_intra_measure', {
      appliedOps: [
        { kind: 'dragMeasureRange', mode: 'delete', fromStart: 1, fromEnd: 3 },
      ],
    })
    expect(summarizeAction(r)).toBe('Deleted 3 bars (bars 2-4)')
  })

  it('move: forward — destination is the 1-indexed final position', () => {
    // Move bar 4 to after bar 7 in a longer score; destStart in 0-idx
    // = (7-1)+1 = 7 → 1-indexed = 8.
    const r = buildResult('edit_intra_measure', {
      appliedOps: [
        {
          kind: 'dragMeasureRange',
          mode: 'move',
          fromStart: 4,
          fromEnd: 4,
          toAfter: 7,
        },
      ],
    })
    expect(summarizeAction(r)).toBe('Moved 1 bar (bar 5) to bar 8')
  })

  it('move: backward — destination math is consistent', () => {
    // Move bars 4-6 to after bar 1; destStart in 0-idx = 1+1 = 2 →
    // 1-indexed = 3.
    const r = buildResult('edit_intra_measure', {
      appliedOps: [
        {
          kind: 'dragMeasureRange',
          mode: 'move',
          fromStart: 4,
          fromEnd: 6,
          toAfter: 1,
        },
      ],
    })
    expect(summarizeAction(r)).toBe('Moved 3 bars (bars 5-7) to bar 3')
  })

  it('move: to the very start with toAfter=-1', () => {
    const r = buildResult('edit_intra_measure', {
      appliedOps: [
        {
          kind: 'dragMeasureRange',
          mode: 'move',
          fromStart: 3,
          fromEnd: 3,
          toAfter: -1,
        },
      ],
    })
    expect(summarizeAction(r)).toBe('Moved 1 bar (bar 4) to bar 1')
  })

  it('duplicate: at the end produces a 1-indexed destination', () => {
    // Duplicate bar 3 (1-idx: bar 3) to position toAfter=3 (after
    // bar 4 in 1-idx); destination 1-idx = toAfter+2 = 5.
    const r = buildResult('edit_intra_measure', {
      appliedOps: [
        {
          kind: 'dragMeasureRange',
          mode: 'duplicate',
          fromStart: 2,
          fromEnd: 2,
          toAfter: 3,
        },
      ],
    })
    expect(summarizeAction(r)).toBe('Duplicated 1 bar (bar 3) at bar 5')
  })

  it('duplicate: range at start (toAfter=-1) lands at bar 1', () => {
    const r = buildResult('edit_intra_measure', {
      appliedOps: [
        {
          kind: 'dragMeasureRange',
          mode: 'duplicate',
          fromStart: 1,
          fromEnd: 2,
          toAfter: -1,
        },
      ],
    })
    expect(summarizeAction(r)).toBe('Duplicated 2 bars (bars 2-3) at bar 1')
  })
})

describe('summarizeAction — fallback', () => {
  it('uses the title when present on an unknown kind', () => {
    // `converse` / `refuse` are not expected to call summarizeAction, but
    // guarding against future drift: the fallback path stays sane.
    const r = buildResult('fall_through', {
      score: { ...BASE_SCORE, title: 'Mystery' },
    })
    expect(summarizeAction(r)).toBe('Updated “Mystery”')
  })

  it('falls back to "Score updated" when no title and unknown kind', () => {
    const r = buildResult('fall_through', { score: { ...BASE_SCORE, title: undefined } })
    expect(summarizeAction(r)).toBe('Score updated')
  })
})

function makeMeasures(n: number): Score['measures'] {
  const measure = BASE_SCORE.measures[0]
  return Array.from({ length: n }, () => measure)
}
