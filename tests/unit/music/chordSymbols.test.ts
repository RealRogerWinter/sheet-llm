import { describe, it, expect } from 'vitest'
import { chordSymbolsEqual, formatChordSymbol, parseChordSymbol } from '@/lib/music/chordSymbols'
import { ChordSymbolSchema, type ChordSymbol } from '@/lib/music/types'

describe('parseChordSymbol — basic chords', () => {
  it('parses a bare major triad', () => {
    const c = parseChordSymbol('C')!
    expect(c.root).toBe('C')
    expect(c.quality).toBe('major')
    expect(c.seventh).toBe('none')
  })

  it('parses a minor triad ("Cm", "Cmin", "C-")', () => {
    expect(parseChordSymbol('Cm')!.quality).toBe('minor')
    expect(parseChordSymbol('Cmin')!.quality).toBe('minor')
    expect(parseChordSymbol('C-')!.quality).toBe('minor')
  })

  it('parses a diminished triad ("Cdim", "C°")', () => {
    expect(parseChordSymbol('Cdim')!.quality).toBe('diminished')
    expect(parseChordSymbol('C°')!.quality).toBe('diminished')
  })

  it('parses augmented ("Caug", "C+")', () => {
    expect(parseChordSymbol('Caug')!.quality).toBe('augmented')
    expect(parseChordSymbol('C+')!.quality).toBe('augmented')
  })

  it('parses sus chords', () => {
    expect(parseChordSymbol('Csus2')!.quality).toBe('sus2')
    expect(parseChordSymbol('Csus4')!.quality).toBe('sus4')
    expect(parseChordSymbol('Csus')!.quality).toBe('sus4')
  })
})

describe('parseChordSymbol — sevenths', () => {
  it('parses dominant 7 ("C7")', () => {
    const c = parseChordSymbol('C7')!
    expect(c.quality).toBe('major')
    expect(c.seventh).toBe('dom7')
  })

  it('parses major 7 ("Cmaj7", "C△7", "CM7")', () => {
    expect(parseChordSymbol('Cmaj7')!.seventh).toBe('maj7')
    expect(parseChordSymbol('C△7')!.seventh).toBe('maj7')
    expect(parseChordSymbol('CM7')!.seventh).toBe('maj7')
  })

  it('parses minor 7 ("Cm7")', () => {
    const c = parseChordSymbol('Cm7')!
    expect(c.quality).toBe('minor')
    expect(c.seventh).toBe('min7')
  })

  it('parses minor-major 7 ("Cm(maj7)", "Cm△7")', () => {
    expect(parseChordSymbol('Cm(maj7)')!.seventh).toBe('maj7')
    expect(parseChordSymbol('Cm△7')!.seventh).toBe('maj7')
    expect(parseChordSymbol('Cm(maj7)')!.quality).toBe('minor')
  })

  it('parses half-diminished ("Cø7", "Cm7b5", "F#m7b5")', () => {
    expect(parseChordSymbol('Cø7')!.seventh).toBe('halfdim7')
    expect(parseChordSymbol('Cm7b5')!.seventh).toBe('halfdim7')
    const f = parseChordSymbol('F#m7b5')!
    expect(f.root).toBe('F#')
    expect(f.quality).toBe('minor')
    expect(f.seventh).toBe('halfdim7')
  })

  it('parses fully-diminished 7 ("Cdim7", "C°7")', () => {
    expect(parseChordSymbol('Cdim7')!.seventh).toBe('dim7')
    expect(parseChordSymbol('C°7')!.seventh).toBe('dim7')
  })
})

describe('parseChordSymbol — extensions', () => {
  it('parses C9 as dom7 + extension 9', () => {
    const c = parseChordSymbol('C9')!
    expect(c.seventh).toBe('dom7')
    expect(c.extensions).toEqual([9])
  })

  it('parses Cmaj9 as maj7 + extension 9', () => {
    const c = parseChordSymbol('Cmaj9')!
    expect(c.seventh).toBe('maj7')
    expect(c.extensions).toEqual([9])
  })

  it('parses C13 as dom7 + extension 13', () => {
    expect(parseChordSymbol('C13')!.extensions).toEqual([13])
  })

  it('parses Cm11 as minor + min7 + extension 11', () => {
    const c = parseChordSymbol('Cm11')!
    expect(c.quality).toBe('minor')
    expect(c.seventh).toBe('min7')
    expect(c.extensions).toEqual([11])
  })
})

