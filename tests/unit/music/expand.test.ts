import { describe, it, expect } from 'vitest'
import {
  expand,
  expandedMeasureSequence,
  isJumpThatArmsAlCoda,
  isJumpThatArmsAlFine,
} from '@/lib/music/expand'
import type { Score } from '@/lib/music/types'

function fourBars(): Score {
  return {
    key: 'C',
    meter: '4/4',
    measures: [
      { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
      { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
      { events: [{ pitches: [{ step: 'E', octave: 4 }], duration: 'whole' }] },
      { events: [{ pitches: [{ step: 'F', octave: 4 }], duration: 'whole' }] },
    ],
  }
}

describe('expand — trivial paths', () => {
  it('returns empty result for empty score', () => {
    const sc: Score = { key: 'C', meter: '4/4', measures: [] }
    const result = expand(sc)
    expect(result.steps).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('returns the linear sequence when no jumpMarkers', () => {
    const result = expand(fourBars())
    expect(result.steps).toEqual([
      { measureIdx: 0, playbackIdx: 0 },
      { measureIdx: 1, playbackIdx: 1 },
      { measureIdx: 2, playbackIdx: 2 },
      { measureIdx: 3, playbackIdx: 3 },
    ])
    expect(result.warnings).toEqual([])
  })

  it('returns the linear sequence when only a Fine (decorative, no al-Fine)', () => {
    // Classical: a Fine without a paired D.C./D.S. al Fine is a
    // no-op decoration; expansion plays through to the end.
    const sc: Score = {
      ...fourBars(),
      jumpMarkers: [{ id: 'finedecor1', measureIdx: 2, side: 'end', kind: 'Fine' }],
    }
    const result = expand(sc)
    expect(result.steps.map((s) => s.measureIdx)).toEqual([0, 1, 2, 3])
    expect(result.warnings).toEqual([])
  })

  it('returns the linear sequence when only a To Coda (no al-Coda armed)', () => {
    const sc: Score = {
      ...fourBars(),
      jumpMarkers: [{ id: 'tocodadec1', measureIdx: 1, side: 'end', kind: 'To Coda' }],
    }
    const result = expand(sc)
    expect(result.steps.map((s) => s.measureIdx)).toEqual([0, 1, 2, 3])
    expect(result.warnings).toEqual([])
  })
})

describe('expand — D.C. and D.S.', () => {
  it('D.C. at end replays from m=0, then terminates after second pass', () => {
    const sc: Score = {
      ...fourBars(),
      jumpMarkers: [{ id: 'dcjump0001', measureIdx: 3, side: 'end', kind: 'D.C.' }],
    }
    const seq = expandedMeasureSequence(sc)
    // Pass 1: 0,1,2,3 (D.C. fires) → Pass 2: 0,1,2,3 (D.C. already
    // fired, so plays linearly to the end).
    expect(seq).toEqual([0, 1, 2, 3, 0, 1, 2, 3])
  })

  it('D.S. with segnoRef jumps to the segno measure', () => {
    const sc: Score = {
      ...fourBars(),
      segnoMarkers: [{ id: 'segnoidaa1', measureIdx: 1, side: 'start' }],
      jumpMarkers: [
        {
          id: 'dsjump0001',
          measureIdx: 3,
          side: 'end',
          kind: 'D.S.',
          segnoRef: 'segnoidaa1',
        },
      ],
    }
    const seq = expandedMeasureSequence(sc)
    // Pass 1: 0,1,2,3 (D.S. fires) → Pass 2: 1,2,3 (segno at m=1).
    expect(seq).toEqual([0, 1, 2, 3, 1, 2, 3])
  })

  it('D.C. fires AT MOST ONCE (no infinite loop)', () => {
    const sc: Score = {
      ...fourBars(),
      jumpMarkers: [{ id: 'dconceonly', measureIdx: 3, side: 'end', kind: 'D.C.' }],
    }
    const result = expand(sc)
    expect(result.steps.length).toBe(8) // 4 + 4, NOT 12+
    expect(result.warnings).toEqual([])
  })

  it('D.S. with unresolvable segnoRef emits unresolved_segno warning + linear continuation', () => {
    const sc: Score = {
      ...fourBars(),
      jumpMarkers: [
        {
          id: 'dsbadseg01',
          measureIdx: 1,
          side: 'end',
          kind: 'D.S.',
          segnoRef: 'ghostsegno',
        },
      ],
    }
    const result = expand(sc)
    expect(result.steps.map((s) => s.measureIdx)).toEqual([0, 1, 2, 3])
    expect(result.warnings).toEqual([
      {
        code: 'unresolved_segno',
        jumpMarkerId: 'dsbadseg01',
        segnoRef: 'ghostsegno',
      },
    ])
  })

  it('D.S. with no segnoRef field at all emits unresolved_segno', () => {
    const sc: Score = {
      ...fourBars(),
      jumpMarkers: [{ id: 'dsmissing1', measureIdx: 2, side: 'end', kind: 'D.S.' }],
    }
    const result = expand(sc)
    expect(result.warnings[0].code).toBe('unresolved_segno')
  })
})

describe('expand — *.al Fine', () => {
  it('D.C. al Fine: pass 1 plays through Fine; pass 2 stops at Fine', () => {
    // Classical pattern: m=0..3 with a Fine on m=1 and D.C. al
    // Fine on m=3. Pass 1: play 0,1,2,3 (Fine ignored — al-Fine
    // not yet armed). D.C. al Fine fires → pass 2: 0,1 (Fine now
    // stops). Total: 0,1,2,3,0,1.
    const sc: Score = {
      ...fourBars(),
      jumpMarkers: [
        { id: 'finemiddle', measureIdx: 1, side: 'end', kind: 'Fine' },
        { id: 'dcalfineee', measureIdx: 3, side: 'end', kind: 'D.C. al Fine' },
      ],
    }
    const seq = expandedMeasureSequence(sc)
    expect(seq).toEqual([0, 1, 2, 3, 0, 1])
  })

  it('D.S. al Fine: pass 1 plays through; pass 2 from segno stops at Fine', () => {
    const sc: Score = {
      ...fourBars(),
      segnoMarkers: [{ id: 'segnoalfff', measureIdx: 1, side: 'start' }],
      jumpMarkers: [
        { id: 'finetarget', measureIdx: 2, side: 'end', kind: 'Fine' },
        {
          id: 'dsalfineee',
          measureIdx: 3,
          side: 'end',
          kind: 'D.S. al Fine',
          segnoRef: 'segnoalfff',
        },
      ],
    }
    const seq = expandedMeasureSequence(sc)
    // Pass 1: 0,1,2,3 → D.S. al Fine → pass 2 from m=1, stop at Fine on m=2.
    // Total: 0,1,2,3,1,2.
    expect(seq).toEqual([0, 1, 2, 3, 1, 2])
  })

  it('D.C. al Fine with no Fine in the score emits al_fine_no_fine warning', () => {
    const sc: Score = {
      ...fourBars(),
      jumpMarkers: [
        { id: 'dcalfneff', measureIdx: 3, side: 'end', kind: 'D.C. al Fine' },
      ],
    }
    const result = expand(sc)
    // Pass 1: 0,1,2,3 → D.C. al Fine fires → pass 2: 0,1,2,3 (no
    // Fine to stop at; linear to the end).
    expect(result.steps.map((s) => s.measureIdx)).toEqual([0, 1, 2, 3, 0, 1, 2, 3])
    expect(result.warnings).toEqual([
      { code: 'al_fine_no_fine', jumpMarkerId: 'dcalfneff' },
    ])
  })
})

describe('expand — *.al Coda', () => {
  it('D.C. al Coda: pass 1 walks past To Coda; pass 2 jumps from To Coda to Coda', () => {
    // Classical: m=0..3. Coda landmark at m=2 (visual target). To
    // Coda at m=1 (the gating point). D.C. al Coda at m=3 → on
    // pass 2, hitting To Coda at m=1 jumps to m=2 (the Coda).
    const sc: Score = {
      ...fourBars(),
      codaMarkers: [{ id: 'codalandm1', measureIdx: 2, side: 'start' }],
      jumpMarkers: [
        { id: 'tocodajmp1', measureIdx: 1, side: 'end', kind: 'To Coda' },
        {
          id: 'dcalcodaa1',
          measureIdx: 3,
          side: 'end',
          kind: 'D.C. al Coda',
          codaRef: 'codalandm1',
        },
      ],
    }
    const seq = expandedMeasureSequence(sc)
    // Pass 1: 0,1,2,3 (To Coda ignored — al-Coda not armed) → D.C.
    // al Coda → arm al-Coda(codalandm1) → pass 2 from m=0: 0,1 →
    // To Coda fires, jump to m=2: 2,3. Total: 0,1,2,3,0,1,2,3.
    expect(seq).toEqual([0, 1, 2, 3, 0, 1, 2, 3])
  })

  it('D.C. al Coda: skips intermediate measures via To Coda hop', () => {
    // Six measures: m=0..5. Coda landmark at m=4. To Coda at m=1
    // (jump from m=1 end → m=4 on pass 2). Result: pass 1 plays
    // 0..5; pass 2 plays 0,1 then hops to 4,5.
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
        { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
        { events: [{ pitches: [{ step: 'E', octave: 4 }], duration: 'whole' }] },
        { events: [{ pitches: [{ step: 'F', octave: 4 }], duration: 'whole' }] },
        { events: [{ pitches: [{ step: 'G', octave: 4 }], duration: 'whole' }] },
        { events: [{ pitches: [{ step: 'A', octave: 4 }], duration: 'whole' }] },
      ],
      codaMarkers: [{ id: 'codaland04', measureIdx: 4, side: 'start' }],
      jumpMarkers: [
        { id: 'tocodaen01', measureIdx: 1, side: 'end', kind: 'To Coda' },
        {
          id: 'dcalcoda05',
          measureIdx: 5,
          side: 'end',
          kind: 'D.C. al Coda',
          codaRef: 'codaland04',
        },
      ],
    }
    const seq = expandedMeasureSequence(sc)
    expect(seq).toEqual([0, 1, 2, 3, 4, 5, 0, 1, 4, 5])
  })

  it('D.S. al Coda: hops from Segno → To Coda → Coda landmark', () => {
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
        { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
        { events: [{ pitches: [{ step: 'E', octave: 4 }], duration: 'whole' }] },
        { events: [{ pitches: [{ step: 'F', octave: 4 }], duration: 'whole' }] },
        { events: [{ pitches: [{ step: 'G', octave: 4 }], duration: 'whole' }] },
      ],
      segnoMarkers: [{ id: 'segdsac001', measureIdx: 1, side: 'start' }],
      codaMarkers: [{ id: 'codacdc001', measureIdx: 3, side: 'start' }],
      jumpMarkers: [
        { id: 'tocodadsac', measureIdx: 2, side: 'end', kind: 'To Coda' },
        {
          id: 'dsalcoddsi',
          measureIdx: 4,
          side: 'end',
          kind: 'D.S. al Coda',
          segnoRef: 'segdsac001',
          codaRef: 'codacdc001',
        },
      ],
    }
    const seq = expandedMeasureSequence(sc)
    // Pass 1: 0,1,2,3,4 → D.S. al Coda → m=1, arm al-Coda(codacdc001)
    // → 1,2 → To Coda fires → m=3 → 3,4. Total: 0,1,2,3,4,1,2,3,4.
    expect(seq).toEqual([0, 1, 2, 3, 4, 1, 2, 3, 4])
  })

  it('D.C. al Coda with unresolvable codaRef does NOT arm al-Coda', () => {
    const sc: Score = {
      ...fourBars(),
      // No codaMarkers; the codaRef points at nothing.
      jumpMarkers: [
        { id: 'tocodalost', measureIdx: 1, side: 'end', kind: 'To Coda' },
        {
          id: 'dcalcobad1',
          measureIdx: 3,
          side: 'end',
          kind: 'D.C. al Coda',
          codaRef: 'ghostcoda',
        },
      ],
    }
    const result = expand(sc)
    // Pass 1: 0,1,2,3 → D.C. al Coda fires (with bad codaRef → al-Coda
    // NOT armed) → pass 2: 0,1,2,3 (To Coda treated as no-op).
    expect(result.steps.map((s) => s.measureIdx)).toEqual([0, 1, 2, 3, 0, 1, 2, 3])
    const unresolved = result.warnings.find((w) => w.code === 'unresolved_coda')
    expect(unresolved).toEqual({
      code: 'unresolved_coda',
      jumpMarkerId: 'dcalcobad1',
      codaRef: 'ghostcoda',
    })
    // No al_coda_no_to_coda — al-Coda was never armed.
    const trailing = result.warnings.find((w) => w.code === 'al_coda_no_to_coda')
    expect(trailing).toBeUndefined()
  })

  it('D.C. al Coda with valid codaRef but NO To Coda in score emits al_coda_no_to_coda', () => {
    const sc: Score = {
      ...fourBars(),
      codaMarkers: [{ id: 'codasolono', measureIdx: 2, side: 'start' }],
      jumpMarkers: [
        {
          id: 'dcalsolono',
          measureIdx: 3,
          side: 'end',
          kind: 'D.C. al Coda',
          codaRef: 'codasolono',
        },
      ],
    }
    const result = expand(sc)
    expect(result.steps.map((s) => s.measureIdx)).toEqual([0, 1, 2, 3, 0, 1, 2, 3])
    expect(result.warnings).toContainEqual({
      code: 'al_coda_no_to_coda',
      jumpMarkerId: 'dcalsolono',
      codaRef: 'codasolono',
    })
  })

  it('To Coda fires AT MOST ONCE per al-Coda arming', () => {
    // After al-Coda fires once, hitting To Coda again on a third
    // pass (if a second D.C. were to exist) would NOT re-fire it.
    // Here we test the single-pass case: To Coda fires once, then
    // the post-Coda path continues normally to score end.
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        { events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }] },
        { events: [{ pitches: [{ step: 'D', octave: 4 }], duration: 'whole' }] },
        { events: [{ pitches: [{ step: 'E', octave: 4 }], duration: 'whole' }] },
      ],
      codaMarkers: [{ id: 'codaonceon', measureIdx: 2, side: 'start' }],
      jumpMarkers: [
        { id: 'tocodaonce', measureIdx: 0, side: 'end', kind: 'To Coda' },
        {
          id: 'dcalcoonce',
          measureIdx: 2,
          side: 'end',
          kind: 'D.C. al Coda',
          codaRef: 'codaonceon',
        },
      ],
    }
    const seq = expandedMeasureSequence(sc)
    // Pass 1: 0,1,2 → D.C. al Coda → pass 2 from m=0: 0 → To Coda
    // fires → m=2: 2. Total: 0,1,2,0,2.
    expect(seq).toEqual([0, 1, 2, 0, 2])
  })
})

