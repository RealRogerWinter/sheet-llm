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

describe('INTRA_SYSTEM_PROMPT documents volta ops (M17-PR-3)', () => {
  it('lists insertVolta / removeVolta / updateVolta in OPERATION KINDS', () => {
    expect(INTRA_SYSTEM_PROMPT).toContain('insertVolta:')
    expect(INTRA_SYSTEM_PROMPT).toContain('removeVolta:')
    expect(INTRA_SYSTEM_PROMPT).toContain('updateVolta:')
  })

  it('warns about non-thin endBarline requirement', () => {
    expect(INTRA_SYSTEM_PROMPT).toMatch(/NON-THIN|non-thin/)
  })

  it('points to VOLTAS_REFERENCE for the full vocabulary', () => {
    expect(INTRA_SYSTEM_PROMPT).toContain('VOLTAS_REFERENCE')
  })

  it('includes the paired 1st/2nd-ending worked example', () => {
    expect(INTRA_SYSTEM_PROMPT).toMatch(/"kind":"insertVolta"[\s\S]*"endings":\[1\]/)
    expect(INTRA_SYSTEM_PROMPT).toMatch(/"kind":"insertVolta"[\s\S]*"endings":\[2\]/)
  })

  it('includes a removeVolta worked example', () => {
    expect(INTRA_SYSTEM_PROMPT).toMatch(/"kind":"removeVolta"/)
  })
})

describe('buildEditScoreSchemaJson volta op-bag slot (M17-PR-3)', () => {
  it('exposes the volta payload with required fields', () => {
    const props = getOpsItemProperties()
    const volta = props.volta as {
      type: string
      required: string[]
      properties: Record<string, unknown>
    }
    expect(volta.type).toBe('object')
    expect(volta.required).toEqual(['startMeasureIdx', 'endMeasureIdx', 'endings'])
  })

  it('endings field is an integer array with min/max', () => {
    const props = getOpsItemProperties()
    const volta = props.volta as {
      properties: {
        endings: { type: string; maxItems: number; items: { type: string; minimum: number; maximum: number } }
      }
    }
    expect(volta.properties.endings.type).toBe('array')
    expect(volta.properties.endings.maxItems).toBe(9)
    expect(volta.properties.endings.items.type).toBe('integer')
    expect(volta.properties.endings.items.minimum).toBe(1)
    expect(volta.properties.endings.items.maximum).toBe(9)
  })

  it('endHook enum is closed|open', () => {
    const props = getOpsItemProperties()
    const volta = props.volta as {
      properties: { endHook: { enum: string[] } }
    }
    expect(volta.properties.endHook.enum).toEqual(['closed', 'open'])
  })

  it('text field has maxLength 40', () => {
    const props = getOpsItemProperties()
    const volta = props.volta as {
      properties: { text: { maxLength: number } }
    }
    expect(volta.properties.text.maxLength).toBe(40)
  })
})

describe('render_score voltas field (M17-PR-3, M19-PR-9 id required)', () => {
  it('exposes top-level voltas array with the volta shape (id REQUIRED, M19-PR-9)', async () => {
    const { renderScoreTool } = await import('@/lib/llm/renderScoreTool')
    const props = renderScoreTool.input_schema.properties as Record<string, unknown>
    const voltas = props.voltas as {
      type: string
      maxItems: number
      items: {
        required: string[]
        properties: Record<string, unknown>
      }
    }
    expect(voltas.type).toBe('array')
    expect(voltas.maxItems).toBe(50)
    // M19-PR-9: `id` is included in required because VoltaSchema.id is
    // required at the Zod layer, and ProviderSchemaError fires BEFORE
    // ensureVoltaIds can backfill. Same wiring pattern as jumpMarkers
    // (M18-PR-4).
    expect(voltas.items.required).toEqual(['id', 'startMeasureIdx', 'endMeasureIdx', 'endings'])
    expect(voltas.items.properties.id).toBeDefined()
    expect(voltas.items.properties.endings).toBeDefined()
    expect(voltas.items.properties.endHook).toBeDefined()
    expect(voltas.items.properties.text).toBeDefined()
  })

  it('voltas id has 8-16 char length bounds matching VoltaIdSchema', async () => {
    const { renderScoreTool } = await import('@/lib/llm/renderScoreTool')
    const props = renderScoreTool.input_schema.properties as Record<string, unknown>
    const voltas = props.voltas as {
      items: { properties: { id: { type: string; minLength: number; maxLength: number } } }
    }
    expect(voltas.items.properties.id.type).toBe('string')
    expect(voltas.items.properties.id.minLength).toBe(8)
    expect(voltas.items.properties.id.maxLength).toBe(16)
  })
})
