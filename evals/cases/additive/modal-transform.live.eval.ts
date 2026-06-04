import type { Score } from '@/lib/music/types'
import { buildLiveCase } from '../../lib/buildLiveCase'

/**
 * 4-bar piece in C Ionian. User asks to make it Dorian. The strict
 * theoretical answer is C Dorian (C-D-Eb-F-G-A-Bb-C); the LLM may
 * legitimately respell as Bb (relative major) which would set
 * `key: 'Bb'`. Either is musically defensible. Accept both:
 *   - key === 'C' AND notes contain a B-flat (Bb explicit accidental)
 *   - OR key === 'Bb' (Dorian on C re-signed)
 */
const C_IONIAN: Score = {
  title: 'Mode demo',
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
    {
      events: [
        { pitches: [{ step: 'B', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
      ],
    },
    {
      events: [
        { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
        { pitches: [{ step: 'C', octave: 4 }], duration: 'whole' },
      ],
    },
  ],
}

buildLiveCase({
  id: 'modal-transform-c-to-dorian',
  title: 'additive: convert C Ionian to Dorian',
  initialScore: C_IONIAN,
  userText: 'make this Dorian',
  expected: {
    measureCount: 4,
    meterPreserved: '4/4',
    titlePreserved: 'Mode demo',
  },
  extraAssertions: (result) => {
    const fails: string[] = []
    const score = result.score
    // Accept either: key stays C AND at least one B has a flat
    // accidental, OR key respelled to Bb (relative major).
    const flagsBflat = (): boolean => {
      for (const m of score.measures) {
        for (const e of m.events) {
          if (e.kind === 'rest') continue
          for (const p of e.pitches) {
            if (p.step === 'B' && p.accidental === 'flat') return true
          }
        }
      }
      return false
    }
    if (score.key === 'C' && !flagsBflat()) {
      fails.push(
        'expected B-flat accidental on at least one B pitch when key stays C',
      )
    } else if (score.key !== 'C' && score.key !== 'Bb') {
      fails.push(
        `expected key=C (with B-flat) or Bb (relative major); got "${score.key}"`,
      )
    }
    return fails
  },
})
