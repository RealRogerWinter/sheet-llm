import { describe, it, expect } from 'vitest'
import { renderScoreTool } from '@/lib/llm/renderScoreTool'
import { BARLINE_KINDS } from '@/lib/music/types'

function measureSchemaProperties(): Record<string, unknown> {
  const props = renderScoreTool.input_schema.properties as Record<string, unknown>
  return (props.measures as { items: { properties: Record<string, unknown> } }).items.properties
}

describe('render_score measure-level barline fields (M16-PR-3)', () => {
  it('startBarline enum equals BARLINE_KINDS (source-of-truth strict union; catches drift)', () => {
    // Strict-union pin — if BarlineSchema gains a 9th kind, this
    // test fails (the wire schema would lag) AND the editIntra
    // Measure barline pin fails. The HAIRPIN_KINDS / SLUR_KINDS /
    // TEMPO_SPAN_KINDS pin pattern from spans.ts.
    const props = measureSchemaProperties()
    const start = props.startBarline as { type: string; enum: string[] }
    expect(start.type).toBe('string')
    expect(start.enum).toEqual([...BARLINE_KINDS])
  })

  it('endBarline enum equals BARLINE_KINDS', () => {
    const props = measureSchemaProperties()
    const end = props.endBarline as { type: string; enum: string[] }
    expect(end.type).toBe('string')
    expect(end.enum).toEqual([...BARLINE_KINDS])
  })

  it('exposes isPickup as boolean', () => {
    const props = measureSchemaProperties()
    const pickup = props.isPickup as { type: string }
    expect(pickup.type).toBe('boolean')
  })

  it('exposes isFinalPartial as boolean', () => {
    const props = measureSchemaProperties()
    const fp = props.isFinalPartial as { type: string }
    expect(fp.type).toBe('boolean')
  })

  it('mirrors barline fields onto every staff/voice surface (4 occurrences total)', () => {
    // A future refactor that drops STAFF_MEASURE_PROPERTIES in favor
    // of per-callsite spread would silently strip these from some
    // surfaces. The serialized schema must contain `"startBarline"`
    // four times — once per nested events block (primary,
    // extraVoices, secondStaff, secondStaff extraVoices).
    const serialized = JSON.stringify(renderScoreTool.input_schema)
    const startBarlineOccurrences = serialized.split('"startBarline"').length - 1
    const endBarlineOccurrences = serialized.split('"endBarline"').length - 1
    const isPickupOccurrences = serialized.split('"isPickup"').length - 1
    expect(startBarlineOccurrences).toBeGreaterThanOrEqual(4)
    expect(endBarlineOccurrences).toBeGreaterThanOrEqual(4)
    expect(isPickupOccurrences).toBeGreaterThanOrEqual(4)
  })
})
