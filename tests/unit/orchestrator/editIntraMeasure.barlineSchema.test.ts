import { describe, it, expect } from 'vitest'
import {
  INTRA_SYSTEM_PROMPT,
  buildEditScoreSchemaJson,
} from '@/lib/orchestrator/handlers/editIntraMeasure'
import { BARLINE_KINDS, type Score } from '@/lib/music/types'

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

describe('INTRA_SYSTEM_PROMPT documents barline ops (M16-PR-3)', () => {
  it('lists setStartBarline / setEndBarline / setPickup / setFinalPartial in OPERATION KINDS', () => {
    expect(INTRA_SYSTEM_PROMPT).toContain('setStartBarline:')
    expect(INTRA_SYSTEM_PROMPT).toContain('setEndBarline:')
    expect(INTRA_SYSTEM_PROMPT).toContain('setPickup:')
    expect(INTRA_SYSTEM_PROMPT).toContain('setFinalPartial:')
  })

  it('references all 8 barline kinds in the setStartBarline doc', () => {
    for (const kind of ['thin', 'double', 'final', 'repeat-start', 'repeat-end', 'repeat-both', 'invisible', 'dashed']) {
      expect(INTRA_SYSTEM_PROMPT).toContain(kind)
    }
  })

  it('includes the repeat-block worked example', () => {
    expect(INTRA_SYSTEM_PROMPT).toMatch(/"kind":"setStartBarline"[\s\S]*"repeat-start"/)
    expect(INTRA_SYSTEM_PROMPT).toMatch(/"kind":"setEndBarline"[\s\S]*"repeat-end"/)
  })

  it('includes the final-barline worked example', () => {
    expect(INTRA_SYSTEM_PROMPT).toMatch(/"kind":"setEndBarline"[\s\S]*"final"/)
  })

  it('includes the pickup worked example', () => {
    expect(INTRA_SYSTEM_PROMPT).toMatch(/"kind":"setPickup"/)
    expect(INTRA_SYSTEM_PROMPT).toMatch(/"isPickup":true/)
  })

  it('points readers to BARLINES_REFERENCE for the full vocabulary', () => {
    expect(INTRA_SYSTEM_PROMPT).toMatch(/BARLINES_REFERENCE/)
  })
})

describe('buildEditScoreSchemaJson barline op-bag fields (M16-PR-3)', () => {
  it('barline enum equals BARLINE_KINDS (source-of-truth strict union)', () => {
    // Same strict-union pattern as the renderScoreTool.barlines
    // test — both files now lock against BARLINE_KINDS. Adding a
    // 9th kind to BarlineSchema requires updating both schemas
    // (or both pins fail).
    const props = getOpsItemProperties()
    const barline = props.barline as { type: string; enum: string[] }
    expect(barline.type).toBe('string')
    expect(barline.enum).toEqual([...BARLINE_KINDS])
  })

  it('exposes isPickup + isFinalPartial as booleans', () => {
    const props = getOpsItemProperties()
    const isPickup = props.isPickup as { type: string }
    const isFinalPartial = props.isFinalPartial as { type: string }
    expect(isPickup.type).toBe('boolean')
    expect(isFinalPartial.type).toBe('boolean')
  })
})
