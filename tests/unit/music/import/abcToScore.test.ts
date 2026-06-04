import { describe, it, expect } from 'vitest'
import { abcToScore } from '@/lib/music/import/abcToScore'
import { validateScore } from '@/lib/music/validateScore'

function abc(body: string, headers: Record<string, string> = {}): string {
  const h = {
    'X:': '1',
    'T:': 'Test',
    'M:': '4/4',
    'L:': '1/4',
    'K:': 'C',
    ...headers,
  }
  return `X:${h['X:']}\nT:${h['T:']}\nM:${h['M:']}\nL:${h['L:']}\nK:${h['K:']}\n${body}`
}

describe('abcToScore — multi-voice / multi-staff', () => {
  it('imports an SATB chorale (two staves, two voices each) end-to-end', () => {
    // %%score (S A) (T B): S+A on treble staff, T+B on bass staff.
    // 1 bar each = 4 quarters in 4/4. Voice content kept short.
    const source =
      'X:1\nT:SATB Test\nM:4/4\nL:1/4\n' +
      '%%score (S A) (T B)\n' +
      'V:S clef=treble\n' +
      'V:A clef=treble\n' +
      'V:T clef=bass\n' +
      'V:B clef=bass\n' +
      'K:C\n' +
      '[V:S] GAGE|\n' +
      '[V:A] EFED|\n' +
      '[V:T] cdcB,|\n' +
      '[V:B] C,D,E,C,|\n'
    const r = abcToScore(source)
    expect(r.warnings.filter((w) => w.severity === 'block')).toEqual([])
    expect(r.score.measures).toHaveLength(1)
    expect(r.score.extraVoices).toHaveLength(1)
    expect(r.score.secondStaff).toBeDefined()
    expect(r.score.secondStaff?.clef).toBe('bass')
    expect(r.score.secondStaff?.extraVoices).toHaveLength(1)
    // Validator runs as part of the import contract.
    validateScore(r.score)
  })

  it('imports piano grand staff (%%score (1 2) collapsed to one parsed staff) and promotes low voice to secondStaff', () => {
    // abcjs commonly collapses `%%score (1 2)` into a single staff
    // with two voices. Our heuristic promotes the lower voice to a
    // synthetic secondStaff with bass clef when the pitch gap is
    // wide enough (>18 semitones) and the low voice sits below middle C.
    const source =
      'X:1\nT:Piano Test\nM:4/4\nL:1/4\n' +
      '%%score (1 2)\n' +
      'V:1\n' +
      'V:2\n' +
      'K:C\n' +
      '[V:1] cdef|\n' +
      '[V:2] C,,D,,E,,F,,|\n'
    const r = abcToScore(source)
    expect(r.warnings.filter((w) => w.severity === 'block')).toEqual([])
    expect(r.score.secondStaff).toBeDefined()
    expect(r.score.secondStaff?.clef).toBe('bass')
    // Primary kept the top voice; secondStaff has the low voice.
    expect(r.score.measures[0].events[0].pitches[0].step).toBe('C')
    expect(r.score.measures[0].events[0].pitches[0].octave).toBe(5)
    expect(r.score.secondStaff?.measures[0].events[0].pitches[0].octave).toBe(2)
  })

  it('keeps polyphonic voices as extraVoices when the pitch range overlaps (not grand staff)', () => {
    // Two voices both in treble register: heuristic must NOT promote.
    const source =
      'X:1\nT:Polyphony Test\nM:4/4\nL:1/4\n' +
      '%%score (1 2)\n' +
      'V:1\n' +
      'V:2\n' +
      'K:C\n' +
      '[V:1] gabc\'|\n' +
      '[V:2] cdef|\n'
    const r = abcToScore(source)
    expect(r.warnings.filter((w) => w.severity === 'block')).toEqual([])
    expect(r.score.secondStaff).toBeUndefined()
    expect(r.score.extraVoices).toHaveLength(1)
  })

  it('round-trips an SATB score through abcToScore → scoreToAbc → abcToScore preserving staff/voice structure', async () => {
    const source =
      'X:1\nT:Roundtrip\nM:4/4\nL:1/4\n' +
      '%%score (S A) (T B)\n' +
      'V:S clef=treble\n' +
      'V:A clef=treble\n' +
      'V:T clef=bass\n' +
      'V:B clef=bass\n' +
      'K:C\n' +
      '[V:S] GAGE|\n' +
      '[V:A] EFED|\n' +
      '[V:T] cdcB,|\n' +
      '[V:B] C,D,E,C,|\n'
    const r = abcToScore(source)
    const { scoreToAbc } = await import('@/lib/music/scoreToAbc')
    const emitted = scoreToAbc(r.score)
    expect(emitted).toContain('%%score (1 2) (3 4)')
    const r2 = abcToScore(emitted)
    expect(r2.score.extraVoices).toHaveLength(1)
    expect(r2.score.secondStaff).toBeDefined()
    expect(r2.score.secondStaff?.extraVoices).toHaveLength(1)
  })

  it('warns with a structured info code instead of dropping voices', () => {
    const source =
      'X:1\nT:Two voices test\nM:4/4\nL:1/4\n' +
      '%%score (1 2)\n' +
      'V:1\n' +
      'V:2\n' +
      'K:C\n' +
      '[V:1] gabc\'|\n' +
      '[V:2] cdef|\n'
    const r = abcToScore(source)
    const infoCodes = r.warnings.filter((w) => w.severity === 'info').map((w) => w.code)
    expect(infoCodes).toContain('voice_picked')
    // Old "we dropped your voices" warnings should NOT appear: we
    // imported them as extraVoices now.
    expect(infoCodes).not.toContain('multi_voice')
  })
})