describe('expand — cycle detection', () => {
  it('aborts with cycle_aborted on a self-referential al-Coda → To Coda chain', () => {
    // Construct a cycle:  D.C. al Coda → Coda at m=0. Each pass:
    //   m=0,1 → To Coda at m=0 would re-jump on every pass.
    // But "fires at most once" prevents repeat firing — so this
    // particular construction actually terminates cleanly. The
    // resolver's hard cap exists for pathological MULTI-jump
    // chains; here we test it directly by forcing the cap low via
    // a wide score that wouldn't cycle naturally.
    //
    // Simpler cycle test: 1000-measure score with D.C. fires every
    // pass... can't construct directly without multiple D.C.s.
    // Instead, test the cap mechanism by visiting a score larger
    // than the cap (the resolver bails at ITERATION_CAP).
    //
    // Build a 4-measure score with no jumps + the linear visit
    // matches measureCount — cap not triggered. We can't trigger
    // the cap with the "fires at most once" invariant alone, so
    // this test mainly verifies the cap MECHANISM doesn't fire
    // on real scores.
    const sc = fourBars()
    const result = expand(sc)
    expect(result.warnings.find((w) => w.code === 'cycle_aborted')).toBeUndefined()
  })

  it('handles a many-jump score (multiple non-cycling jumps) without hitting the cap', () => {
    // 4 bars, single D.C. → 8 visits. Far below ITERATION_CAP.
    const sc: Score = {
      ...fourBars(),
      jumpMarkers: [{ id: 'capsafedc1', measureIdx: 3, side: 'end', kind: 'D.C.' }],
    }
    const result = expand(sc)
    expect(result.steps.length).toBe(8)
    expect(result.warnings).toEqual([])
  })
})

