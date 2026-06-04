import { describe, it, expect } from 'vitest'
import {
  INTRA_SYSTEM_PROMPT,
  buildEditScoreSchemaJson,
} from '@/lib/orchestrator/handlers/editIntraMeasure'
import { JUMP_KINDS } from '@/lib/music/spans'
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

describe('INTRA_SYSTEM_PROMPT documents jumpMarker ops (M18-PR-4)', () => {
  it('lists insertJumpMarker / removeJumpMarker / updateJumpMarker in OPERATION KINDS', () => {
    expect(INTRA_SYSTEM_PROMPT).toContain('insertJumpMarker:')
    expect(INTRA_SYSTEM_PROMPT).toContain('removeJumpMarker:')
    expect(INTRA_SYSTEM_PROMPT).toContain('updateJumpMarker:')
  })

  it('explains the segnoRef requirement for D.S.* kinds', () => {
    expect(INTRA_SYSTEM_PROMPT).toMatch(/D\.S\..*REQUIRE segnoRef|MUST.*segnoRef/)
  })

  it('points to JUMP_MARKERS_REFERENCE for the full vocabulary', () => {
    expect(INTRA_SYSTEM_PROMPT).toContain('JUMP_MARKERS_REFERENCE')
  })

  it('includes the Sousa-march "D.S. al Coda" worked example', () => {
    expect(INTRA_SYSTEM_PROMPT).toMatch(/"kind":"D\.S\. al Coda"[\s\S]*"segnoRef"/)
    expect(INTRA_SYSTEM_PROMPT).toMatch(/"kind":"To Coda"/)
  })

  it('includes a bare D.C. worked example', () => {
    expect(INTRA_SYSTEM_PROMPT).toMatch(/"kind":"insertJumpMarker"[\s\S]*"kind":"D\.C\."/)
  })

  it('includes a removeJumpMarker worked example', () => {
    expect(INTRA_SYSTEM_PROMPT).toMatch(/"kind":"removeJumpMarker"/)
  })

  it('includes an updateJumpMarker patch.kind promotion example', () => {
    expect(INTRA_SYSTEM_PROMPT).toMatch(/"kind":"updateJumpMarker"[\s\S]*"kind":"D\.C\. al Fine"/)
  })
})

describe('buildEditScoreSchemaJson jumpMarker op-bag slot (M18-PR-4)', () => {
  it('exposes the jumpMarker payload with required fields', () => {
    const props = getOpsItemProperties()
    const jumpMarker = props.jumpMarker as {
      type: string
      required: string[]
      properties: Record<string, unknown>
    }
    expect(jumpMarker.type).toBe('object')
    expect(jumpMarker.required).toEqual(['measureIdx', 'side', 'kind'])
  })

  it('kind enum equals JUMP_KINDS (8 entries) exactly', () => {
    const props = getOpsItemProperties()
    const jumpMarker = props.jumpMarker as {
      properties: { kind: { enum: string[] } }
    }
    expect(jumpMarker.properties.kind.enum).toEqual([...JUMP_KINDS])
  })

  it('side enum is start|end', () => {
    const props = getOpsItemProperties()
    const jumpMarker = props.jumpMarker as {
      properties: { side: { enum: string[] } }
    }
    expect(jumpMarker.properties.side.enum).toEqual(['start', 'end'])
  })

  it('segnoRef / codaRef / toCodaRef are string fields', () => {
    const props = getOpsItemProperties()
    const jumpMarker = props.jumpMarker as {
      properties: {
        segnoRef: { type: string }
        codaRef: { type: string }
        toCodaRef: { type: string }
      }
    }
    expect(jumpMarker.properties.segnoRef.type).toBe('string')
    expect(jumpMarker.properties.codaRef.type).toBe('string')
    expect(jumpMarker.properties.toCodaRef.type).toBe('string')
  })

  it('shared patch bag exposes jumpMarker-specific fields (side, segnoRef, codaRef, toCodaRef)', () => {
    const props = getOpsItemProperties()
    const patch = props.patch as {
      properties: Record<string, unknown>
    }
    expect(patch.properties.side).toBeDefined()
    expect(patch.properties.segnoRef).toBeDefined()
    expect(patch.properties.codaRef).toBeDefined()
    expect(patch.properties.toCodaRef).toBeDefined()
  })
})

describe('render_score jumpMarkers/segnoMarkers/codaMarkers fields (M18-PR-4)', () => {
  it('exposes top-level jumpMarkers array with id + measureIdx + side + kind required', async () => {
    // M18-PR-4 review: id is REQUIRED at the wire layer because
    // JumpMarkerSchema.id is required at the Zod layer (the same
    // required-id pattern as segnoMarkers / codaMarkers). LLM mints
    // unique ids; ensureJumpMarkerIds is a defensive backfill for
    // the migrate path, not the live wire path (provider parses
    // BEFORE scoreRetry runs the backfill).
    const { renderScoreTool } = await import('@/lib/llm/renderScoreTool')
    const props = renderScoreTool.input_schema.properties as Record<string, unknown>
    const jumpMarkers = props.jumpMarkers as {
      type: string
      maxItems: number
      items: {
        required: string[]
        properties: Record<string, unknown>
      }
    }
    expect(jumpMarkers.type).toBe('array')
    expect(jumpMarkers.maxItems).toBe(50)
    expect(jumpMarkers.items.required).toEqual(['id', 'measureIdx', 'side', 'kind'])
    expect(jumpMarkers.items.properties.id).toBeDefined()
    expect(jumpMarkers.items.properties.segnoRef).toBeDefined()
    expect(jumpMarkers.items.properties.codaRef).toBeDefined()
    expect(jumpMarkers.items.properties.toCodaRef).toBeDefined()
  })

  it('jumpMarkers.items.kind enum equals JUMP_KINDS exactly', async () => {
    const { renderScoreTool } = await import('@/lib/llm/renderScoreTool')
    const props = renderScoreTool.input_schema.properties as Record<string, unknown>
    const jumpMarkers = props.jumpMarkers as {
      items: { properties: { kind: { enum: string[] } } }
    }
    expect(jumpMarkers.items.properties.kind.enum).toEqual([...JUMP_KINDS])
  })

  it('exposes segnoMarkers + codaMarkers arrays with id required', async () => {
    const { renderScoreTool } = await import('@/lib/llm/renderScoreTool')
    const props = renderScoreTool.input_schema.properties as Record<string, unknown>
    const segno = props.segnoMarkers as {
      type: string
      items: { required: string[] }
    }
    const coda = props.codaMarkers as {
      type: string
      items: { required: string[] }
    }
    expect(segno.type).toBe('array')
    expect(segno.items.required).toContain('id')
    expect(segno.items.required).toContain('measureIdx')
    expect(coda.type).toBe('array')
    expect(coda.items.required).toContain('id')
    expect(coda.items.required).toContain('measureIdx')
  })
})