describe('abcToScore', () => {
  it('reads clef=bass from K: line and sets score.clef', () => {
    const r = abcToScore(abc('CDEF|GABc|', { 'K:': 'C clef=bass' }))
    expect(r.warnings.filter((w) => w.severity === 'block')).toEqual([])
    expect(r.score.clef).toBe('bass')
  })

  it('omits clef when K: has no clef directive (default treble)', () => {
    const r = abcToScore(abc('CDEF|GABc|'))
    expect(r.score.clef).toBeUndefined()
  })

  it('round-trips bass clef through abcToScore → scoreToAbc → abcToScore', async () => {
    const r = abcToScore(abc('CDEF|GABc|', { 'K:': 'C clef=bass' }))
    expect(r.score.clef).toBe('bass')
    const { scoreToAbc } = await import('@/lib/music/scoreToAbc')
    const emitted = scoreToAbc(r.score)
    expect(emitted).toContain('K:C clef=bass')
    const r2 = abcToScore(emitted)
    expect(r2.score.clef).toBe('bass')
  })

  it('parses a simple monophonic line', () => {
    const r = abcToScore(abc('CDEF|GABc|'))
    expect(r.warnings.filter((w) => w.severity === 'block')).toEqual([])
    expect(r.score.key).toBe('C')
    expect(r.score.meter).toBe('4/4')
    expect(r.score.measures).toHaveLength(2)
    expect(r.score.measures[0].events).toHaveLength(4)
    expect(r.score.measures[0].events[0].pitches[0]).toMatchObject({ step: 'C', octave: 4 })
    validateScore(r.score)
  })

  it('parses a chord stack', () => {
    const r = abcToScore(abc('[CEG]4|z4|'))
    expect(r.warnings.filter((w) => w.severity === 'block')).toEqual([])
    const first = r.score.measures[0].events[0]
    expect(first.pitches.map((p) => p.step)).toEqual(['C', 'E', 'G'])
    expect(first.duration).toBe('whole')
  })

  it('parses a triplet with tuplet=3', () => {
    // L:1/8 here so the quarter-time triplet (3 eighths in time of 2)
    // plus 3 quarters fills the 4/4 bar exactly: 3*(1*2/3)=2 + 3*2=6 → 8 eighths.
    const r = abcToScore(abc('(3CDE F2 G2 A2|', { 'L:': '1/8' }))
    expect(r.warnings.filter((w) => w.severity === 'block')).toEqual([])
    const events = r.score.measures[0].events
    const tupletEvents = events.filter((e) => e.tuplet === 3)
    expect(tupletEvents.length).toBe(3)
    validateScore(r.score)
  })

  it('handles accidentals as separate fields not merged into step', () => {
    const r = abcToScore(abc('^c2 _B2 =A2 z2|', { 'K:': 'C' }))
    const evs = r.score.measures[0].events
    expect(evs[0].pitches[0]).toMatchObject({ step: 'C', accidental: 'sharp' })
    expect(evs[1].pitches[0]).toMatchObject({ step: 'B', accidental: 'flat' })
    expect(evs[2].pitches[0]).toMatchObject({ step: 'A', accidental: 'natural' })
  })

  it('uses the abcjs title as the score title', () => {
    const r = abcToScore(abc('CDEF GABc|', { 'T:': 'My Tune' }))
    expect(r.score.title).toBe('My Tune')
  })

  it('honors a 6/8 meter', () => {
    const r = abcToScore(abc('CDE FGA|', { 'M:': '6/8', 'L:': '1/8' }))
    expect(r.score.meter).toBe('6/8')
    validateScore(r.score)
  })

  it('pads an anacrusis with leading rests', () => {
    // M:4/4 L:1/4 K:C — pickup is one quarter note (2 eighths), expects 8 eighths.
    const r = abcToScore(abc('G|CDEF|GABc|'))
    expect(r.warnings.some((w) => w.code === 'anacrusis_padded')).toBe(true)
    const restCount = r.score.measures[0].events.filter((e) => e.pitches[0].step === 'rest').length
    expect(restCount).toBeGreaterThan(0)
    validateScore(r.score)
  })

  it('returns a block warning for an unsupported modal key', () => {
    const r = abcToScore(abc('CDEF|', { 'K:': 'DDor' }))
    expect(r.warnings.some((w) => w.severity === 'block' && w.code === 'unsupported_mode')).toBe(true)
  })

  it('preserves a 5/4 meter on import', () => {
    const r = abcToScore(abc('CDEFG|', { 'M:': '5/4', 'L:': '1/4' }))
    expect(r.warnings.filter((w) => w.severity === 'block')).toEqual([])
    expect(r.score.meter).toBe('5/4')
    validateScore(r.score)
  })

  it('preserves a 7/8 meter on import', () => {
    const r = abcToScore(abc('CDEFGAB|', { 'M:': '7/8', 'L:': '1/8' }))
    expect(r.warnings.filter((w) => w.severity === 'block')).toEqual([])
    expect(r.score.meter).toBe('7/8')
    validateScore(r.score)
  })

  it('rejects an invalid n/d meter with a label-bearing message', () => {
    const r = abcToScore(abc('CDEF|', { 'M:': '5/3' }))
    const block = r.warnings.find((w) => w.severity === 'block' && w.code === 'unsupported_meter')
    expect(block).toBeDefined()
    expect(block!.message).toMatch(/5\/3/)
    expect(block!.message).toMatch(/numerator/)
    expect(block!.message).toMatch(/denominator/)
  })

  it('round-trips structurally through scoreToAbc + abcToScore', async () => {
    const original = abcToScore(abc('CDEF|GABc|'))
    const { scoreToAbc } = await import('@/lib/music/scoreToAbc')
    const reEmitted = scoreToAbc(original.score)
    const second = abcToScore(reEmitted)
    expect(second.warnings.filter((w) => w.severity === 'block')).toEqual([])
    expect(second.score.measures).toHaveLength(original.score.measures.length)
    expect(second.score.measures[0].events.length).toBe(
      original.score.measures[0].events.length,
    )
  })
})
