import { describe, it, expect } from 'vitest'
import { VOLTAS_REFERENCE, SYSTEM_PROMPT } from '@/lib/llm/systemPrompt'

describe('VOLTAS_REFERENCE (M17-PR-3)', () => {
  it('teaches the volta shape and field semantics', () => {
    expect(VOLTAS_REFERENCE).toContain('startMeasureIdx')
    expect(VOLTAS_REFERENCE).toContain('endMeasureIdx')
    expect(VOLTAS_REFERENCE).toContain('endings')
    expect(VOLTAS_REFERENCE).toContain('endHook')
  })

  it('explains endings array with common forms', () => {
    expect(VOLTAS_REFERENCE).toMatch(/1st time only|first time only/i)
    expect(VOLTAS_REFERENCE).toMatch(/2nd time only|second time only/i)
    expect(VOLTAS_REFERENCE).toMatch(/1\.\.9/)
  })

  it('warns about pairing with non-thin endBarline (renderer gotcha)', () => {
    expect(VOLTAS_REFERENCE).toMatch(/non-thin/i)
    expect(VOLTAS_REFERENCE).toMatch(/endBarline/i)
    expect(VOLTAS_REFERENCE).toMatch(/repeat-end|repeat block/i)
  })

  it('explains pair-with-barline pattern for canonical repeat block', () => {
    expect(VOLTAS_REFERENCE).toMatch(/setStartBarline/)
    expect(VOLTAS_REFERENCE).toMatch(/setEndBarline/)
    expect(VOLTAS_REFERENCE).toMatch(/repeat-start/)
  })

  it('distinguishes voltas from jumpMarkers (D.C./D.S./Fine)', () => {
    expect(VOLTAS_REFERENCE).toMatch(/D\.C\.|D\.S\.|Fine|JUMP MARKER/i)
    expect(VOLTAS_REFERENCE).toMatch(/not voltas|separate vocabulary/i)
  })

  it('lists all 3 edit ops', () => {
    expect(VOLTAS_REFERENCE).toContain('insertVolta')
    expect(VOLTAS_REFERENCE).toContain('removeVolta')
    expect(VOLTAS_REFERENCE).toContain('updateVolta')
  })

  it('includes the canonical 1st/2nd-ending paired worked example', () => {
    expect(VOLTAS_REFERENCE).toMatch(/"kind":"insertVolta"[\s\S]*"endings":\[1\]/)
    expect(VOLTAS_REFERENCE).toMatch(/"kind":"insertVolta"[\s\S]*"endings":\[2\]/)
  })

  it('includes a multi-bar volta worked example', () => {
    expect(VOLTAS_REFERENCE).toMatch(/multi-bar/i)
    expect(VOLTAS_REFERENCE).toMatch(/"startMeasureIdx":3.*"endMeasureIdx":4/)
  })

  it('reports the M17-PR-2 renderer wire-up status', () => {
    expect(VOLTAS_REFERENCE).toMatch(/M17-PR-2/)
    expect(VOLTAS_REFERENCE).toMatch(/abcjs/)
  })

  it('explicitly states id is REQUIRED on the compose path (M19-PR-9 latent fix)', () => {
    expect(VOLTAS_REFERENCE).toMatch(/id is REQUIRED/i)
    expect(VOLTAS_REFERENCE).toMatch(/8-16-char/)
    expect(VOLTAS_REFERENCE).not.toContain('Omit `id`')
  })

  it('includes a compose-path worked example with minted ids (M19-PR-9)', () => {
    // Distinct from the editIntraMeasure insertVolta examples above; this
    // teaches the LLM to mint ids on the render_score path where Zod
    // rejects missing ids before the server-side backfill can fire.
    expect(VOLTAS_REFERENCE).toMatch(/"id":"volta00001"/)
    expect(VOLTAS_REFERENCE).toMatch(/"id":"volta00002"/)
    expect(VOLTAS_REFERENCE).toMatch(/compose-path/i)
  })
})

describe('SYSTEM_PROMPT bundles VOLTAS_REFERENCE (M17-PR-3)', () => {
  it('SYSTEM_PROMPT includes VOLTAS_REFERENCE verbatim', () => {
    expect(SYSTEM_PROMPT).toContain(VOLTAS_REFERENCE)
  })
})
