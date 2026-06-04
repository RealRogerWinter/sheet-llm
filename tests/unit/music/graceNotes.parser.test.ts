import { describe, it, expect } from 'vitest'
import { formatGraceNotes, parseGraceNotes } from '@/lib/music/graceNotes'
import type { GraceNote } from '@/lib/music/types'

describe('parseGraceNotes — single grace', () => {
  it('parses a single eighth grace with default octave 5', () => {
    expect(parseGraceNotes('c')).toEqual([
      { pitches: [{ step: 'C', octave: 5 }], duration: 'eighth' },
    ])
  })

  it('uppercase letter is normalized to canonical step', () => {
    expect(parseGraceNotes('D')).toEqual([
      { pitches: [{ step: 'D', octave: 5 }], duration: 'eighth' },
    ])
  })

  it('explicit octave digit overrides the default', () => {
    expect(parseGraceNotes('c4')).toEqual([
      { pitches: [{ step: 'C', octave: 4 }], duration: 'eighth' },
    ])
  })

  it('sharp prefix renders as accidental: sharp', () => {
    expect(parseGraceNotes('^c')).toEqual([
      { pitches: [{ step: 'C', octave: 5, accidental: 'sharp' }], duration: 'eighth' },
    ])
  })

  it('flat prefix renders as accidental: flat', () => {
    expect(parseGraceNotes('_d')).toEqual([
      { pitches: [{ step: 'D', octave: 5, accidental: 'flat' }], duration: 'eighth' },
    ])
  })

  it('natural prefix renders as accidental: natural', () => {
    expect(parseGraceNotes('=e')).toEqual([
      { pitches: [{ step: 'E', octave: 5, accidental: 'natural' }], duration: 'eighth' },
    ])
  })

  it('trailing / sets duration to sixteenth', () => {
    expect(parseGraceNotes('c/')).toEqual([
      { pitches: [{ step: 'C', octave: 5 }], duration: 'sixteenth' },
    ])
  })

  it('trailing /4 sets duration to 32nd', () => {
    expect(parseGraceNotes('c/4')).toEqual([
      { pitches: [{ step: 'C', octave: 5 }], duration: '32nd' },
    ])
  })

  it('combines accidental + octave + duration', () => {
    expect(parseGraceNotes('^c4/')).toEqual([
      { pitches: [{ step: 'C', octave: 4, accidental: 'sharp' }], duration: 'sixteenth' },
    ])
  })
})

describe('parseGraceNotes — slashed (acciaccatura)', () => {
  it('leading / sets slashed:true on the leading grace', () => {
    expect(parseGraceNotes('/c')).toEqual([
      { pitches: [{ step: 'C', octave: 5 }], duration: 'eighth', slashed: true },
    ])
  })

  it('leading / applies to ONLY the leading grace in a run', () => {
    const result = parseGraceNotes('/c d e')
    expect(result).toBeDefined()
    expect(result![0].slashed).toBe(true)
    expect(result![1].slashed).toBeUndefined()
    expect(result![2].slashed).toBeUndefined()
  })
})

describe('parseGraceNotes — runs', () => {
  it('space-separated tokens become multiple grace moments', () => {
    expect(parseGraceNotes('c d e')).toEqual([
      { pitches: [{ step: 'C', octave: 5 }], duration: 'eighth' },
      { pitches: [{ step: 'D', octave: 5 }], duration: 'eighth' },
      { pitches: [{ step: 'E', octave: 5 }], duration: 'eighth' },
    ])
  })

  it('per-moment duration is independent', () => {
    expect(parseGraceNotes('c/ d e/4')).toEqual([
      { pitches: [{ step: 'C', octave: 5 }], duration: 'sixteenth' },
      { pitches: [{ step: 'D', octave: 5 }], duration: 'eighth' },
      { pitches: [{ step: 'E', octave: 5 }], duration: '32nd' },
    ])
  })

  it('extra whitespace between tokens is tolerated', () => {
    expect(parseGraceNotes('  c   d  e  ')).toHaveLength(3)
  })
})

