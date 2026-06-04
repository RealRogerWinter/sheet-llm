import { describe, it, expect } from 'vitest'
import {
  buildChord,
  chordNameFromPitches,
  ChordBuildError,
  diatonicAbove,
  keyAlt,
  pitchToTonalName,
  sortPitchesAscending,
  tonalNoteToPitch,
} from '@/lib/music/chords'
import type { Pitch } from '@/lib/music/types'

const C4: Pitch = { step: 'C', octave: 4 }
const E4: Pitch = { step: 'E', octave: 4 }
const G4: Pitch = { step: 'G', octave: 4 }
const C5: Pitch = { step: 'C', octave: 5 }
const B6: Pitch = { step: 'B', octave: 6 }

describe('keyAlt', () => {
  it('returns 0 in C major', () => {
    expect(keyAlt('C', 'F')).toBe(0)
    expect(keyAlt('C', 'B')).toBe(0)
  })
  it('marks F# in G major', () => {
    expect(keyAlt('G', 'F')).toBe(1)
    expect(keyAlt('G', 'C')).toBe(0)
  })
  it('handles all 6 sharps in F#', () => {
    for (const s of ['F', 'C', 'G', 'D', 'A', 'E'] as const) {
      expect(keyAlt('F#', s)).toBe(1)
    }
    expect(keyAlt('F#', 'B')).toBe(0)
  })
  it('handles flats in Bb', () => {
    expect(keyAlt('Bb', 'B')).toBe(-1)
    expect(keyAlt('Bb', 'E')).toBe(-1)
    expect(keyAlt('Bb', 'A')).toBe(0)
  })
  it('treats minor keys as their relative major', () => {
    expect(keyAlt('Am', 'F')).toBe(0)
    expect(keyAlt('Em', 'F')).toBe(1)
    expect(keyAlt('Dm', 'B')).toBe(-1)
  })
})

describe('pitchToTonalName', () => {
  it('emits letter+octave for natural notes in C major', () => {
    expect(pitchToTonalName(C4, 'C')).toBe('C4')
    expect(pitchToTonalName(E4, 'C')).toBe('E4')
  })
  it('emits explicit accidental when set', () => {
    expect(pitchToTonalName({ step: 'E', octave: 4, accidental: 'flat' }, 'C')).toBe('Eb4')
    expect(pitchToTonalName({ step: 'F', octave: 5, accidental: 'sharp' }, 'C')).toBe('F#5')
    expect(pitchToTonalName({ step: 'G', octave: 4, accidental: 'dblsharp' }, 'C')).toBe('G##4')
  })
  it('honors the key signature when accidental is unset', () => {
    expect(pitchToTonalName({ step: 'F', octave: 4 }, 'G')).toBe('F#4')
    expect(pitchToTonalName({ step: 'B', octave: 4 }, 'F')).toBe('Bb4')
  })
  it('respects explicit natural over key signature', () => {
    expect(pitchToTonalName({ step: 'F', octave: 4, accidental: 'natural' }, 'G')).toBe('F4')
  })
  it('throws on rest', () => {
    expect(() => pitchToTonalName({ step: 'rest', octave: 4 }, 'C')).toThrow(ChordBuildError)
  })
})

describe('tonalNoteToPitch', () => {
  it('parses naturals', () => {
    expect(tonalNoteToPitch('C4', 'C')).toEqual({ step: 'C', octave: 4 })
  })
  it('parses flats in a flat-free key', () => {
    expect(tonalNoteToPitch('Eb4', 'C')).toEqual({ step: 'E', octave: 4, accidental: 'flat' })
  })
  it('drops accidental when key signature already provides it', () => {
    expect(tonalNoteToPitch('F#4', 'G')).toEqual({ step: 'F', octave: 4 })
    expect(tonalNoteToPitch('Bb4', 'F')).toEqual({ step: 'B', octave: 4 })
  })
  it('returns undefined for invalid input', () => {
    expect(tonalNoteToPitch('xyz', 'C')).toBeUndefined()
    expect(tonalNoteToPitch('C', 'C')).toBeUndefined() // no octave
  })
})