describe('parseChordSymbol — alterations', () => {
  it('parses parenthesized alterations C7(b9)', () => {
    expect(parseChordSymbol('C7(b9)')!.alterations).toEqual(['b9'])
  })

  it('parses multiple alterations C7(b9,#11)', () => {
    const c = parseChordSymbol('C7(b9,#11)')!
    expect(c.alterations).toContain('b9')
    expect(c.alterations).toContain('#11')
  })

  it('parses loose alterations C7b9#11', () => {
    const c = parseChordSymbol('C7b9#11')!
    expect(c.alterations).toContain('b9')
    expect(c.alterations).toContain('#11')
  })

  it('parses Cmaj7#11 (Lydian voicing)', () => {
    const c = parseChordSymbol('Cmaj7#11')!
    expect(c.seventh).toBe('maj7')
    expect(c.alterations).toEqual(['#11'])
  })

  it('parses C7alt as alterations:["alt"]', () => {
    expect(parseChordSymbol('C7alt')!.alterations).toContain('alt')
  })
})

describe('parseChordSymbol — add / omit / 6 chord', () => {
  it('distinguishes Cadd9 from C9', () => {
    const cadd9 = parseChordSymbol('Cadd9')!
    expect(cadd9.add).toEqual([9])
    expect(cadd9.seventh).toBe('none')
    const c9 = parseChordSymbol('C9')!
    expect(c9.seventh).toBe('dom7')
    expect(c9.extensions).toEqual([9])
  })

  it('parses C6 as add6 (no 7th)', () => {
    const c6 = parseChordSymbol('C6')!
    expect(c6.add).toEqual([6])
    expect(c6.seventh).toBe('none')
  })

  it('parses omit3 / (no3) / (no5)', () => {
    expect(parseChordSymbol('C(no3)')!.omit).toEqual([3])
    expect(parseChordSymbol('C(no5)')!.omit).toEqual([5])
  })
})

describe('parseChordSymbol — slash chords + polychords', () => {
  it('parses slash chord C/E', () => {
    const c = parseChordSymbol('C/E')!
    expect(c.bass).toEqual({ type: 'note', value: 'E' })
  })

  it('parses slash with accidental Bb/D', () => {
    const c = parseChordSymbol('Bb/D')!
    expect(c.bass?.type).toBe('note')
    if (c.bass?.type === 'note') expect(c.bass.value).toBe('D')
  })

  it('parses polychord C|G', () => {
    const c = parseChordSymbol('C|G')!
    expect(c.bass?.type).toBe('chord')
    if (c.bass?.type === 'chord') {
      expect(c.bass.value.root).toBe('G')
      expect(c.bass.value.quality).toBe('major')
    }
  })

  it('parses polychord with qualities Cmaj7|Dm', () => {
    const c = parseChordSymbol('Cmaj7|Dm')!
    if (c.bass?.type === 'chord') {
      expect(c.bass.value.root).toBe('D')
      expect(c.bass.value.quality).toBe('minor')
    }
  })
})

describe('parseChordSymbol — modal symbols', () => {
  it('parses "C Mixolydian"', () => {
    const c = parseChordSymbol('C Mixolydian')!
    expect(c.root).toBe('C')
    expect(c.modal).toBe('Mixolydian')
  })

  it('parses "F# Dorian"', () => {
    const c = parseChordSymbol('F# Dorian')!
    expect(c.root).toBe('F#')
    expect(c.modal).toBe('Dorian')
  })
})

