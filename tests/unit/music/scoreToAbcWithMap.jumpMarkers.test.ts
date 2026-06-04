import { describe, it, expect } from 'vitest'
import abcjs from 'abcjs'
import { scoreToAbcWithMap } from '@/lib/music/scoreToAbcWithMap'
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

function fourBarsWithQuarters(): Score {
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
      {
        events: [
          { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'B', octave: 4 }], duration: 'quarter' },
          { pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
        ],
      },
    ],
  }
}

describe('scoreToAbcWithMap — jump-marker rendering (M18-PR-2)', () => {
  it('emits !D.C.! decoration on the last event of the side="end" measure', () => {
    const sc: Score = {
      ...fourBars(),
      jumpMarkers: [{ id: 'jumpmkr001', measureIdx: 3, side: 'end', kind: 'D.C.' }],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('!D.C.!F8')
  })

  it('emits !D.S.! decoration', () => {
    // Need a Segno for the D.S. to validate at the renderer's
    // upstream callers; the renderer itself doesn't care about
    // validation but we keep the fixture clean.
    const sc: Score = {
      ...fourBars(),
      jumpMarkers: [{ id: 'jumpmkr002', measureIdx: 3, side: 'end', kind: 'D.S.', segnoRef: 'segnoidaa1' }],
      segnoMarkers: [{ id: 'segnoidaa1', measureIdx: 0, side: 'start' }],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('!D.S.!F8')
  })

  it('emits !D.C.alcoda! (space stripped to match abcjs legalAccents)', () => {
    const sc: Score = {
      ...fourBars(),
      jumpMarkers: [{ id: 'jumpmkr003', measureIdx: 3, side: 'end', kind: 'D.C. al Coda' }],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('!D.C.alcoda!F8')
  })

  it('emits !D.S.alcoda!', () => {
    const sc: Score = {
      ...fourBars(),
      jumpMarkers: [{ id: 'jumpmkr004', measureIdx: 3, side: 'end', kind: 'D.S. al Coda', segnoRef: 'segnoidaa1' }],
      segnoMarkers: [{ id: 'segnoidaa1', measureIdx: 0, side: 'start' }],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('!D.S.alcoda!F8')
  })

  it('emits !D.C.alfine! and !D.S.alfine!', () => {
    const sc: Score = {
      ...fourBars(),
      jumpMarkers: [
        { id: 'jumpmkr005', measureIdx: 2, side: 'end', kind: 'D.C. al Fine' },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('!D.C.alfine!E8')

    const sc2: Score = {
      ...fourBars(),
      jumpMarkers: [
        { id: 'jumpmkr006', measureIdx: 3, side: 'end', kind: 'D.S. al Fine', segnoRef: 'segnoidaa1' },
      ],
      segnoMarkers: [{ id: 'segnoidaa1', measureIdx: 0, side: 'start' }],
    }
    const { abc: abc2 } = scoreToAbcWithMap(sc2)
    expect(abc2).toContain('!D.S.alfine!F8')
  })

  it('emits !fine! on the Fine measure', () => {
    const sc: Score = {
      ...fourBars(),
      jumpMarkers: [{ id: 'jumpmkr007', measureIdx: 3, side: 'end', kind: 'Fine' }],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('!fine!F8')
  })

  it('To Coda renders as "^To Coda" annotation (no native abcjs token)', () => {
    const sc: Score = {
      ...fourBars(),
      jumpMarkers: [{ id: 'jumpmkr008', measureIdx: 1, side: 'end', kind: 'To Coda' }],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('"^To Coda"D8')
  })

  it('side="start" attaches the decoration to the FIRST event of the measure', () => {
    const sc: Score = {
      ...fourBarsWithQuarters(),
      jumpMarkers: [
        { id: 'jumpmkrst1', measureIdx: 1, side: 'start', kind: 'D.C.' },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    // Measure 1 starts with G (first quarter); D.C. should attach
    // there, BEFORE the G token.
    expect(abc).toMatch(/!D\.C\.!G/)
  })

  it('side="end" attaches the decoration to the LAST event of a multi-event measure', () => {
    const sc: Score = {
      ...fourBarsWithQuarters(),
      jumpMarkers: [
        { id: 'jumpmkren1', measureIdx: 1, side: 'end', kind: 'Fine' },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    // Measure 1's last event is the C5 quarter. Fine should attach
    // before that token, NOT before G/A/B (the earlier events).
    expect(abc).toMatch(/!fine!c2/)
  })

  it('emits !segno! decoration on the segno landmark measure', () => {
    const sc: Score = {
      ...fourBars(),
      segnoMarkers: [{ id: 'segnoaa001', measureIdx: 0, side: 'start' }],
    }
    const { abc } = scoreToAbcWithMap(sc)
    // side='start' on m=0 → first event of m=0 (the C8 whole note).
    expect(abc).toContain('!segno!C8')
  })

  it('emits !coda! decoration on the coda landmark measure', () => {
    const sc: Score = {
      ...fourBars(),
      codaMarkers: [{ id: 'codaaa0001', measureIdx: 2, side: 'start' }],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('!coda!E8')
  })

  it('combines segno + jump marker on adjacent measures into clean output', () => {
    // Classic ABA form: m=0 Segno landmark, m=2 To Coda, m=3 D.S. al Coda.
    const sc: Score = {
      ...fourBars(),
      segnoMarkers: [{ id: 'segnoaa002', measureIdx: 0, side: 'start' }],
      codaMarkers: [{ id: 'codaaa0002', measureIdx: 2, side: 'start' }],
      jumpMarkers: [
        { id: 'jumpaajv01', measureIdx: 1, side: 'end', kind: 'To Coda' },
        {
          id: 'jumpaajv02',
          measureIdx: 3,
          side: 'end',
          kind: 'D.S. al Coda',
          segnoRef: 'segnoaa002',
          codaRef: 'codaaa0002',
          toCodaRef: 'jumpaajv01',
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('!segno!C8')
    expect(abc).toContain('!coda!E8')
    expect(abc).toContain('"^To Coda"D8')
    expect(abc).toContain('!D.S.alcoda!F8')
  })

  it('silently drops jumpMarkers with out-of-range measureIdx (renderer is not the validator)', () => {
    const sc: Score = {
      ...fourBars(),
      jumpMarkers: [
        { id: 'jumpoor001', measureIdx: 99, side: 'end', kind: 'D.C.' },
      ],
    }
    // Should not throw; should not emit !D.C.!
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).not.toContain('!D.C.!')
  })

  it('survives abcjs round-trip with no warnings (D.C.)', () => {
    const sc: Score = {
      ...fourBars(),
      jumpMarkers: [{ id: 'jumprt0001', measureIdx: 3, side: 'end', kind: 'D.C.' }],
    }
    const { abc } = scoreToAbcWithMap(sc)
    const tunes = abcjs.parseOnly(abc) as Array<{ warnings?: string[] }>
    expect(tunes).toHaveLength(1)
    expect(tunes[0].warnings ?? []).toEqual([])
  })

  it('survives abcjs round-trip with no warnings (D.S. al Coda chain)', () => {
    const sc: Score = {
      ...fourBars(),
      segnoMarkers: [{ id: 'segnort001', measureIdx: 0, side: 'start' }],
      codaMarkers: [{ id: 'codart0001', measureIdx: 2, side: 'start' }],
      jumpMarkers: [
        { id: 'jumprt0002', measureIdx: 1, side: 'end', kind: 'To Coda' },
        {
          id: 'jumprt0003',
          measureIdx: 3,
          side: 'end',
          kind: 'D.S. al Coda',
          segnoRef: 'segnort001',
          codaRef: 'codart0001',
          toCodaRef: 'jumprt0002',
        },
      ],
    }
    const { abc } = scoreToAbcWithMap(sc)
    const tunes = abcjs.parseOnly(abc) as Array<{ warnings?: string[] }>
    expect(tunes).toHaveLength(1)
    expect(tunes[0].warnings ?? []).toEqual([])
  })

  it('does not duplicate the decoration on secondStaff or extraVoices (primary-line only)', () => {
    const sc: Score = {
      ...fourBars(),
      secondStaff: {
        clef: 'bass',
        measures: [
          { events: [{ pitches: [{ step: 'C', octave: 3 }], duration: 'whole' }] },
          { events: [{ pitches: [{ step: 'D', octave: 3 }], duration: 'whole' }] },
          { events: [{ pitches: [{ step: 'E', octave: 3 }], duration: 'whole' }] },
          { events: [{ pitches: [{ step: 'F', octave: 3 }], duration: 'whole' }] },
        ],
      },
      jumpMarkers: [{ id: 'jumpgs0001', measureIdx: 3, side: 'end', kind: 'D.C.' }],
    }
    const { abc } = scoreToAbcWithMap(sc)
    // The !D.C.! should appear EXACTLY once (only on the primary
    // voice's V:1 line, not duplicated on V:2 / secondStaff).
    const occurrences = (abc.match(/!D\.C\.!/g) ?? []).length
    expect(occurrences).toBe(1)
  })

  it('produces identical output regardless of jumpMarkers[] array order (stable sort)', () => {
    const scA: Score = {
      ...fourBars(),
      jumpMarkers: [
        { id: 'jumpsorta1', measureIdx: 3, side: 'end', kind: 'Fine' },
        { id: 'jumpsorta2', measureIdx: 3, side: 'end', kind: 'D.C.' },
      ],
    }
    const scB: Score = {
      ...fourBars(),
      // Same content, reversed order — must produce identical ABC.
      jumpMarkers: [
        { id: 'jumpsorta2', measureIdx: 3, side: 'end', kind: 'D.C.' },
        { id: 'jumpsorta1', measureIdx: 3, side: 'end', kind: 'Fine' },
      ],
    }
    expect(scoreToAbcWithMap(scA).abc).toBe(scoreToAbcWithMap(scB).abc)
  })

  it('produces identical output regardless of segnoMarkers[]/codaMarkers[] array order', () => {
    // Two separate Segnos (rare; multi-Segno pieces exist) at
    // different measures with their array order reversed.
    const scA: Score = {
      ...fourBars(),
      segnoMarkers: [
        { id: 'segnosrtaa', measureIdx: 0, side: 'start' },
        { id: 'segnosrtbb', measureIdx: 2, side: 'start' },
      ],
    }
    const scB: Score = {
      ...fourBars(),
      segnoMarkers: [
        { id: 'segnosrtbb', measureIdx: 2, side: 'start' },
        { id: 'segnosrtaa', measureIdx: 0, side: 'start' },
      ],
    }
    expect(scoreToAbcWithMap(scA).abc).toBe(scoreToAbcWithMap(scB).abc)
  })

  it('Segno-only score (no jumpMarker) survives abcjs round-trip with no warnings', () => {
    const sc: Score = {
      ...fourBars(),
      segnoMarkers: [{ id: 'segnoonly1', measureIdx: 0, side: 'start' }],
    }
    const { abc } = scoreToAbcWithMap(sc)
    const tunes = abcjs.parseOnly(abc) as Array<{ warnings?: string[] }>
    expect(tunes).toHaveLength(1)
    expect(tunes[0].warnings ?? []).toEqual([])
    expect(abc).toContain('!segno!')
  })

  it('SourceMap byEvent entry on a boundary measure accounts for the decoration prefix', () => {
    // The byEvent map's startChar..endChar for the event that
    // carries the !D.C.! prefix must include the decoration in its
    // span, so click-resolution on the rendered SVG can recover the
    // event from any char in the prefix+pitch range.
    const sc: Score = {
      ...fourBars(),
      jumpMarkers: [{ id: 'jumpsrcm01', measureIdx: 3, side: 'end', kind: 'D.C.' }],
    }
    const { abc, map } = scoreToAbcWithMap(sc)
    // Find the F8 event at (0,0,3,0).
    const range = map.byEvent.get('0:0:3:0')
    expect(range).toBeDefined()
    // The prefix !D.C.! sits at startChar; abc.slice(startChar) should
    // begin with the !D.C.! decoration, not bare F.
    expect(abc.slice(range!.startChar, range!.startChar + 6)).toBe('!D.C.!')
  })

  it('coexists with hairpin + annotation on the same event without breaking abcjs', () => {
    // Hairpin from event 0 to event 3 on measure 0; annotation on
    // event 3 of measure 0; Fine jump marker on measure 0 (side=end
    // attaches to event 3). All three at the same event.
    const sc: Score = {
      key: 'C',
      meter: '4/4',
      measures: [
        {
          events: [
            {
              id: 'evstart001',
              pitches: [{ step: 'C', octave: 4 }],
              duration: 'quarter',
            },
            { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
            { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
            {
              id: 'evendxxxx1',
              pitches: [{ step: 'F', octave: 4 }],
              duration: 'quarter',
            },
          ],
        },
      ],
      spans: [
        {
          id: 'spanhpcrr1',
          kind: 'hairpin-cresc',
          startEventId: 'evstart001',
          endEventId: 'evendxxxx1',
          staffIdx: 0,
          voiceIdx: 0,
        },
      ],
      annotations: [
        {
          id: 'annokeepid',
          target: { measureIdx: 0, eventIdx: 3, position: 'above' },
          text: 'climax',
          style: 'italic',
        },
      ],
      jumpMarkers: [{ id: 'jumpcoeex1', measureIdx: 0, side: 'end', kind: 'Fine' }],
    }
    const { abc } = scoreToAbcWithMap(sc)
    expect(abc).toContain('!fine!')
    expect(abc).toContain('"^climax"')
    expect(abc).toContain('!<)!')
    // Round-trip clean.
    const tunes = abcjs.parseOnly(abc) as Array<{ warnings?: string[] }>
    expect(tunes[0].warnings ?? []).toEqual([])
  })
})
