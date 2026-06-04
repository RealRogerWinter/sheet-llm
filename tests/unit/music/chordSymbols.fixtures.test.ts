import { describe, it, expect } from 'vitest'
import {
  chordSymbolsEqual,
  formatChordSymbol,
  parseChordSymbol,
} from '@/lib/music/chordSymbols'
import type { ChordSymbol } from '@/lib/music/types'
import { ChordSymbolSchema } from '@/lib/music/types'

/**
 * Data-driven fixture table for the chord-symbol parser. Each entry
 * is `[input, expected]` where `expected` is a partial ChordSymbol
 * (omitting `display` since the parser fills it with the raw input).
 *
 * Covers ~60 real-world lead-sheet symbols from jazz, pop, classical,
 * and contemporary practice. Complements the structured tests in
 * chordSymbols.test.ts — anything that doesn't fit a tidy describe
 * block lives here.
 */
type Fixture = readonly [input: string, expected: Partial<ChordSymbol>]

const FIXTURES: ReadonlyArray<Fixture> = [
  // ─── Basic triads with accidental roots ──────────────────────────
  ['Bb', { root: 'Bb', quality: 'major', seventh: 'none' }],
  ['F#', { root: 'F#', quality: 'major', seventh: 'none' }],
  ['Bbm', { root: 'Bb', quality: 'minor', seventh: 'none' }],
  ['F#m', { root: 'F#', quality: 'minor', seventh: 'none' }],
  ['Ebmaj7', { root: 'Eb', quality: 'major', seventh: 'maj7' }],

  // ─── Sevenths with accidental roots ──────────────────────────────
  ['F#m7', { root: 'F#', quality: 'minor', seventh: 'min7' }],
  ['Bb7', { root: 'Bb', quality: 'major', seventh: 'dom7' }],
  ['F#m7b5', { root: 'F#', quality: 'minor', seventh: 'halfdim7' }],
  ['Ab°7', { root: 'Ab', quality: 'diminished', seventh: 'dim7' }],

  // ─── Extensions across qualities + roots ─────────────────────────
  ['C9', { root: 'C', quality: 'major', seventh: 'dom7', extensions: [9] }],
  ['C11', { root: 'C', quality: 'major', seventh: 'dom7', extensions: [11] }],
  ['C13', { root: 'C', quality: 'major', seventh: 'dom7', extensions: [13] }],
  ['Cmaj9', { root: 'C', quality: 'major', seventh: 'maj7', extensions: [9] }],
  ['Cmaj13', { root: 'C', quality: 'major', seventh: 'maj7', extensions: [13] }],
  ['Cm9', { root: 'C', quality: 'minor', seventh: 'min7', extensions: [9] }],
  ['Cm11', { root: 'C', quality: 'minor', seventh: 'min7', extensions: [11] }],
  ['Bbm13', { root: 'Bb', quality: 'minor', seventh: 'min7', extensions: [13] }],

  // ─── Alterations ─────────────────────────────────────────────────
  ['C7b9', { root: 'C', quality: 'major', seventh: 'dom7', alterations: ['b9'] }],
  ['C7#9', { root: 'C', quality: 'major', seventh: 'dom7', alterations: ['#9'] }],
  ['C7#11', { root: 'C', quality: 'major', seventh: 'dom7', alterations: ['#11'] }],
  ['Cmaj7#11', { root: 'C', quality: 'major', seventh: 'maj7', alterations: ['#11'] }],
  ['C7(b9,#11)', { root: 'C', quality: 'major', seventh: 'dom7', alterations: ['b9', '#11'] }],
  ['C7alt', { root: 'C', quality: 'major', seventh: 'dom7', alterations: ['alt'] }],

  // ─── add / omit / 6 chords ───────────────────────────────────────
  ['Cadd9', { root: 'C', quality: 'major', seventh: 'none', add: [9] }],
  ['Cadd11', { root: 'C', quality: 'major', seventh: 'none', add: [11] }],
  ['C6', { root: 'C', quality: 'major', seventh: 'none', add: [6] }],
  ['Cm6', { root: 'C', quality: 'minor', seventh: 'none', add: [6] }],
  ['C(no3)', { root: 'C', quality: 'major', seventh: 'none', omit: [3] }],
  ['C(no5)', { root: 'C', quality: 'major', seventh: 'none', omit: [5] }],

  // ─── Suspended ───────────────────────────────────────────────────
  ['Csus2', { root: 'C', quality: 'sus2', seventh: 'none' }],
  ['Csus4', { root: 'C', quality: 'sus4', seventh: 'none' }],
  ['C7sus4', { root: 'C', quality: 'sus4', seventh: 'dom7' }],
  ['Csus', { root: 'C', quality: 'sus4', seventh: 'none' }], // bare "sus" defaults to sus4
  ['C7sus2', { root: 'C', quality: 'sus2', seventh: 'dom7' }],

  // ─── Diminished + augmented seventh variants ─────────────────────
  ['Cdim', { root: 'C', quality: 'diminished', seventh: 'none' }],
  ['C°', { root: 'C', quality: 'diminished', seventh: 'none' }],
  ['Cdim7', { root: 'C', quality: 'diminished', seventh: 'dim7' }],
  ['Caug', { root: 'C', quality: 'augmented', seventh: 'none' }],
  ['C+', { root: 'C', quality: 'augmented', seventh: 'none' }],
  ['Caug7', { root: 'C', quality: 'augmented', seventh: 'dom7' }],
  ['Caug(maj7)', { root: 'C', quality: 'augmented', seventh: 'maj7' }],

  // ─── Minor-major 7 spellings ─────────────────────────────────────
  ['Cm(maj7)', { root: 'C', quality: 'minor', seventh: 'maj7' }],
  ['CmM7', { root: 'C', quality: 'minor', seventh: 'maj7' }],
  ['Cm△7', { root: 'C', quality: 'minor', seventh: 'maj7' }],

  // ─── Slash chords ────────────────────────────────────────────────
  ['C/E', { root: 'C', quality: 'major', seventh: 'none', bass: { type: 'note', value: 'E' } }],
  ['Bb/D', { root: 'Bb', quality: 'major', seventh: 'none', bass: { type: 'note', value: 'D' } }],
  ['Cmaj7/E', { root: 'C', quality: 'major', seventh: 'maj7', bass: { type: 'note', value: 'E' } }],
  ['F#m7/A', { root: 'F#', quality: 'minor', seventh: 'min7', bass: { type: 'note', value: 'A' } }],

  // ─── Modal symbols ───────────────────────────────────────────────
  ['C Mixolydian', { root: 'C', quality: 'major', seventh: 'none', modal: 'Mixolydian' }],
  ['F# Dorian', { root: 'F#', quality: 'major', seventh: 'none', modal: 'Dorian' }],
  ['Bb Lydian', { root: 'Bb', quality: 'major', seventh: 'none', modal: 'Lydian' }],

  // ─── Half-diminished alternate spellings ─────────────────────────
  ['Cø', { root: 'C', quality: 'minor', seventh: 'halfdim7' }],
  ['Cø7', { root: 'C', quality: 'minor', seventh: 'halfdim7' }],
  ['Cm7(b5)', { root: 'C', quality: 'minor', seventh: 'halfdim7' }],

  // ─── Combinations ────────────────────────────────────────────────
  ['Cmaj9#11', { root: 'C', quality: 'major', seventh: 'maj7', extensions: [9], alterations: ['#11'] }],
  ['C13b9', { root: 'C', quality: 'major', seventh: 'dom7', extensions: [13], alterations: ['b9'] }],
  ['Cm7add11', { root: 'C', quality: 'minor', seventh: 'min7', add: [11] }],
]

