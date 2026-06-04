import { describe, it, expect } from 'vitest'
import { EngravingDefaultsSchema, ScoreSchema } from '@/lib/music/types'
import { validateScore } from '@/lib/music/validateScore'

describe('EngravingDefaultsSchema', () => {
  it('accepts an empty defaults object (all fields optional)', () => {
    expect(() => EngravingDefaultsSchema.parse({})).not.toThrow()
  })

  it('applies dynamicsPosition default of auto-by-staff', () => {
    const d = EngravingDefaultsSchema.parse({})
    expect(d.dynamicsPosition).toBe('auto-by-staff')
  })

  it('accepts a fully-populated defaults object', () => {
    expect(() =>
      EngravingDefaultsSchema.parse({
        dynamicsPosition: 'below',
        dynamicsStyle: 'italic-bold',
        tempoTextFont: 'bold-roman',
        tempoTextPlacement: 'above',
        rehearsalMarkStyle: 'rectangle',
        editorialAccidentalBrackets: 'square',
        cautionaryAccidentalPolicy: 'across-barline-only',
        beamSlopeRule: 'european-flat',
        stemLengthDefault: 3.5,
        slurThickness: 1.2,
        slurCurvature: 0.6,
        tieThickness: 1.0,
        tieCurvature: 0.4,
        tupletBracketStyle: 'bracket',
        tupletNumberStyle: 'italic',
        firstSystemIndent: 4,
        subsequentSystemIndent: 0,
        multiRestHBarStyle: 'thick',
        tempoTermsLanguage: 'italian',
        chordSymbolStyle: 'jazz',
        lyricFontScale: 90,
        courtesyTimeSignatures: true,
        courtesyKeySignatures: true,
        cancelNaturalsOnKeyChange: true,
        beamingPolicy: 'by-beat',
        pageLayoutMode: 'page',
        maxMeasuresPerSystem: 8,
        graceNoteCueSize: true,
      }),
    ).not.toThrow()
  })

  it('rejects out-of-range numeric values', () => {
    expect(() => EngravingDefaultsSchema.parse({ stemLengthDefault: 1 })).toThrow()
    expect(() => EngravingDefaultsSchema.parse({ stemLengthDefault: 10 })).toThrow()
    expect(() => EngravingDefaultsSchema.parse({ lyricFontScale: 49 })).toThrow()
    expect(() => EngravingDefaultsSchema.parse({ lyricFontScale: 201 })).toThrow()
    expect(() => EngravingDefaultsSchema.parse({ maxMeasuresPerSystem: 0 })).toThrow()
    expect(() => EngravingDefaultsSchema.parse({ maxMeasuresPerSystem: 33 })).toThrow()
  })

  it('rejects unknown enum values', () => {
    expect(() => EngravingDefaultsSchema.parse({ dynamicsPosition: 'inside' })).toThrow()
    expect(() => EngravingDefaultsSchema.parse({ rehearsalMarkStyle: 'oval' })).toThrow()
    expect(() => EngravingDefaultsSchema.parse({ beamSlopeRule: 'flat' })).toThrow()
    expect(() => EngravingDefaultsSchema.parse({ tempoTermsLanguage: 'spanish' })).toThrow()
  })

  it('accepts partial subsets (just dynamics overrides, for example)', () => {
    expect(() =>
      EngravingDefaultsSchema.parse({ dynamicsPosition: 'below', dynamicsStyle: 'italic-bold' }),
    ).not.toThrow()
  })

  it("accepts dynamicsPosition: 'hidden' (suppress glyphs entirely)", () => {
    const d = EngravingDefaultsSchema.parse({ dynamicsPosition: 'hidden' })
    expect(d.dynamicsPosition).toBe('hidden')
  })
})

describe('Score.engravingDefaults', () => {
  it('accepts a score with engravingDefaults set', () => {
    expect(() =>
      ScoreSchema.parse({
        key: 'C',
        meter: '4/4',
        measures: [
          {
            events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }],
          },
        ],
        engravingDefaults: {
          dynamicsPosition: 'below',
          beamSlopeRule: 'european-flat',
          tempoTermsLanguage: 'italian',
        },
      }),
    ).not.toThrow()
  })

  it('back-compat: legacy score without engravingDefaults validates', () => {
    expect(() =>
      validateScore({
        key: 'C',
        meter: '4/4',
        measures: [
          {
            events: [{ pitches: [{ step: 'C', octave: 4 }], duration: 'whole' }],
          },
        ],
      }),
    ).not.toThrow()
  })

  it('full-score round-trip with comprehensive engravingDefaults', () => {
    const score = {
      key: 'C' as const,
      meter: '4/4',
      measures: [
        {
          events: [{ pitches: [{ step: 'C' as const, octave: 4 }], duration: 'whole' as const }],
        },
      ],
      composer: 'Test',
      engravingDefaults: {
        dynamicsPosition: 'auto-by-staff' as const,
        rehearsalMarkStyle: 'rectangle' as const,
        cautionaryAccidentalPolicy: 'across-barline-only' as const,
        beamSlopeRule: 'european-flat' as const,
        tempoTermsLanguage: 'italian' as const,
        chordSymbolStyle: 'jazz' as const,
        cancelNaturalsOnKeyChange: true,
      },
    }
    expect(() => validateScore(score)).not.toThrow()
  })
})