describe('parseChordSymbol — robustness', () => {
  it('returns null for unparseable input', () => {
    expect(parseChordSymbol('')).toBeNull()
    expect(parseChordSymbol('   ')).toBeNull()
    expect(parseChordSymbol('Z')).toBeNull()
    expect(parseChordSymbol('xyz')).toBeNull()
  })

  it('parses chord with accidental root (Bb, F#)', () => {
    expect(parseChordSymbol('Bb')!.root).toBe('Bb')
    expect(parseChordSymbol('F#m7')!.root).toBe('F#')
  })

  it('stores the original input in display for round-trip fidelity', () => {
    expect(parseChordSymbol('Cmaj7♯11')?.display).toBeDefined()
  })
})

describe('formatChordSymbol — basic round-trip', () => {
  it('formats bare major as just the root', () => {
    expect(formatChordSymbol(parseChordSymbol('C')!)).toBe('C')
  })

  it('formats Cm', () => {
    expect(formatChordSymbol(parseChordSymbol('Cm')!)).toBe('Cm')
  })

  it('formats C7', () => {
    expect(formatChordSymbol(parseChordSymbol('C7')!)).toBe('C7')
  })

  it('formats Cmaj7', () => {
    expect(formatChordSymbol(parseChordSymbol('Cmaj7')!)).toBe('Cmaj7')
  })

  it('formats slash chord', () => {
    expect(formatChordSymbol(parseChordSymbol('C/E')!)).toBe('C/E')
  })

  it('formats polychord with pipe', () => {
    expect(formatChordSymbol(parseChordSymbol('C|G')!)).toBe('C|G')
  })

  it('formats with extension', () => {
    expect(formatChordSymbol(parseChordSymbol('C9')!)).toBe('C9')
    expect(formatChordSymbol(parseChordSymbol('Cmaj9')!)).toBe('Cmaj9')
  })

  it('formats with modal tag', () => {
    expect(formatChordSymbol(parseChordSymbol('C Mixolydian')!)).toBe('C Mixolydian')
  })
})

describe('chordSymbolsEqual', () => {
  it('returns true for identical chords (ignoring display)', () => {
    const a = parseChordSymbol('Cmaj7')!
    const b = parseChordSymbol('Cmaj7')!
    expect(chordSymbolsEqual(a, b)).toBe(true)
  })

  it('returns true regardless of extensions order', () => {
    const a: ChordSymbol = { root: 'C', quality: 'major', seventh: 'dom7', extensions: [9, 13] }
    const b: ChordSymbol = { root: 'C', quality: 'major', seventh: 'dom7', extensions: [13, 9] }
    expect(chordSymbolsEqual(a, b)).toBe(true)
  })

  it('returns false for different roots', () => {
    expect(chordSymbolsEqual(parseChordSymbol('C')!, parseChordSymbol('D')!)).toBe(false)
  })

  it('returns false for different qualities', () => {
    expect(chordSymbolsEqual(parseChordSymbol('C')!, parseChordSymbol('Cm')!)).toBe(false)
  })

  it('returns false for different sevenths', () => {
    expect(chordSymbolsEqual(parseChordSymbol('C7')!, parseChordSymbol('Cmaj7')!)).toBe(false)
  })
})

describe('ChordSymbolSchema validation', () => {
  it('parses every successful parseChordSymbol output through the schema', () => {
    const inputs = [
      'C',
      'Cm',
      'Cmaj7',
      'F#m7b5',
      'Cmaj7#11',
      'C7(b9,#11)',
      'C/E',
      'C|G',
      'C Mixolydian',
      'Cadd9',
      'C6',
      'Cdim7',
      'C°7',
      'Caug',
      'C7sus4',
      'Cm(maj7)',
      'C13',
      'C7alt',
    ]
    for (const s of inputs) {
      const c = parseChordSymbol(s)
      expect(c).not.toBeNull()
      expect(() => ChordSymbolSchema.parse(c)).not.toThrow()
    }
  })

  it('rejects an invalid root like Z', () => {
    expect(() =>
      ChordSymbolSchema.parse({ root: 'Z', quality: 'major', seventh: 'none' }),
    ).toThrow()
  })

  it('rejects an unknown quality enum value', () => {
    expect(() =>
      ChordSymbolSchema.parse({ root: 'C', quality: 'tetrad', seventh: 'none' }),
    ).toThrow()
  })
})