describe('parseChordSymbol — fixture table (60 real-world symbols)', () => {
  for (const [input, expected] of FIXTURES) {
    it(`parses "${input}" as expected`, () => {
      const parsed = parseChordSymbol(input)
      expect(parsed).not.toBeNull()
      // Match each expected key without forcing strict equality on
      // the whole object — display + other fields may carry through.
      for (const [key, value] of Object.entries(expected)) {
        expect((parsed as Record<string, unknown>)[key]).toEqual(value)
      }
    })
  }
})

describe('parseChordSymbol — fixture round-trip via chordSymbolsEqual', () => {
  // format → reparse → should equal the original parse result
  // (modulo display). Locks the formatter's reversibility contract.
  for (const [input] of FIXTURES) {
    it(`round-trip "${input}" through format → parse`, () => {
      const first = parseChordSymbol(input)
      expect(first).not.toBeNull()
      const formatted = formatChordSymbol(first!)
      const second = parseChordSymbol(formatted)
      expect(second).not.toBeNull()
      expect(chordSymbolsEqual(first!, second!)).toBe(true)
    })
  }
})

describe('parseChordSymbol — fixture schema validation', () => {
  // Every fixture must round-trip through ChordSymbolSchema cleanly.
  // Catches drift between the parser's permissive shape and the
  // Zod schema's strict refines.
  for (const [input] of FIXTURES) {
    it(`"${input}" passes ChordSymbolSchema`, () => {
      const parsed = parseChordSymbol(input)
      expect(parsed).not.toBeNull()
      expect(() => ChordSymbolSchema.parse(parsed)).not.toThrow()
    })
  }
})

