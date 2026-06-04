import { describe, it, expect } from 'vitest'
import { OCTAVE_SPAN_KINDS } from '@/lib/music/spans'
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

describe('INTRA_SYSTEM_PROMPT documents M20 span ops (M20-PR-3)', () => {
  it('lists 12 new span ops in OPERATION KINDS', () => {
    expect(INTRA_SYSTEM_PROMPT).toContain('insertOctaveSpan:')
    expect(INTRA_SYSTEM_PROMPT).toContain('removeOctaveSpan:')
    expect(INTRA_SYSTEM_PROMPT).toContain('updateOctaveSpan:')
    expect(INTRA_SYSTEM_PROMPT).toContain('insertGlissando:')
    expect(INTRA_SYSTEM_PROMPT).toContain('removeGlissando:')
    expect(INTRA_SYSTEM_PROMPT).toContain('updateGlissando:')
    expect(INTRA_SYSTEM_PROMPT).toContain('insertTrillLine:')
    expect(INTRA_SYSTEM_PROMPT).toContain('removeTrillLine:')
    expect(INTRA_SYSTEM_PROMPT).toContain('updateTrillLine:')
    expect(INTRA_SYSTEM_PROMPT).toContain('insertTremoloBetween:')
    expect(INTRA_SYSTEM_PROMPT).toContain('removeTremoloBetween:')
    expect(INTRA_SYSTEM_PROMPT).toContain('updateTremoloBetween:')
  })

  it('clarifies 8va vs 8vb meaning (kind axis)', () => {
    expect(INTRA_SYSTEM_PROMPT).toMatch(/ottava alta/i)
    expect(INTRA_SYSTEM_PROMPT).toMatch(/ottava bassa/i)
  })

  it('distinguishes insertTremoloBetween (between-note) from Event.tremolo (single-note)', () => {
    expect(INTRA_SYSTEM_PROMPT).toMatch(/SINGLE-NOTE.*M2-PR-1|Event\.tremolo/)
    expect(INTRA_SYSTEM_PROMPT).toMatch(/BETWEEN-TWO-NOTES|fingered.*tremolo/i)
  })

  it('includes worked examples for each new family', () => {
    expect(INTRA_SYSTEM_PROMPT).toMatch(/"kind":"insertOctaveSpan"[\s\S]*"kind":"8va"/)
    expect(INTRA_SYSTEM_PROMPT).toMatch(/"kind":"insertGlissando"/)
    expect(INTRA_SYSTEM_PROMPT).toMatch(/"kind":"insertTrillLine"/)
    expect(INTRA_SYSTEM_PROMPT).toMatch(/"kind":"insertTremoloBetween"/)
  })

  it('trill-line worked example pairs setOrnament + insertTrillLine', () => {
    expect(INTRA_SYSTEM_PROMPT).toMatch(/"kind":"setOrnament"[\s\S]*"ornament":"trill"[\s\S]*"kind":"insertTrillLine"/)
  })
})

describe('buildEditScoreSchemaJson — octaveSpan payload (M20-PR-3)', () => {
  it('exposes octaveSpan with the 4 required fields and 3 optional', () => {
    const props = getOpsItemProperties()
    const oct = props.octaveSpan as {
      type: string
      required: string[]
      properties: Record<string, unknown>
    }
    expect(oct.type).toBe('object')
    expect(oct.required).toEqual(['kind', 'startEventId', 'endEventId'])
    expect(oct.properties.staffIdx).toBeDefined()
    expect(oct.properties.voiceIdx).toBeDefined()
    expect(oct.properties.placement).toBeDefined()
  })

  it('kind enum equals OCTAVE_SPAN_KINDS source-of-truth (strict union)', () => {
    const props = getOpsItemProperties()
    const oct = props.octaveSpan as {
      properties: { kind: { enum: string[] } }
    }
    expect(oct.properties.kind.enum).toEqual([...OCTAVE_SPAN_KINDS])
  })

  it('placement enum is above|below|default', () => {
    const props = getOpsItemProperties()
    const oct = props.octaveSpan as {
      properties: { placement: { enum: string[] } }
    }
    expect(oct.properties.placement.enum).toEqual(['above', 'below', 'default'])
  })
})

describe('buildEditScoreSchemaJson — glissando payload (M20-PR-3)', () => {
  it('exposes glissando with only startEventId + endEventId required (single-kind family)', () => {
    const props = getOpsItemProperties()
    const gliss = props.glissando as {
      type: string
      required: string[]
      properties: Record<string, unknown>
    }
    expect(gliss.type).toBe('object')
    expect(gliss.required).toEqual(['startEventId', 'endEventId'])
    expect(gliss.properties.glissStyle).toBeDefined()
    expect(gliss.properties.glissText).toBeDefined()
  })

  it('glissStyle enum is straight|wavy', () => {
    const props = getOpsItemProperties()
    const gliss = props.glissando as {
      properties: { glissStyle: { enum: string[] } }
    }
    expect(gliss.properties.glissStyle.enum).toEqual(['straight', 'wavy'])
  })

  it('glissText is boolean', () => {
    const props = getOpsItemProperties()
    const gliss = props.glissando as {
      properties: { glissText: { type: string } }
    }
    expect(gliss.properties.glissText.type).toBe('boolean')
  })
})

describe('buildEditScoreSchemaJson — trillLine payload (M20-PR-3)', () => {
  it('exposes trillLine with only startEventId + endEventId required', () => {
    const props = getOpsItemProperties()
    const trill = props.trillLine as {
      type: string
      required: string[]
      properties: Record<string, unknown>
    }
    expect(trill.type).toBe('object')
    expect(trill.required).toEqual(['startEventId', 'endEventId'])
    expect(trill.properties.placement).toBeDefined()
  })
})

describe('buildEditScoreSchemaJson — tremoloBetween payload (M20-PR-3)', () => {
  it('exposes tremoloBetween with only startEventId + endEventId required', () => {
    const props = getOpsItemProperties()
    const trem = props.tremoloBetween as {
      type: string
      required: string[]
      properties: Record<string, unknown>
    }
    expect(trem.type).toBe('object')
    expect(trem.required).toEqual(['startEventId', 'endEventId'])
    expect(trem.properties.placement).toBeDefined()
  })
})

describe('buildEditScoreSchemaJson — shared patch carries glissando-specific fields (M20-PR-3)', () => {
  it('patch exposes glissStyle and glissText (with null clear semantics)', () => {
    const props = getOpsItemProperties()
    const patch = props.patch as {
      properties: {
        glissStyle: { enum: (string | null)[] }
        glissText: { type: (string | null)[] | string }
      }
    }
    expect(patch.properties.glissStyle.enum).toEqual(['straight', 'wavy', null])
    expect(patch.properties.glissText.type).toEqual(['boolean', 'null'])
  })
})
