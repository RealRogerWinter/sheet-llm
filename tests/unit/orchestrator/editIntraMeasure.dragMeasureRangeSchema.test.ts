import { describe, it, expect } from 'vitest'
import {
  INTRA_SYSTEM_PROMPT,
  buildEditScoreSchemaJson,
} from '@/lib/orchestrator/handlers/editIntraMeasure'
import type { Score } from '@/lib/music/types'

/**
 * Pin tests for dragMeasureRange LLM exposure (M19-PR-4).
 * Verifies INTRA_SYSTEM_PROMPT documents the 3 modes + worked examples,
 * and buildEditScoreSchemaJson exposes the mode/fromStart/fromEnd/toAfter
 * fields on the shared op-bag with the right bounds.
 */

const simpleScore: Score = {
  key: 'C',
  meter: '4/4',
  measures: [
    {
      events: [
        { id: 'evtestid01', pitches: [{ step: 'C', octave: 4 }], duration: 'whole' },
      ],
    },
    {
      events: [
        { id: 'evtestid02', pitches: [{ step: 'D', octave: 4 }], duration: 'whole' },
      ],
    },
    {
      events: [
        { id: 'evtestid03', pitches: [{ step: 'E', octave: 4 }], duration: 'whole' },
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

describe('INTRA_SYSTEM_PROMPT documents dragMeasureRange (M19-PR-4)', () => {
  it('lists dragMeasureRange in OPERATION KINDS', () => {
    expect(INTRA_SYSTEM_PROMPT).toContain('dragMeasureRange:')
  })

  it('mentions all three modes in OPERATION KINDS doc', () => {
    // OPERATION KINDS line should enumerate delete/move/duplicate.
    const opKindsBlock = INTRA_SYSTEM_PROMPT.match(/- dragMeasureRange:[^\n]+/)?.[0] ?? ''
    expect(opKindsBlock).toContain('delete')
    expect(opKindsBlock).toContain('move')
    expect(opKindsBlock).toContain('duplicate')
  })

  it('warns that deleteMeasure / duplicateMeasure are inferior to dragMeasureRange', () => {
    // The legacy single-measure ops don't remap spans / markers, so the
    // prompt steers new emissions toward dragMeasureRange. Pin this so
    // a refactor that drops the warning surfaces here.
    expect(INTRA_SYSTEM_PROMPT).toMatch(/PREFER dragMeasureRange[\s\S]*delete/)
    expect(INTRA_SYSTEM_PROMPT).toMatch(/PREFER dragMeasureRange[\s\S]*duplicate/)
  })

  it('includes delete + move + duplicate worked examples', () => {
    expect(INTRA_SYSTEM_PROMPT).toMatch(
      /"kind":"dragMeasureRange","mode":"delete"/,
    )
    expect(INTRA_SYSTEM_PROMPT).toMatch(
      /"kind":"dragMeasureRange","mode":"move"/,
    )
    expect(INTRA_SYSTEM_PROMPT).toMatch(
      /"kind":"dragMeasureRange","mode":"duplicate"/,
    )
  })

  it("documents toAfter's semantic (origin-layout coordinates, -1 for start)", () => {
    expect(INTRA_SYSTEM_PROMPT).toMatch(/toAfter/i)
    expect(INTRA_SYSTEM_PROMPT).toMatch(/-1/)
  })

  it('documents that mode:"move" rejects toAfter inside the source range', () => {
    expect(INTRA_SYSTEM_PROMPT).toMatch(/move[\s\S]{0,200}toAfter inside/i)
  })
})

describe('buildEditScoreSchemaJson dragMeasureRange fields (M19-PR-4)', () => {
  it('exposes mode as an enum of delete/move/duplicate', () => {
    const props = getOpsItemProperties()
    const mode = props.mode as { type: string; enum: string[] }
    expect(mode.type).toBe('string')
    expect(mode.enum.sort()).toEqual(['delete', 'duplicate', 'move'])
  })

  it('exposes fromStart bounded by 0..maxMeasureIdx', () => {
    const props = getOpsItemProperties()
    const fromStart = props.fromStart as { type: string; minimum: number; maximum: number }
    expect(fromStart.type).toBe('integer')
    expect(fromStart.minimum).toBe(0)
    expect(fromStart.maximum).toBe(simpleScore.measures.length - 1)
  })

  it('exposes fromEnd bounded by 0..maxMeasureIdx', () => {
    const props = getOpsItemProperties()
    const fromEnd = props.fromEnd as { type: string; minimum: number; maximum: number }
    expect(fromEnd.type).toBe('integer')
    expect(fromEnd.minimum).toBe(0)
    expect(fromEnd.maximum).toBe(simpleScore.measures.length - 1)
  })

  it('exposes toAfter bounded by -1..maxMeasureIdx (matches the op layer)', () => {
    const props = getOpsItemProperties()
    const toAfter = props.toAfter as { type: string; minimum: number; maximum: number }
    expect(toAfter.type).toBe('integer')
    expect(toAfter.minimum).toBe(-1)
    expect(toAfter.maximum).toBe(simpleScore.measures.length - 1)
  })

  it('mode + fromStart + fromEnd + toAfter share the flat op-bag (no nested object)', () => {
    // dragMeasureRange follows the same flat-op-bag pattern as
    // setStartBarline / setPickup — fields sit alongside the other
    // scalars at the same level. Pin this so a future refactor that
    // nests them under a `dragMeasureRange` sub-object surfaces here.
    const props = getOpsItemProperties()
    expect(props.mode).toBeDefined()
    expect(props.fromStart).toBeDefined()
    expect(props.fromEnd).toBeDefined()
    expect(props.toAfter).toBeDefined()
  })
})
