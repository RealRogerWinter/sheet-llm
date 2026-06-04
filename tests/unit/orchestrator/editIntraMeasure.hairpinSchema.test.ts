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
import { HAIRPINS_REFERENCE, SYSTEM_PROMPT } from '@/lib/llm/systemPrompt'
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

describe('INTRA_SYSTEM_PROMPT documents hairpin ops (M11-PR-3)', () => {
  it('lists insertHairpin / removeHairpin / updateHairpin in OPERATION KINDS', () => {
    expect(INTRA_SYSTEM_PROMPT).toContain('insertHairpin:')
    expect(INTRA_SYSTEM_PROMPT).toContain('removeHairpin:')
    expect(INTRA_SYSTEM_PROMPT).toContain('updateHairpin:')
  })

  it('explains both hairpin kinds (hairpin-cresc / hairpin-dim) in the prompt', () => {
    expect(INTRA_SYSTEM_PROMPT).toContain('hairpin-cresc')
    expect(INTRA_SYSTEM_PROMPT).toContain('hairpin-dim')
  })

  it('includes at least one worked example using insertHairpin', () => {
    expect(INTRA_SYSTEM_PROMPT).toContain('"kind":"insertHairpin"')
  })
})

describe('buildEditScoreSchemaJson hairpin payload (M11-PR-3)', () => {
  it('exposes a `hairpin` op-bag slot with the required endpoint ids', () => {
    const props = getOpsItemProperties()
    const hairpin = props.hairpin as {
      type: string
      required: string[]
      properties: Record<string, { enum?: string[] }>
    }
    expect(hairpin.type).toBe('object')
    expect(hairpin.required).toEqual(['kind', 'startEventId', 'endEventId'])
    expect(hairpin.properties.startEventId).toEqual({ type: 'string' })
    expect(hairpin.properties.endEventId).toEqual({ type: 'string' })
  })

  it('HAIRPIN kind enum in the wire schema stays in sync with HAIRPIN_KINDS (source of truth)', () => {
    const props = getOpsItemProperties()
    const hairpin = props.hairpin as {
      properties: { kind: { enum: string[] } }
    }
    expect(hairpin.properties.kind.enum).toEqual([...HAIRPIN_KINDS])
  })

  it('exposes optional terminal dynamics with the full Dynamic enum', () => {
    const props = getOpsItemProperties()
    const hairpin = props.hairpin as {
      properties: {
        startDynamic: { enum: string[] }
        endDynamic: { enum: string[] }
      }
    }
    expect(hairpin.properties.startDynamic.enum).toContain('p')
    expect(hairpin.properties.startDynamic.enum).toContain('ff')
    expect(hairpin.properties.startDynamic.enum).toContain('sfz')
    // endDynamic mirrors startDynamic
    expect(hairpin.properties.endDynamic.enum).toEqual(hairpin.properties.startDynamic.enum)
  })

  it('exposes placement enum {above, below, default}', () => {
    const props = getOpsItemProperties()
    const hairpin = props.hairpin as {
      properties: { placement: { enum: string[] } }
    }
    expect(hairpin.properties.placement.enum).toEqual(['above', 'below', 'default'])
  })

  it('extends the shared patch bag with hairpin-specific fields', () => {
    const props = getOpsItemProperties()
    const patch = props.patch as { properties: Record<string, unknown> }
    // updateHairpin.patch reuses the optional bag — fields below must
    // be present so the op-bag JSON schema accepts an updateHairpin
    // payload.
    expect(patch.properties.startEventId).toBeDefined()
    expect(patch.properties.endEventId).toBeDefined()
    expect(patch.properties.kind).toBeDefined()
    expect(patch.properties.startDynamic).toBeDefined()
    expect(patch.properties.endDynamic).toBeDefined()
    expect(patch.properties.placement).toBeDefined()
  })

  it('patch.kind enum equals HAIRPIN_KINDS ∪ SLUR_KINDS ∪ TEMPO_SPAN_KINDS ∪ JUMP_KINDS ∪ OCTAVE_SPAN_KINDS (strict union; catches drift)', () => {
    // M11-PR-3 pinned this to HAIRPIN_KINDS exactly; M12 added slur
    // ops; M14-PR-3 added tempo-span ops; M18-PR-4 added jump-marker
    // ops; M20-PR-3 added octave-span ops. All families share the
    // patch bag. Both this test and the slur / tempoSpan / jumpMarker
    // / octaveSpan schema tests now assert the same strict union —
    // any change to a *_KINDS const or the schema enum fails the
    // relevant tests.
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
})

describe('HAIRPINS_REFERENCE content + bundling discipline', () => {
  it('SYSTEM_PROMPT does NOT contain HAIRPINS_REFERENCE (render_score does not expose spans)', () => {
    // SYSTEM_PROMPT is consumed by generateSimple (client.ts) which
    // calls render_score; render_score's JSON schema doesn't expose
    // `spans`, so teaching the LLM about hairpins there would lead
    // to silent JSON-schema-rejected emissions. The compose and
    // generateComplex SystemBlock arrays follow the same discipline.
    expect(SYSTEM_PROMPT).not.toContain(HAIRPINS_REFERENCE)
  })

  it('HAIRPINS_REFERENCE mentions both hairpin kinds', () => {
    expect(HAIRPINS_REFERENCE).toContain('hairpin-cresc')
    expect(HAIRPINS_REFERENCE).toContain('hairpin-dim')
  })

  it('HAIRPINS_REFERENCE includes a worked example using spans', () => {
    expect(HAIRPINS_REFERENCE).toContain('startEventId')
    expect(HAIRPINS_REFERENCE).toContain('endEventId')
  })
})
