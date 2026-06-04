import { describe, it, expect } from 'vitest'
import { JUMP_MARKERS_REFERENCE, SYSTEM_PROMPT } from '@/lib/llm/systemPrompt'
import { JUMP_KINDS } from '@/lib/music/spans'

describe('JUMP_MARKERS_REFERENCE (M18-PR-4)', () => {
  it('lists all 8 JumpKind values verbatim', () => {
    for (const k of JUMP_KINDS) {
      expect(JUMP_MARKERS_REFERENCE).toContain(k)
    }
  })

  it('teaches the three Score-level arrays (jumpMarkers, segnoMarkers, codaMarkers)', () => {
    expect(JUMP_MARKERS_REFERENCE).toContain('jumpMarkers')
    expect(JUMP_MARKERS_REFERENCE).toContain('segnoMarkers')
    expect(JUMP_MARKERS_REFERENCE).toContain('codaMarkers')
  })

  it('teaches the JumpMarker shape (measureIdx, side, kind, refs)', () => {
    expect(JUMP_MARKERS_REFERENCE).toContain('measureIdx')
    expect(JUMP_MARKERS_REFERENCE).toContain('side')
    expect(JUMP_MARKERS_REFERENCE).toContain('segnoRef')
    expect(JUMP_MARKERS_REFERENCE).toContain('codaRef')
    expect(JUMP_MARKERS_REFERENCE).toContain('toCodaRef')
  })

  it('explains the "fires at most once" expand() semantic', () => {
    expect(JUMP_MARKERS_REFERENCE).toMatch(/AT MOST ONCE|at most once/i)
    expect(JUMP_MARKERS_REFERENCE).toMatch(/no infinite loops|infinite/i)
  })

  it('explains the al-Coda gating semantic (pass 1 vs pass 2)', () => {
    expect(JUMP_MARKERS_REFERENCE).toMatch(/al-Coda|al Coda/)
    expect(JUMP_MARKERS_REFERENCE).toMatch(/FIRST pass|first pass/i)
    expect(JUMP_MARKERS_REFERENCE).toMatch(/post-jump pass/i)
  })

  it('explains the "Fine on first pass is decorative" classical convention', () => {
    expect(JUMP_MARKERS_REFERENCE).toMatch(/classical convention|decorative/i)
  })

  it('teaches ref discipline (D.S.* MUST have segnoRef)', () => {
    expect(JUMP_MARKERS_REFERENCE).toMatch(/D\.S\..*MUST have segnoRef|MUST have segnoRef/i)
  })

  it('explains toCodaRef for multi-coda scores', () => {
    expect(JUMP_MARKERS_REFERENCE).toContain('toCodaRef')
    expect(JUMP_MARKERS_REFERENCE).toMatch(/multi-coda|multiple To Codas/i)
  })

  it('lists all 3 edit ops', () => {
    expect(JUMP_MARKERS_REFERENCE).toContain('insertJumpMarker')
    expect(JUMP_MARKERS_REFERENCE).toContain('removeJumpMarker')
    expect(JUMP_MARKERS_REFERENCE).toContain('updateJumpMarker')
  })

  it('includes a Sousa-march "D.C. al Coda" worked example', () => {
    expect(JUMP_MARKERS_REFERENCE).toMatch(/Sousa.*D\.C\. al Coda|D\.C\. al Coda.*Sousa/i)
    expect(JUMP_MARKERS_REFERENCE).toMatch(/"kind":"D\.C\. al Coda"/)
    expect(JUMP_MARKERS_REFERENCE).toMatch(/"kind":"To Coda"/)
  })

  it('includes a "D.S. al Fine" worked example', () => {
    expect(JUMP_MARKERS_REFERENCE).toMatch(/Dal Segno al Fine|D\.S\. al Fine/i)
    expect(JUMP_MARKERS_REFERENCE).toMatch(/"kind":"D\.S\. al Fine"/)
    expect(JUMP_MARKERS_REFERENCE).toMatch(/"kind":"Fine"/)
  })

  it('includes a multi-coda worked example', () => {
    expect(JUMP_MARKERS_REFERENCE).toMatch(/multi-coda/i)
    expect(JUMP_MARKERS_REFERENCE).toMatch(/"toCodaRef"/)
  })

  it('reports the M18-PR-2 renderer wire-up status', () => {
    expect(JUMP_MARKERS_REFERENCE).toMatch(/M18-PR-2/)
    expect(JUMP_MARKERS_REFERENCE).toContain('!D.C.!')
    expect(JUMP_MARKERS_REFERENCE).toContain('!segno!')
    expect(JUMP_MARKERS_REFERENCE).toContain('!coda!')
    expect(JUMP_MARKERS_REFERENCE).toMatch(/"\^To Coda"|To Coda.*annotation/i)
  })

  it('distinguishes jumpMarkers from voltas', () => {
    expect(JUMP_MARKERS_REFERENCE).toMatch(/voltas/i)
    expect(JUMP_MARKERS_REFERENCE).toMatch(/voltas.*separate|distinct|separate vocabulary/i)
  })
})

describe('SYSTEM_PROMPT bundles JUMP_MARKERS_REFERENCE (M18-PR-4)', () => {
  it('SYSTEM_PROMPT includes JUMP_MARKERS_REFERENCE verbatim', () => {
    expect(SYSTEM_PROMPT).toContain(JUMP_MARKERS_REFERENCE)
  })
})