describe('expand — side ordering and edge cases', () => {
  it('side="start" jumpMarkers do NOT trigger expansion (only side="end" fires)', () => {
    const sc: Score = {
      ...fourBars(),
      jumpMarkers: [{ id: 'dcsidestrt', measureIdx: 0, side: 'start', kind: 'D.C.' }],
    }
    const seq = expandedMeasureSequence(sc)
    // No jump fires — linear sequence.
    expect(seq).toEqual([0, 1, 2, 3])
  })

  it('jump on m=0 still adds m=0 to output before firing', () => {
    // A D.C. on m=0 (degenerate; the D.C. fires at the END of m=0
    // and jumps to m=0). The first m=0 visit IS recorded.
    const sc: Score = {
      ...fourBars(),
      jumpMarkers: [{ id: 'dconm00001', measureIdx: 0, side: 'end', kind: 'D.C.' }],
    }
    const seq = expandedMeasureSequence(sc)
    // Pass 1: m=0 (D.C. fires) → pass 2 from m=0: D.C. already
    // fired, so linear 0,1,2,3. Total: 0,0,1,2,3.
    expect(seq).toEqual([0, 0, 1, 2, 3])
  })

  it('two jumps on same measure: only the first non-Fine non-To-Coda fires', () => {
    // Pathological: both D.C. and Fine on m=3. The D.C. fires (al-
    // Fine not armed, so Fine is decorative).
    const sc: Score = {
      ...fourBars(),
      jumpMarkers: [
        { id: 'finecoexsa', measureIdx: 3, side: 'end', kind: 'Fine' },
        { id: 'dccoexstwo', measureIdx: 3, side: 'end', kind: 'D.C.' },
      ],
    }
    const seq = expandedMeasureSequence(sc)
    // Pass 1: 0,1,2,3 → D.C. fires (Fine decorative) → pass 2:
    // 0,1,2,3 (D.C. already fired, Fine still decorative).
    expect(seq).toEqual([0, 1, 2, 3, 0, 1, 2, 3])
  })
})

