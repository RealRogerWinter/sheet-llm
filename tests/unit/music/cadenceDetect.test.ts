import { describe, expect, it } from 'vitest'
import { detectCadenceAtFinalBarline } from '@/lib/music/cadenceDetect'
import type { Score } from '@/lib/music/types'

function makeScore(measures: Score['measures'], key: Score['key'] = 'C'): Score {
  return {
    title: 'Test',
    key,
    meter: '4/4',
    measures,
  }
}

describe('cadenceDetect: detectCadenceAtFinalBarline', () => {
  it('detects V → I authentic cadence', () => {
    const score = makeScore([
      {
        events: [
          { pitches: [{ step: 'C', octave: 4 }], duration: 'whole' },
        ],
      },
      {
        events: [
          { pitches: [{ step: 'G', octave: 3 }], duration: 'half' }, // V
          { pitches: [{ step: 'C', octave: 4 }], duration: 'half' }, // I
        ],
      },
    ])
    const result = detectCadenceAtFinalBarline(score)
    expect(result.detected).toBe(true)
    expect(result.kind).toBe('authentic')
  })

  it('detects IV → I plagal cadence', () => {
    const score = makeScore([
      {
        events: [
          { pitches: [{ step: 'F', octave: 4 }], duration: 'half' }, // IV
          { pitches: [{ step: 'C', octave: 4 }], duration: 'half' }, // I
        ],
      },
    ])
    const result = detectCadenceAtFinalBarline(score)
    expect(result.detected).toBe(true)
    expect(result.kind).toBe('plagal')
  })

  it('detects half cadence (any → V)', () => {
    const score = makeScore([
      {
        events: [
          { pitches: [{ step: 'C', octave: 4 }], duration: 'half' }, // I
          { pitches: [{ step: 'G', octave: 4 }], duration: 'half' }, // V
        ],
      },
    ])
    const result = detectCadenceAtFinalBarline(score)
    expect(result.detected).toBe(true)
    expect(result.kind).toBe('half')
  })

  it('detects V → vi deceptive cadence', () => {
    const score = makeScore([
      {
        events: [
          { pitches: [{ step: 'G', octave: 4 }], duration: 'half' }, // V
          { pitches: [{ step: 'A', octave: 4 }], duration: 'half' }, // vi
        ],
      },
    ])
    const result = detectCadenceAtFinalBarline(score)
    expect(result.detected).toBe(true)
    expect(result.kind).toBe('deceptive')
  })

  it('detects authentic cadence in minor (V → i)', () => {
    // A minor: V is E (pc 4), i is A (pc 9). prev=E, last=A.
    const score = makeScore(
      [
        {
          events: [
            { pitches: [{ step: 'E', octave: 4 }], duration: 'half' },
            { pitches: [{ step: 'A', octave: 4 }], duration: 'half' },
          ],
        },
      ],
      'Am',
    )
    const result = detectCadenceAtFinalBarline(score)
    expect(result.detected).toBe(true)
    expect(result.kind).toBe('authentic')
  })

  it('does NOT detect when ending is non-cadential', () => {
    const score = makeScore([
      {
        events: [
          { pitches: [{ step: 'E', octave: 4 }], duration: 'half' },
          { pitches: [{ step: 'F', octave: 4 }], duration: 'half' },
        ],
      },
    ])
    const result = detectCadenceAtFinalBarline(score)
    expect(result.detected).toBe(false)
  })

  it('does NOT detect when fewer than 2 pitched events', () => {
    const score = makeScore([
      {
        events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }],
      },
    ])
    const result = detectCadenceAtFinalBarline(score)
    expect(result.detected).toBe(false)
  })

  it('reports finalFermata when fermata present on last event', () => {
    const score = makeScore([
      {
        events: [
          { pitches: [{ step: 'G', octave: 4 }], duration: 'half' },
          { pitches: [{ step: 'C', octave: 5 }], duration: 'half', fermata: 'standard' },
        ],
      },
    ])
    const result = detectCadenceAtFinalBarline(score)
    expect(result.detected).toBe(true)
    expect(result.kind).toBe('authentic')
    expect(result.finalFermata).toBe(true)
  })

  it('walks back across measures when last bar has only one event', () => {
    const score = makeScore([
      {
        events: [{ pitches: [{ step: 'G', octave: 4 }], duration: 'whole' }], // V
      },
      {
        events: [{ pitches: [{ step: 'C', octave: 5 }], duration: 'whole' }], // I
      },
    ])
    const result = detectCadenceAtFinalBarline(score)
    expect(result.detected).toBe(true)
    expect(result.kind).toBe('authentic')
  })

  it('detects half cadence in G major (D → ?, ? → D)', () => {
    // G major: V is D (pc 2)
    const score = makeScore(
      [
        {
          events: [
            { pitches: [{ step: 'G', octave: 4 }], duration: 'half' }, // I
            { pitches: [{ step: 'D', octave: 4 }], duration: 'half' }, // V
          ],
        },
      ],
      'G',
    )
    const result = detectCadenceAtFinalBarline(score)
    expect(result.detected).toBe(true)
    expect(result.kind).toBe('half')
  })

  // ── PR-7 tuning: skip trailing tonic repeats ───────────────────────
  // Live eval `turnaround-after-PAC` ships a 4-bar phrase
  // F → G → C → C (IV V I I). Pre-PR-7 the detector only looked at the
  // last two events (C → C, both tonic) and returned not-detected. Now
  // we walk back over trailing tonic-repeats to find the harmonic
  // motion INTO the tonic.

  it('detects V → I past a repeated tonic (PAC with tonic echo)', () => {
    // F → G → C → C in C major: the meaningful cadence is V (G) → I
    // (C). The last two events are both I; we must skip back.
    const score = makeScore([
      {
        events: [
          { pitches: [{ step: 'F', octave: 4 }], duration: 'whole' }, // IV
        ],
      },
      {
        events: [
          { pitches: [{ step: 'G', octave: 4 }], duration: 'whole' }, // V
        ],
      },
      {
        events: [
          { pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }, // I
        ],
      },
      {
        events: [
          { pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }, // I (echo)
        ],
        endBarline: 'final',
      },
    ])
    const result = detectCadenceAtFinalBarline(score)
    expect(result.detected).toBe(true)
    expect(result.kind).toBe('authentic')
  })

  it('detects IV → I past a repeated tonic', () => {
    // F → C → C in C major. Walk past the trailing C echo to find IV.
    const score = makeScore([
      {
        events: [
          { pitches: [{ step: 'F', octave: 4 }], duration: 'whole' }, // IV
        ],
      },
      {
        events: [
          { pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }, // I
        ],
      },
      {
        events: [
          { pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }, // I (echo)
        ],
      },
    ])
    const result = detectCadenceAtFinalBarline(score)
    expect(result.detected).toBe(true)
    expect(result.kind).toBe('plagal')
  })

  it('does NOT misfire on a long static tonic pedal', () => {
    // 4 bars of C in C major — no V or IV anywhere. The skip-back
    // must terminate without false-positive detection.
    const score = makeScore([
      {
        events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }],
      },
      {
        events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }],
      },
      {
        events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }],
      },
      {
        events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }],
      },
    ])
    const result = detectCadenceAtFinalBarline(score)
    expect(result.detected).toBe(false)
  })

  it('detects V → I in a chord-triad voicing (bare melody case)', () => {
    // G major chord → C major chord. Lowest pitches are G (pc 7) and
    // C (pc 0) — V → I. Already covered by the V-triad→I-triad case
    // above (test at line ~15 is single-pitch); this adds the
    // explicit chord-triad coverage the PR-7 brief calls for.
    const score = makeScore([
      {
        events: [
          {
            pitches: [
              { step: 'G', octave: 4 },
              { step: 'B', octave: 4 },
              { step: 'D', octave: 5 },
            ],
            duration: 'whole',
          },
        ],
      },
      {
        events: [
          {
            pitches: [
              { step: 'C', octave: 4 },
              { step: 'E', octave: 4 },
              { step: 'G', octave: 4 },
            ],
            duration: 'whole',
          },
        ],
        endBarline: 'final',
      },
    ])
    const result = detectCadenceAtFinalBarline(score)
    expect(result.detected).toBe(true)
    expect(result.kind).toBe('authentic')
  })

  it('does NOT detect on random chromatic ending', () => {
    // C# → D# — chromatic walk-up; neither is a recognised degree.
    const score = makeScore([
      {
        events: [
          { pitches: [{ step: 'C', octave: 4, accidental: 'sharp' }], duration: 'half' },
          { pitches: [{ step: 'D', octave: 4, accidental: 'sharp' }], duration: 'half' },
        ],
      },
    ])
    const result = detectCadenceAtFinalBarline(score)
    expect(result.detected).toBe(false)
  })
})
