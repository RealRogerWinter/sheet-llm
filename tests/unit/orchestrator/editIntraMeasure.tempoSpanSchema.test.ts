import { describe, it, expect } from 'vitest'
import {
  HAIRPIN_KINDS,
  JUMP_KINDS,
  OCTAVE_SPAN_KINDS,
  SLUR_KINDS,
  TEMPO_SPAN_KINDS,
} from '@/lib/music/spans'
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

describe('INTRA_SYSTEM_PROMPT documents tempo-span ops (M14-PR-3)', () => {
  it('lists insertTempoSpan / removeTempoSpan / updateTempoSpan in OPERATION KINDS', () => {
    expect(INTRA_SYSTEM_PROMPT).toContain('insertTempoSpan:')
    expect(INTRA_SYSTEM_PROMPT).toContain('removeTempoSpan:')
    expect(INTRA_SYSTEM_PROMPT).toContain('updateTempoSpan:')
  })

  it('explains both tempo-span kinds (accel / rit) in the prompt', () => {
    expect(INTRA_SYSTEM_PROMPT).toContain('"accel"')
    expect(INTRA_SYSTEM_PROMPT).toContain('"rit"')
  })

  it('explains the terminal label fields (endTempoBpm + endTempoText)', () => {
    expect(INTRA_SYSTEM_PROMPT).toContain('endTempoBpm')
    expect(INTRA_SYSTEM_PROMPT).toContain('endTempoText')
  })

  it('distinguishes tempo-span from Marker.tempo_bpm in prompt text', () => {
    // The "Distinct from a sibling Marker with tempo_bpm" note exists
    // so the LLM understands when to emit a span vs. a marker.
    expect(INTRA_SYSTEM_PROMPT).toMatch(/distinct from.*Marker.*tempo_bpm|Marker.*tempo_bpm.*distinct/i)
  })

  it('includes worked examples for insertTempoSpan', () => {
    expect(INTRA_SYSTEM_PROMPT).toContain('"kind":"insertTempoSpan"')
    // At least one example with endTempoBpm and one with endTempoText
    expect(INTRA_SYSTEM_PROMPT).toMatch(/"endTempoBpm":\d+/)
    expect(INTRA_SYSTEM_PROMPT).toContain('"endTempoText":"a tempo"')
  })
})

describe('buildEditScoreSchemaJson tempoSpan payload (M14-PR-3)', () => {
  it('exposes a `tempoSpan` op-bag slot with required endpoint ids', () => {
    const props = getOpsItemProperties()
    const tempoSpan = props.tempoSpan as {
      type: string
      required: string[]
      properties: Record<string, { enum?: string[] }>
    }
    expect(tempoSpan.type).toBe('object')
    expect(tempoSpan.required).toEqual(['kind', 'startEventId', 'endEventId'])
    expect(tempoSpan.properties.startEventId).toEqual({ type: 'string' })
    expect(tempoSpan.properties.endEventId).toEqual({ type: 'string' })
  })

  it('TEMPO kind enum in the wire schema stays in sync with TEMPO_SPAN_KINDS (source of truth)', () => {
    const props = getOpsItemProperties()
    const tempoSpan = props.tempoSpan as {
      properties: { kind: { enum: string[] } }
    }
    expect(tempoSpan.properties.kind.enum).toEqual([...TEMPO_SPAN_KINDS])
  })

  it('exposes endTempoBpm with the 30..240 BPM bounds (matches Marker.tempo_bpm)', () => {
    const props = getOpsItemProperties()
    const tempoSpan = props.tempoSpan as {
      properties: { endTempoBpm: { type: string; minimum: number; maximum: number } }
    }
    expect(tempoSpan.properties.endTempoBpm.type).toBe('integer')
    expect(tempoSpan.properties.endTempoBpm.minimum).toBe(30)
    expect(tempoSpan.properties.endTempoBpm.maximum).toBe(240)
  })

  it('exposes endTempoText with maxLength:40 (matches Marker.tempo_text)', () => {
    const props = getOpsItemProperties()
    const tempoSpan = props.tempoSpan as {
      properties: { endTempoText: { type: string; maxLength: number } }
    }
    expect(tempoSpan.properties.endTempoText.type).toBe('string')
    expect(tempoSpan.properties.endTempoText.maxLength).toBe(40)
  })

  it('exposes placement enum {above, below, default}', () => {
    const props = getOpsItemProperties()
    const tempoSpan = props.tempoSpan as {
      properties: { placement: { enum: string[] } }
    }
    expect(tempoSpan.properties.placement.enum).toEqual(['above', 'below', 'default'])
  })

  it('does NOT expose startDynamic / endDynamic on tempoSpan payload (hairpin-specific)', () => {
    const props = getOpsItemProperties()
    const tempoSpan = props.tempoSpan as {
      properties: Record<string, unknown>
    }
    expect(tempoSpan.properties.startDynamic).toBeUndefined()
    expect(tempoSpan.properties.endDynamic).toBeUndefined()
  })

  it('shared patch bag exposes endTempoBpm / endTempoText (used by updateTempoSpan)', () => {
    const props = getOpsItemProperties()
    const patch = props.patch as {
      properties: Record<string, unknown>
    }
    expect(patch.properties.endTempoBpm).toBeDefined()
    expect(patch.properties.endTempoText).toBeDefined()
  })

  it('shared patch.kind enum equals HAIRPIN_KINDS ∪ SLUR_KINDS ∪ TEMPO_SPAN_KINDS ∪ JUMP_KINDS (strict union)', () => {
    // Symmetric assertion with slurSchema + hairpinSchema + jumpMarker
    // schema tests so any drift in any of the four KINDS consts (or
    // the shared schema enum) fails at least one pin test.
    const props = getOpsItemProperties()
    const patch = props.patch as {
      properties: { kind: { enum: string[] } }
    }
    expect(patch.properties.kind.enum).toEqual([
      ...HAIRPIN_KINDS,
      ...SLUR_KINDS,
      ...TEMPO_SPAN_KINDS,
      ...JUMP_KINDS,
      ...OCTAVE_SPAN_KINDS,
    ])
  })

  it('shared patch.endTempoBpm has bounds matching the insert payload', () => {
    const props = getOpsItemProperties()
    const patch = props.patch as {
      properties: { endTempoBpm: { type: unknown; minimum: number; maximum: number } }
    }
    // Allow integer or [integer, null] — patch fields permit null for clearing.
    const typeArr = Array.isArray(patch.properties.endTempoBpm.type)
      ? patch.properties.endTempoBpm.type
      : [patch.properties.endTempoBpm.type]
    expect(typeArr).toContain('integer')
    expect(typeArr).toContain('null')
    expect(patch.properties.endTempoBpm.minimum).toBe(30)
    expect(patch.properties.endTempoBpm.maximum).toBe(240)
  })

  it('shared patch.endTempoText has maxLength matching the insert payload', () => {
    const props = getOpsItemProperties()
    const patch = props.patch as {
      properties: { endTempoText: { type: unknown; maxLength: number } }
    }
    const typeArr = Array.isArray(patch.properties.endTempoText.type)
      ? patch.properties.endTempoText.type
      : [patch.properties.endTempoText.type]
    expect(typeArr).toContain('string')
    expect(typeArr).toContain('null')
    expect(patch.properties.endTempoText.maxLength).toBe(40)
  })
})