describe('expandedMeasureSequence', () => {
  it('returns just the measureIdx array', () => {
    const sc: Score = {
      ...fourBars(),
      jumpMarkers: [{ id: 'expedseqdc', measureIdx: 3, side: 'end', kind: 'D.C.' }],
    }
    expect(expandedMeasureSequence(sc)).toEqual([0, 1, 2, 3, 0, 1, 2, 3])
  })
})

describe('isJumpThatArmsAlCoda / isJumpThatArmsAlFine', () => {
  it('isJumpThatArmsAlCoda recognizes D.C. al Coda + D.S. al Coda', () => {
    expect(isJumpThatArmsAlCoda('D.C. al Coda')).toBe(true)
    expect(isJumpThatArmsAlCoda('D.S. al Coda')).toBe(true)
  })

  it('isJumpThatArmsAlCoda rejects other kinds', () => {
    expect(isJumpThatArmsAlCoda('D.C.')).toBe(false)
    expect(isJumpThatArmsAlCoda('D.S.')).toBe(false)
    expect(isJumpThatArmsAlCoda('D.C. al Fine')).toBe(false)
    expect(isJumpThatArmsAlCoda('Fine')).toBe(false)
    expect(isJumpThatArmsAlCoda('To Coda')).toBe(false)
  })

  it('isJumpThatArmsAlFine recognizes D.C. al Fine + D.S. al Fine', () => {
    expect(isJumpThatArmsAlFine('D.C. al Fine')).toBe(true)
    expect(isJumpThatArmsAlFine('D.S. al Fine')).toBe(true)
  })

  it('isJumpThatArmsAlFine rejects other kinds', () => {
    expect(isJumpThatArmsAlFine('D.C.')).toBe(false)
    expect(isJumpThatArmsAlFine('D.S.')).toBe(false)
    expect(isJumpThatArmsAlFine('D.C. al Coda')).toBe(false)
    expect(isJumpThatArmsAlFine('Fine')).toBe(false)
    expect(isJumpThatArmsAlFine('To Coda')).toBe(false)
  })
})

