import { describe, it, expect } from 'vitest'
import { BARLINES_REFERENCE, SYSTEM_PROMPT, MULTI_STAFF_REFERENCE } from '@/lib/llm/systemPrompt'

describe('BARLINES_REFERENCE (M16-PR-3)', () => {
  it('teaches startBarline + endBarline + isPickup + isFinalPartial fields', () => {
    expect(BARLINES_REFERENCE).toContain('startBarline')
    expect(BARLINES_REFERENCE).toContain('endBarline')
    expect(BARLINES_REFERENCE).toContain('isPickup')
    expect(BARLINES_REFERENCE).toContain('isFinalPartial')
  })

  it('enumerates all 8 barline kinds', () => {
    for (const kind of [
      'thin',
      'double',
      'final',
      'repeat-start',
      'repeat-end',
      'repeat-both',
      'invisible',
      'dashed',
    ]) {
      expect(BARLINES_REFERENCE).toContain(kind)
    }
  })

  it('warns against using `repeat-end + repeat-start` adjacent (should be `repeat-both`)', () => {
    expect(BARLINES_REFERENCE).toMatch(/repeat-both/i)
    expect(BARLINES_REFERENCE).toMatch(/NOT.*repeat-end.*\+.*repeat-start|two adjacent barlines/i)
  })

  it('distinguishes startBarline (LEFT) vs endBarline (RIGHT)', () => {
    expect(BARLINES_REFERENCE).toMatch(/LEFT.*edge/i)
    expect(BARLINES_REFERENCE).toMatch(/RIGHT.*edge/i)
  })

  it('explains anacrusis / pickup semantics', () => {
    expect(BARLINES_REFERENCE).toMatch(/anacrusis/i)
    expect(BARLINES_REFERENCE).toMatch(/pickup/i)
    expect(BARLINES_REFERENCE).toMatch(/Auld Lang Syne|partial measure/i)
  })

  it('warns that isPickup on a full bar is decorative', () => {
    expect(BARLINES_REFERENCE).toMatch(/Don't set isPickup on a FULL bar|decorative/i)
  })

  it('distinguishes from jumpMarkers (D.C./D.S./Fine etc. are NOT barline kinds)', () => {
    expect(BARLINES_REFERENCE).toMatch(/D\.C\.|D\.S\.|Fine|JUMP MARKERS/i)
    expect(BARLINES_REFERENCE).toMatch(/NOT barline kinds/i)
  })

  it('lists all 4 edit ops with their shapes', () => {
    expect(BARLINES_REFERENCE).toContain('setStartBarline')
    expect(BARLINES_REFERENCE).toContain('setEndBarline')
    expect(BARLINES_REFERENCE).toContain('setPickup')
    expect(BARLINES_REFERENCE).toContain('setFinalPartial')
  })

  it('includes a worked example for repeat-block creation', () => {
    // Use [\s\S] instead of /s flag (ES2018+) — the worked example
    // is multi-line JSON so we need cross-line matching.
    expect(BARLINES_REFERENCE).toMatch(/"kind":"setStartBarline"[\s\S]*"repeat-start"/)
    expect(BARLINES_REFERENCE).toMatch(/"kind":"setEndBarline"[\s\S]*"repeat-end"/)
  })

  it('includes a worked example for the back-to-back repeat-both case', () => {
    expect(BARLINES_REFERENCE).toMatch(/"barline":"repeat-both"/)
  })

  it('includes a worked example for setPickup', () => {
    expect(BARLINES_REFERENCE).toMatch(/"kind":"setPickup"/)
    expect(BARLINES_REFERENCE).toMatch(/"isPickup":true/)
  })

  it('reports the M16-PR-2 renderer wire-up status', () => {
    expect(BARLINES_REFERENCE).toMatch(/M16-PR-2/)
    expect(BARLINES_REFERENCE).toMatch(/abcjs|abc_tokenizer/)
  })
})

describe('SYSTEM_PROMPT bundles BARLINES_REFERENCE (M16-PR-3)', () => {
  it('SYSTEM_PROMPT includes BARLINES_REFERENCE verbatim', () => {
    expect(SYSTEM_PROMPT).toContain(BARLINES_REFERENCE)
  })

  it('removes "repeat signs" from the NOT supported list (BASE_RULES update)', () => {
    // Pre-M16 the rules said: "NOT supported: ... repeat signs ..."
    // which made the LLM refuse all repeat / double-bar requests.
    // Post-M16 the NOT-supported sentence drops repeat signs and a
    // following parenthetical states they ARE supported.
    const notSupportedSentence = MULTI_STAFF_REFERENCE.match(/NOT supported:[^.]*\./)?.[0]
    expect(notSupportedSentence).toBeDefined()
    expect(notSupportedSentence!.toLowerCase()).not.toContain('repeat sign')
    // Positive: a separate sentence acknowledges barline / repeat support.
    expect(MULTI_STAFF_REFERENCE).toMatch(/repeat signs.*ARE supported|BARLINES_REFERENCE/)
  })
})
