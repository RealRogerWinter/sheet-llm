import { describe, it, expect } from 'vitest'
import {
  INTRA_SYSTEM_PROMPT,
  buildEditScoreSchemaJson,
} from '@/lib/orchestrator/handlers/editIntraMeasure'
import type { Score } from '@/lib/music/types'

const simpleScore: Score = {
  key: 'C',
  meter: '4/4',
  measures: [
    {
      events: [
        { id: 'evtestid01', pitches: [{ step: 'C', octave: 4 }], duration: 'whole' },
      ],
    },
  ],
}

function getOpsItemProperties(): Record<string, unknown> {
  const schema = buildEditScoreSchemaJson(simpleScore) as {
    properties: { ops: { items: { properties: Record<string, unknown> } } }
  }
  return schema.properties.ops.items.properties
}

describe('INTRA_SYSTEM_PROMPT documents lyric ops (M15-PR-3)', () => {
  it('lists setLyric / removeLyric / clearLyrics in OPERATION KINDS', () => {
    expect(INTRA_SYSTEM_PROMPT).toContain('setLyric:')
    expect(INTRA_SYSTEM_PROMPT).toContain('removeLyric:')
    expect(INTRA_SYSTEM_PROMPT).toContain('clearLyrics:')
  })

  it('teaches hyphen + extender semantics + mutual exclusion in the doc', () => {
    expect(INTRA_SYSTEM_PROMPT).toMatch(/hyphen:true on every syllable EXCEPT the last/i)
    expect(INTRA_SYSTEM_PROMPT).toMatch(/extender/i)
    expect(INTRA_SYSTEM_PROMPT).toMatch(/mutually exclusive/i)
  })

  it('warns about whitespace + backslash rejection at the op layer', () => {
    expect(INTRA_SYSTEM_PROMPT).toMatch(/whitespace-only rejected/i)
    expect(INTRA_SYSTEM_PROMPT).toMatch(/backslashes stripped/i)
  })

  it('includes worked example for Amazing Grace lyrics', () => {
    // The s/dotall flag is ES2018+; use [\s\S] to portably match newlines.
    expect(INTRA_SYSTEM_PROMPT).toMatch(/"kind":"setLyric"[\s\S]*"syllable":"A"[\s\S]*"hyphen":true/)
  })

  it('includes worked example for multi-verse stacking (verse:2)', () => {
    expect(INTRA_SYSTEM_PROMPT).toMatch(/"verse":2/)
  })

  it('includes worked example for clearLyrics', () => {
    expect(INTRA_SYSTEM_PROMPT).toContain('"kind":"clearLyrics"')
  })
})

describe('buildEditScoreSchemaJson lyric op-bag fields (M15-PR-3)', () => {
  it('exposes verse with bounds 1..50', () => {
    const props = getOpsItemProperties()
    const verse = props.verse as { type: string; minimum: number; maximum: number }
    expect(verse.type).toBe('integer')
    expect(verse.minimum).toBe(1)
    expect(verse.maximum).toBe(50)
  })

  it('exposes syllable with maxLength 40', () => {
    const props = getOpsItemProperties()
    const syllable = props.syllable as { type: string; minLength: number; maxLength: number }
    expect(syllable.type).toBe('string')
    expect(syllable.minLength).toBe(1)
    expect(syllable.maxLength).toBe(40)
  })

  it('exposes hyphen + extender as booleans', () => {
    const props = getOpsItemProperties()
    const hyphen = props.hyphen as { type: string }
    const extender = props.extender as { type: string }
    expect(hyphen.type).toBe('boolean')
    expect(extender.type).toBe('boolean')
  })
})