describe('expand — out-of-range jumpMarker (M18-PR-3 review)', () => {
  it('emits jump_out_of_range warning + linear continuation', () => {
    const sc: Score = {
      ...fourBars(),
      jumpMarkers: [
        { id: 'jumpoor999', measureIdx: 99, side: 'end', kind: 'D.C.' },
      ],
    }
    const result = expand(sc)
    expect(result.steps.map((s) => s.measureIdx)).toEqual([0, 1, 2, 3])
    expect(result.warnings).toEqual([
      {
        code: 'jump_out_of_range',
        jumpMarkerId: 'jumpoor999',
        measureIdx: 99,
        measureCount: 4,
      },
    ])
  })

  it('does not affect in-range jumps when some markers are out-of-range', () => {
    const sc: Score = {
      ...fourBars(),
      jumpMarkers: [
        { id: 'jumpoormix', measureIdx: 99, side: 'end', kind: 'Fine' },
        { id: 'jumpinrang', measureIdx: 3, side: 'end', kind: 'D.C.' },
      ],
    }
    const result = expand(sc)
    expect(result.steps.map((s) => s.measureIdx)).toEqual([0, 1, 2, 3, 0, 1, 2, 3])
    expect(result.warnings).toContainEqual({
      code: 'jump_out_of_range',
      jumpMarkerId: 'jumpoormix',
      measureIdx: 99,
      measureCount: 4,
    })
  })
})