describe('buildChord', () => {
  it('builds a C major triad in C major (no accidentals)', () => {
    const chord = buildChord(C4, 'maj', 'C')
    expect(chord).toEqual([
      { step: 'C', octave: 4 },
      { step: 'E', octave: 4 },
      { step: 'G', octave: 4 },
    ])
  })

  it('builds Cmaj7 in C major', () => {
    const chord = buildChord(C4, 'maj7', 'C')
    expect(chord).toEqual([
      { step: 'C', octave: 4 },
      { step: 'E', octave: 4 },
      { step: 'G', octave: 4 },
      { step: 'B', octave: 4 },
    ])
  })

  it('spells dominant 7 in G major cleanly', () => {
    const G4: Pitch = { step: 'G', octave: 4 }
    const chord = buildChord(G4, '7', 'G')
    // G B D F  — G/B/D/A natural, F# implied by key sig (no accidental field)
    // wait: dom7 of G is G-B-D-F (NATURAL F). G major key has F#. So F is overridden to natural.
    expect(chord).toEqual([
      { step: 'G', octave: 4 },
      { step: 'B', octave: 4 },
      { step: 'D', octave: 5 },
      { step: 'F', octave: 5, accidental: 'natural' },
    ])
  })

  it('treats a key-altered root as implicitly altered (C in F# = C#)', () => {
    // Picking root "C" without an explicit natural in F# major means
    // C# (the key sig alters it). The chord built is C#M, which
    // contains C#/E#/G# — all covered by the key signature, so no
    // accidental fields are needed.
    const chord = buildChord(C4, 'maj', 'F#')
    expect(chord).toEqual([
      { step: 'C', octave: 4 },
      { step: 'E', octave: 4 },
      { step: 'G', octave: 4 },
    ])
  })

  it('spells a literal C major triad in F# major when root is explicit natural', () => {
    const Cnat: Pitch = { step: 'C', octave: 4, accidental: 'natural' }
    const chord = buildChord(Cnat, 'maj', 'F#')
    // F# major has C#, E#, G# in the sig — we override all three to natural.
    expect(chord).toEqual([
      { step: 'C', octave: 4, accidental: 'natural' },
      { step: 'E', octave: 4, accidental: 'natural' },
      { step: 'G', octave: 4, accidental: 'natural' },
    ])
  })

  it('spells D major triad in Bb major (F# explicit, others clean)', () => {
    const D4: Pitch = { step: 'D', octave: 4 }
    const chord = buildChord(D4, 'maj', 'Bb')
    expect(chord).toEqual([
      { step: 'D', octave: 4 },
      { step: 'F', octave: 4, accidental: 'sharp' },
      { step: 'A', octave: 4 },
    ])
  })

  it('builds m7b5 with flats', () => {
    const Bb4: Pitch = { step: 'B', octave: 4, accidental: 'flat' }
    const chord = buildChord(Bb4, 'm7b5', 'C')
    // Bbm7b5 = Bb, Db, Fb, Ab
    expect(chord[0]).toEqual({ step: 'B', octave: 4, accidental: 'flat' })
    expect(chord[1]).toEqual({ step: 'D', octave: 5, accidental: 'flat' })
    expect(chord[2]).toEqual({ step: 'F', octave: 5, accidental: 'flat' })
    expect(chord[3]).toEqual({ step: 'A', octave: 5, accidental: 'flat' })
  })

  it('builds suspended chords', () => {
    expect(buildChord(C4, 'sus2', 'C')).toEqual([
      { step: 'C', octave: 4 },
      { step: 'D', octave: 4 },
      { step: 'G', octave: 4 },
    ])
    expect(buildChord(C4, 'sus4', 'C')).toEqual([
      { step: 'C', octave: 4 },
      { step: 'F', octave: 4 },
      { step: 'G', octave: 4 },
    ])
  })

  it('wraps octaves so each chord tone ascends', () => {
    const A5: Pitch = { step: 'A', octave: 5 }
    const chord = buildChord(A5, 'maj7', 'C')
    // A5, C#6, E6, G#6
    expect(chord.map((p) => `${p.step}${p.octave}`)).toEqual(['A5', 'C6', 'E6', 'G6'])
  })

  it('returns ascending MIDI', () => {
    const chord = buildChord(C5, 'dim7', 'C')
    const midis = chord.map((p) => {
      const alt = p.accidental === 'sharp' ? 1 : p.accidental === 'flat' ? -1 : 0
      const steps: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
      return (p.octave + 1) * 12 + steps[p.step as string] + alt
    })
    for (let i = 1; i < midis.length; i++) {
      expect(midis[i]).toBeGreaterThan(midis[i - 1])
    }
  })

  it('throws on rest root', () => {
    expect(() => buildChord({ step: 'rest', octave: 4 }, 'maj', 'C')).toThrow(ChordBuildError)
  })

  it('throws when chord extends past octave 6', () => {
    expect(() => buildChord(B6, 'maj7', 'C')).toThrow(ChordBuildError)
  })

  it('throws on unknown quality', () => {
    expect(() => buildChord(C4, 'bogus' as never, 'C')).toThrow(ChordBuildError)
  })
})