describe('parseGraceNotes — chord', () => {
  it('[ace] becomes one grace moment with 3 pitches', () => {
    expect(parseGraceNotes('[ace]')).toEqual([
      {
        pitches: [
          { step: 'A', octave: 5 },
          { step: 'C', octave: 5 },
          { step: 'E', octave: 5 },
        ],
        duration: 'eighth',
      },
    ])
  })

  it('chord supports per-pitch accidental and octave', () => {
    expect(parseGraceNotes('[^c4_e]')).toEqual([
      {
        pitches: [
          { step: 'C', octave: 4, accidental: 'sharp' },
          { step: 'E', octave: 5, accidental: 'flat' },
        ],
        duration: 'eighth',
      },
    ])
  })

  it('chord can appear inside a run', () => {
    const result = parseGraceNotes('c [ce] d')
    expect(result).toHaveLength(3)
    expect(result![1].pitches).toHaveLength(2)
  })
})

describe('parseGraceNotes — rejection', () => {
  it('returns undefined on empty input', () => {
    expect(parseGraceNotes('')).toBeUndefined()
    expect(parseGraceNotes('   ')).toBeUndefined()
  })

  it('returns undefined on garbage', () => {
    expect(parseGraceNotes('xyz')).toBeUndefined()
    expect(parseGraceNotes('rest')).toBeUndefined()
  })

  it('returns undefined on octave out of range', () => {
    expect(parseGraceNotes('c1')).toBeUndefined()
    expect(parseGraceNotes('c7')).toBeUndefined()
  })

  it('returns undefined on unmatched bracket', () => {
    expect(parseGraceNotes('[ce')).toBeUndefined()
    expect(parseGraceNotes('ce]')).toBeUndefined()
  })

  it('returns undefined on empty chord', () => {
    expect(parseGraceNotes('[]')).toBeUndefined()
  })

  it('returns undefined on leading-/ with no body', () => {
    expect(parseGraceNotes('/')).toBeUndefined()
  })
})

describe('formatGraceNotes — round-trip', () => {
  function roundTrip(text: string) {
    const parsed = parseGraceNotes(text)
    expect(parsed).toBeDefined()
    const formatted = formatGraceNotes(parsed!)
    const reparsed = parseGraceNotes(formatted)
    expect(reparsed).toEqual(parsed)
    return formatted
  }

  it('round-trips a single eighth grace', () => {
    expect(roundTrip('c')).toBe('c')
  })

  it('round-trips a slashed acciaccatura', () => {
    expect(roundTrip('/c')).toBe('/c')
  })

  it('round-trips a 3-note run', () => {
    expect(roundTrip('c d e')).toBe('c d e')
  })

  it('round-trips a sixteenth grace', () => {
    expect(roundTrip('c/')).toBe('c/')
  })

  it('round-trips a 32nd grace', () => {
    expect(roundTrip('c/4')).toBe('c/4')
  })

  it('round-trips a grace chord', () => {
    expect(roundTrip('[ace]')).toBe('[ace]')
  })

  it('round-trips combinations (slashed + run + duration + accidental)', () => {
    expect(roundTrip('/^c4 d/4 _e')).toBe('/^c4 d/4 _e')
  })

  it('formatGraceNotes returns empty string on empty input array', () => {
    expect(formatGraceNotes([] as GraceNote[])).toBe('')
  })

  it('single-pitch chord [c] formats as bare c (brackets collapse; semantically identical)', () => {
    // A "chord" with one pitch is degenerate — the formatter drops
    // the brackets and emits the bare pitch. Round-trip stays equal
    // since [c] and c both parse to {pitches:[C5], duration:eighth}.
    const parsed = parseGraceNotes('[c]')
    expect(parsed).toEqual([
      { pitches: [{ step: 'C', octave: 5 }], duration: 'eighth' },
    ])
    expect(formatGraceNotes(parsed!)).toBe('c')
  })

  it('explicit slashed:false normalizes to absent slashed flag on format', () => {
    // The formatter checks slashed === true, so explicit false drops
    // to no leading `/`. Reparsed shape has slashed absent, not false.
    // Schema treats absent/false equivalently for rendering — the
    // round-trip is lossy on the boolean discriminator but lossless
    // on the rendered output. Documents the convention.
    const formatted = formatGraceNotes([
      { pitches: [{ step: 'C', octave: 5 }], duration: 'eighth', slashed: false },
    ] as GraceNote[])
    expect(formatted).toBe('c')
    const reparsed = parseGraceNotes(formatted)
    expect(reparsed![0]).not.toHaveProperty('slashed')
  })
})