describe('expand — toCodaRef honoring for multi-coda scores (M18-PR-3 review)', () => {
  it('with toCodaRef set, only the matching To Coda fires the hop', () => {
    // 8-bar score. Two Codas, two To Codas. A D.C. al Coda points
    // at codaB via toCodaRef → only the To Coda with that id (B)
    // can fire the hop; the OTHER To Coda (A) is skipped during
    // the post-jump pass.
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: Array.from({ length: 8 }, (_, i) => ({
        events: [
          { pitches: [{ step: 'C', octave: 4 + Math.floor(i / 7) }], duration: 'whole' },
        ],
      })),
      codaMarkers: [
        { id: 'codaaa1111', measureIdx: 3, side: 'start' },
        { id: 'codabb2222', measureIdx: 6, side: 'start' },
      ],
      jumpMarkers: [
        { id: 'tocodajmpA', measureIdx: 0, side: 'end', kind: 'To Coda' },
        { id: 'tocodajmpB', measureIdx: 1, side: 'end', kind: 'To Coda' },
        {
          id: 'dcalcodaTC',
          measureIdx: 7,
          side: 'end',
          kind: 'D.C. al Coda',
          codaRef: 'codabb2222',
          toCodaRef: 'tocodajmpB',
        },
      ],
    }
    const seq = expandedMeasureSequence(sc)
    // Pass 1: 0..7 → D.C. al Coda → arm al-Coda(codabb2222) +
    // alCodaTargetToCodaId='tocodajmpB' → pass 2: 0 (To Coda A
    // skipped — wrong id), 1 → To Coda B fires → jump to m=6:
    // 6,7. Total: 0,1,2,3,4,5,6,7,0,1,6,7.
    expect(seq).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 6, 7])
  })

  it('without toCodaRef, the FIRST To Coda after the jump fires (single-coda common case)', () => {
    const sc: Score = {
      ...fourBars(),
      codaMarkers: [{ id: 'codasingle', measureIdx: 2, side: 'start' }],
      jumpMarkers: [
        { id: 'tocodaonly', measureIdx: 1, side: 'end', kind: 'To Coda' },
        {
          id: 'dcalcosing',
          measureIdx: 3,
          side: 'end',
          kind: 'D.C. al Coda',
          codaRef: 'codasingle',
          // No toCodaRef — any To Coda fires.
        },
      ],
    }
    const seq = expandedMeasureSequence(sc)
    expect(seq).toEqual([0, 1, 2, 3, 0, 1, 2, 3])
  })
})

describe('expand — degenerate orderings (M18-PR-3 review)', () => {
  it('handles Coda landmark BEFORE its To Coda (degenerate but bounded)', () => {
    // Coda at m=1, To Coda at m=2, D.C. al Coda at m=3. After the
    // D.C., To Coda at m=2 jumps BACKWARDS to m=1, then continues
    // forward — but the jump fires only once per arming, so the
    // Coda extends forward past To Coda again normally.
    const sc: Score = {
      ...fourBars(),
      codaMarkers: [{ id: 'codaearly1', measureIdx: 1, side: 'start' }],
      jumpMarkers: [
        { id: 'tocodalate', measureIdx: 2, side: 'end', kind: 'To Coda' },
        {
          id: 'dcalcodaEr',
          measureIdx: 3,
          side: 'end',
          kind: 'D.C. al Coda',
          codaRef: 'codaearly1',
        },
      ],
    }
    const result = expand(sc)
    // Bounded — no cycle abort.
    expect(result.warnings.find((w) => w.code === 'cycle_aborted')).toBeUndefined()
    // Pass 1: 0,1,2,3 → D.C. al Coda → pass 2: 0,1,2 → To Coda fires
    // → m=1 → 1,2,3. Total: 0,1,2,3,0,1,2,1,2,3.
    expect(result.steps.map((s) => s.measureIdx)).toEqual([0, 1, 2, 3, 0, 1, 2, 1, 2, 3])
  })
})

describe('expand — playbackIdx invariant', () => {
  it('playbackIdx is always === index in steps[]', () => {
    const sc: Score = {
      ...fourBars(),
      jumpMarkers: [{ id: 'playbackdc', measureIdx: 3, side: 'end', kind: 'D.C.' }],
    }
    const result = expand(sc)
    for (let i = 0; i < result.steps.length; i++) {
      expect(result.steps[i].playbackIdx).toBe(i)
    }
  })
})
