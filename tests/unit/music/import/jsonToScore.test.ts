import { describe, it, expect } from 'vitest'
import { jsonToScore } from '@/lib/music/import/jsonToScore'

const VALID = {
  title: 'Test',
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
  ],
}

describe('jsonToScore', () => {
  it('parses a valid Score JSON string', () => {
    const r = jsonToScore(JSON.stringify(VALID))
    expect(r.format).toBe('json')
    expect(r.warnings).toEqual([])
    expect(r.score.title).toBe('Test')
    expect(r.score.measures).toHaveLength(1)
  })

  it('accepts a pre-parsed object directly', () => {
    const r = jsonToScore(VALID)
    expect(r.warnings).toEqual([])
    expect(r.score.measures).toHaveLength(1)
  })

  it('returns a block warning on malformed JSON', () => {
    const r = jsonToScore('{ not valid')
    expect(r.warnings.length).toBeGreaterThan(0)
    expect(r.warnings.some((w) => w.severity === 'block' && w.code === 'parse_failed')).toBe(true)
  })

  it('returns a block warning on schema violation', () => {
    const bad = { ...VALID, key: 'Z' as unknown as 'C' }
    const r = jsonToScore(bad)
    expect(r.warnings.some((w) => w.severity === 'block' && w.code === 'schema_invalid')).toBe(true)
  })
})