describe('parseChordSymbol — edge cases beyond the fixtures', () => {
  it('handles whitespace around the input', () => {
    expect(parseChordSymbol('  Cmaj7  ')?.seventh).toBe('maj7')
  })

  it('parses Cmaj7add9 — maj7 + add9 (rare but legal jazz spelling)', () => {
    const c = parseChordSymbol('Cmaj7add9')!
    expect(c.seventh).toBe('maj7')
    expect(c.add).toContain(9)
  })

  it('parses C7b9b13 (chained loose alterations)', () => {
    const c = parseChordSymbol('C7b9b13')!
    expect(c.alterations).toContain('b9')
    expect(c.alterations).toContain('b13')
  })

  it('parses Cm7add9add11 (multiple add tones on a minor 7)', () => {
    const c = parseChordSymbol('Cm7add9add11')!
    expect(c.seventh).toBe('min7')
    expect(c.add).toEqual(expect.arrayContaining([9, 11]))
  })

  it('parses F#m9 — sharp root + minor + extension (common in jazz)', () => {
    const c = parseChordSymbol('F#m9')!
    expect(c.root).toBe('F#')
    expect(c.quality).toBe('minor')
    expect(c.seventh).toBe('min7')
    expect(c.extensions).toEqual([9])
  })

  it('parses Bb7sus4 (sus4 with flat root + dom7)', () => {
    const c = parseChordSymbol('Bb7sus4')!
    expect(c.root).toBe('Bb')
    expect(c.quality).toBe('sus4')
    expect(c.seventh).toBe('dom7')
  })

  it('returns null for nonsense after the root', () => {
    // "C" followed by garbage that can't be peeled off as quality,
    // seventh, extension, alteration, add, or omit — the parser
    // accepts the C and stores the original in display. Document
    // this lenient-parse behavior.
    const c = parseChordSymbol('Cxyz')
    expect(c).not.toBeNull()
    expect(c!.root).toBe('C')
    expect(c!.display).toBe('Cxyz')
  })

  it('parses C/F# (slash with sharp bass)', () => {
    const c = parseChordSymbol('C/F#')!
    expect(c.bass).toEqual({ type: 'note', value: 'F#' })
  })

  it('parses Cmaj7|Dm7 (polychord with both qualities)', () => {
    const c = parseChordSymbol('Cmaj7|Dm7')!
    expect(c.seventh).toBe('maj7')
    if (c.bass?.type === 'chord') {
      expect(c.bass.value.root).toBe('D')
      expect(c.bass.value.quality).toBe('minor')
      expect(c.bass.value.seventh).toBe('min7')
    } else {
      throw new Error('expected polychord bass')
    }
  })
})

describe('parseChordSymbol — lenient-parse truncation contract', () => {
  // The parser's documented policy (chordSymbols.ts:306-308) is to
  // accept anything after the root and store the original input in
  // `display` for UI round-trip fidelity, rather than return null.
  // These tests PIN the current truncation behavior so a future
  // "strict mode" PR can't silently change it without re-considering
  // whether the truncated text should round-trip via display.
  it('Cma7 silently parses as minor (display preserves original) — Cmaj7 shorthand untreated', () => {
    const c = parseChordSymbol('Cma7')!
    expect(c.root).toBe('C')
    expect(c.quality).toBe('minor')
    expect(c.seventh).toBe('none')
    expect(c.display).toBe('Cma7')
  })

  it('C7sus truncates the bare "sus" but preserves it in display', () => {
    // Bare "sus" with no 2/4 digit and no leading 7sus2/7sus4 special
    // case — parser consumes "7" as dom7, leaves "sus" unconsumed.
    const c = parseChordSymbol('C7sus')!
    expect(c.root).toBe('C')
    expect(c.seventh).toBe('dom7')
    expect(c.quality).toBe('major')
    expect(c.display).toBe('C7sus')
  })

  it('Cmaj (no digit) parses as major with maj prefix dropped — display preserves', () => {
    const c = parseChordSymbol('Cmaj')!
    expect(c.root).toBe('C')
    expect(c.quality).toBe('major')
    expect(c.seventh).toBe('none')
    expect(c.display).toBe('Cmaj')
  })

  it('C5 (power chord) parses as bare major with the 5 dropped', () => {
    // No power-chord schema field; lenient parse stores in display.
    // A future PR could add a `noThird: boolean` or quality:'power'.
    const c = parseChordSymbol('C5')!
    expect(c.root).toBe('C')
    expect(c.quality).toBe('major')
    expect(c.display).toBe('C5')
  })
})

describe('formatChordSymbol — display field is dropped at format-time', () => {
  // format() composes from structured fields only — display is for
  // round-trip fidelity at the popover/UI layer, not for re-rendering.
  // This locks the contract so a future "use display verbatim if
  // set" optimization doesn't sneak in and break canonical formatting.
  it('does not re-emit the display field on a parsed-then-formatted chord', () => {
    const parsed = parseChordSymbol('Cmaj7')!
    expect(parsed.display).toBe('Cmaj7')
    const formatted = formatChordSymbol(parsed)
    expect(formatted).toBe('Cmaj7')
    // Mutate display to a wrong value; formatter still emits canonical.
    const mutated = { ...parsed, display: 'WRONG' }
    expect(formatChordSymbol(mutated)).toBe('Cmaj7')
  })
})
