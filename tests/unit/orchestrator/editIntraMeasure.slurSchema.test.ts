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
import { SLURS_REFERENCE, SYSTEM_PROMPT } from '@/lib/llm/systemPrompt'
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

describe('INTRA_SYSTEM_PROMPT documents slur ops (M12-PR-2)', () => {
  it('lists insertSlur / removeSlur / updateSlur in OPERATION KINDS', () => {
    expect(INTRA_SYSTEM_PROMPT).toContain('insertSlur:')
    expect(INTRA_SYSTEM_PROMPT).toContain('removeSlur:')
    expect(INTRA_SYSTEM_PROMPT).toContain('updateSlur:')
  })

  it('explains both slur kinds (slur / phrase-slur) in the prompt', () => {
    expect(INTRA_SYSTEM_PROMPT).toContain('"slur"')
    expect(INTRA_SYSTEM_PROMPT).toContain('"phrase-slur"')
  })

  it('includes at least one worked example using insertSlur', () => {
    expect(INTRA_SYSTEM_PROMPT).toContain('"kind":"insertSlur"')
  })

  it('disambiguates slur vs tie in prompt text', () => {
    // The "Distinct from per-pitch ties" note exists so the LLM
    // doesn't confuse them — they look similar but have different
    // semantics (tie = same pitch sustained, slur = different
    // pitches phrased).
    expect(INTRA_SYSTEM_PROMPT.toLowerCase()).toMatch(/distinct from .*tie/)
  })
})

describe('buildEditScoreSchemaJson slur payload (M12-PR-2)', () => {
  it('exposes a `slur` op-bag slot with the required endpoint ids', () => {
    const props = getOpsItemProperties()
    const slur = props.slur as {
      type: string
      required: string[]
      properties: Record<string, { enum?: string[] }>
    }
    expect(slur.type).toBe('object')
    expect(slur.required).toEqual(['kind', 'startEventId', 'endEventId'])
    expect(slur.properties.startEventId).toEqual({ type: 'string' })
    expect(slur.properties.endEventId).toEqual({ type: 'string' })
  })

  it('SLUR kind enum in the wire schema stays in sync with SLUR_KINDS (source of truth)', () => {
    const props = getOpsItemProperties()
    const slur = props.slur as {
      properties: { kind: { enum: string[] } }
    }
    expect(slur.properties.kind.enum).toEqual([...SLUR_KINDS])
  })

  it('exposes placement enum {above, below, default}', () => {
    const props = getOpsItemProperties()
    const slur = props.slur as {
      properties: { placement: { enum: string[] } }
    }
    expect(slur.properties.placement.enum).toEqual(['above', 'below', 'default'])
  })

  it('does NOT expose startDynamic / endDynamic on slur payload (hairpin-specific)', () => {
    const props = getOpsItemProperties()
    const slur = props.slur as {
      properties: Record<string, unknown>
    }
    expect(slur.properties.startDynamic).toBeUndefined()
    expect(slur.properties.endDynamic).toBeUndefined()
  })

  it('shared patch.kind enum equals HAIRPIN_KINDS ∪ SLUR_KINDS ∪ TEMPO_SPAN_KINDS (source-of-truth-driven)', () => {
    // Same pin as the hairpinSchema test — all files now assert the
    // identical union from the source-of-truth constants. Catches
    // drift in either direction: if any KINDS const gains a kind
    // that the schema doesn't, this test fails; if the schema gains
    // a kind not in any KINDS const, all tests fail (no false
    // positives). M14-PR-3 extended the patch bag to include the
    // tempo-span kinds.
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

  it('shared patch bag continues to expose startEventId / endEventId / placement (used by updateSlur AND updateHairpin)', () => {
    const props = getOpsItemProperties()
    const patch = props.patch as { properties: Record<string, unknown> }
    expect(patch.properties.startEventId).toBeDefined()
    expect(patch.properties.endEventId).toBeDefined()
    expect(patch.properties.placement).toBeDefined()
  })
})

describe('SLURS_REFERENCE content + bundling discipline', () => {
  it('SYSTEM_PROMPT does NOT contain SLURS_REFERENCE (render_score does not expose spans)', () => {
    // Same discipline as HAIRPINS_REFERENCE — SYSTEM_PROMPT is
    // consumed by generateSimple (client.ts) which calls
    // render_score; render_score doesn't expose `spans`, so
    // teaching the LLM about slurs there would lead to silent
    // JSON-schema-rejected emissions.
    expect(SYSTEM_PROMPT).not.toContain(SLURS_REFERENCE)
  })

  it('SLURS_REFERENCE mentions both slur kinds', () => {
    expect(SLURS_REFERENCE).toContain('slur')
    expect(SLURS_REFERENCE).toContain('phrase-slur')
  })

  it('SLURS_REFERENCE includes a worked example using spans', () => {
    expect(SLURS_REFERENCE).toContain('startEventId')
    expect(SLURS_REFERENCE).toContain('endEventId')
  })

  it('SLURS_REFERENCE disambiguates slur vs tie', () => {
    // The vocabulary confusion (slur over equal pitches looks like a
    // tie) is real engraving territory — the prompt must flag it.
    expect(SLURS_REFERENCE.toLowerCase()).toMatch(/distinct from ties/)
  })
})