describe('sortPitchesAscending', () => {
  it('sorts a scrambled triad', () => {
    const out = sortPitchesAscending([G4, C4, E4])
    expect(out).toEqual([C4, E4, G4])
  })
  it('uses key signature when accidental is missing', () => {
    // F natural under C and F# under G should land in different orders
    // relative to a G4 — here F# < G but F < G regardless, so test E vs F#
    const Fnatural: Pitch = { step: 'F', octave: 4 }
    const Enatural: Pitch = { step: 'E', octave: 4 }
    // In C: F=midi 65, E=64 → E first
    expect(sortPitchesAscending([Fnatural, Enatural], 'C')).toEqual([Enatural, Fnatural])
    // In G (F implicitly sharp = midi 66): order unchanged here
    expect(sortPitchesAscending([Fnatural, Enatural], 'G')).toEqual([Enatural, Fnatural])
  })
  it('is stable for equal MIDI', () => {
    const a: Pitch = { step: 'E', octave: 4, accidental: 'sharp' } // midi 65
    const b: Pitch = { step: 'F', octave: 4 } // midi 65 in C
    const out = sortPitchesAscending([a, b], 'C')
    expect(out).toEqual([a, b])
  })
  it('places rests at the front', () => {
    const out = sortPitchesAscending([C4, { step: 'rest', octave: 4 }])
    expect(out[0].step).toBe('rest')
  })
})

describe('diatonicAbove', () => {
  it('returns the diatonic 3rd', () => {
    expect(diatonicAbove(C4, 3)).toEqual({ step: 'E', octave: 4 })
    expect(diatonicAbove({ step: 'D', octave: 4 }, 3)).toEqual({ step: 'F', octave: 4 })
  })
  it('returns the diatonic 5th', () => {
    expect(diatonicAbove(C4, 5)).toEqual({ step: 'G', octave: 4 })
  })
  it('returns the diatonic 7th', () => {
    expect(diatonicAbove(C4, 7)).toEqual({ step: 'B', octave: 4 })
  })
  it('wraps octave when interval crosses C', () => {
    // 5th above G4 → D5
    expect(diatonicAbove({ step: 'G', octave: 4 }, 5)).toEqual({ step: 'D', octave: 5 })
  })
  it('throws on rest source', () => {
    expect(() => diatonicAbove({ step: 'rest', octave: 4 }, 3)).toThrow(ChordBuildError)
  })
  it('throws when result extends past octave 6', () => {
    expect(() => diatonicAbove({ step: 'A', octave: 6 }, 7)).toThrow(ChordBuildError)
  })
  it('throws on intervals < 1', () => {
    expect(() => diatonicAbove(C4, 0)).toThrow(ChordBuildError)
  })
})

describe('chordNameFromPitches', () => {
  it('round-trips Cmaj7', () => {
    const chord = buildChord(C4, 'maj7', 'C')
    expect(chordNameFromPitches(chord, 'C')).toBe('Cmaj7')
  })
  it('identifies a minor triad', () => {
    const Am: Pitch[] = [
      { step: 'A', octave: 4 },
      { step: 'C', octave: 5 },
      { step: 'E', octave: 5 },
    ]
    expect(chordNameFromPitches(Am, 'C')).toMatch(/^Am/)
  })
  it('returns null for a single pitch', () => {
    expect(chordNameFromPitches([C4], 'C')).toBeNull()
  })
  it('returns null when a rest is present', () => {
    expect(chordNameFromPitches([{ step: 'rest', octave: 4 }, C4], 'C')).toBeNull()
  })
  it('returns null for unidentifiable stacks', () => {
    const garbage: Pitch[] = [
      { step: 'C', octave: 4 },
      { step: 'C', octave: 4, accidental: 'sharp' },
    ]
    // Two adjacent semitones — not a chord tonal recognises
    expect(chordNameFromPitches(garbage, 'C')).toBeNull()
  })
})
