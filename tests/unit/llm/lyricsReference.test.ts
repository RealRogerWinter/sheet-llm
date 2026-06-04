import { describe, it, expect } from 'vitest'
import { LYRICS_REFERENCE, SYSTEM_PROMPT, MULTI_STAFF_REFERENCE } from '@/lib/llm/systemPrompt'

describe('LYRICS_REFERENCE (M15-PR-3)', () => {
  it('teaches per-event, per-verse semantics', () => {
    expect(LYRICS_REFERENCE).toMatch(/per-event/i)
    expect(LYRICS_REFERENCE).toMatch(/verse/i)
    expect(LYRICS_REFERENCE).toMatch(/syllable/i)
  })

  it('teaches hyphen and extender semantics', () => {
    expect(LYRICS_REFERENCE).toMatch(/hyphen/i)
    expect(LYRICS_REFERENCE).toMatch(/extender/i)
    expect(LYRICS_REFERENCE).toMatch(/melisma/i)
    expect(LYRICS_REFERENCE).toMatch(/mutually exclusive/i)
  })

  it('teaches the multi-syllable word pattern (hyphen on all but last)', () => {
    expect(LYRICS_REFERENCE).toMatch(/EVERY syllable EXCEPT the last/i)
    expect(LYRICS_REFERENCE).toContain('Glo-ri-a')
  })

  it('explicitly warns against putting literal hyphens in syllable text', () => {
    expect(LYRICS_REFERENCE).toMatch(/DON'T put hyphens IN/i)
  })

  it('teaches per-voice SATB divisi convention', () => {
    expect(LYRICS_REFERENCE).toMatch(/SATB/)
    expect(LYRICS_REFERENCE).toMatch(/per-voice/i)
  })

  it('teaches the schema bounds (verse 1..50, syllable 1..40)', () => {
    expect(LYRICS_REFERENCE).toMatch(/1\.\.50/)
    expect(LYRICS_REFERENCE).toMatch(/1\.\.40/)
  })

  it('documents the rest-event caveat (data round-trips, not rendered)', () => {
    expect(LYRICS_REFERENCE).toMatch(/rest/i)
    expect(LYRICS_REFERENCE).toMatch(/round-trip/i)
  })

  it('lists all 3 edit ops with their shapes', () => {
    expect(LYRICS_REFERENCE).toContain('setLyric')
    expect(LYRICS_REFERENCE).toContain('removeLyric')
    expect(LYRICS_REFERENCE).toContain('clearLyrics')
  })

  it('includes a worked example for "Amazing Grace" (canonical 4-syllable + hyphen pattern)', () => {
    expect(LYRICS_REFERENCE).toMatch(/Amazing Grace/i)
  })

  it('includes a worked example for multi-verse stacking', () => {
    expect(LYRICS_REFERENCE).toMatch(/2-verse|multi-verse/i)
  })

  it('reports the M15-PR-2 renderer wire-up status', () => {
    expect(LYRICS_REFERENCE).toMatch(/M15-PR-2/)
    expect(LYRICS_REFERENCE).toMatch(/w:/)
  })
})

describe('SYSTEM_PROMPT bundles LYRICS_REFERENCE (M15-PR-3)', () => {
  it('SYSTEM_PROMPT includes LYRICS_REFERENCE verbatim', () => {
    expect(SYSTEM_PROMPT).toContain(LYRICS_REFERENCE)
  })

  it('removes "lyrics" from the NOT supported list (BASE_RULES update)', () => {
    // Pre-M15 the rules said: "NOT supported: ... lyrics. If asked
    // for these, reply..." which made the LLM refuse lyric requests.
    // Post-M15 the NOT-supported sentence drops lyrics and a
    // following parenthetical states lyrics ARE supported. The
    // negative match below targets ONLY the NOT-supported sentence
    // (non-greedy, stops at the first `.` ending the sentence).
    const notSupportedSentence = MULTI_STAFF_REFERENCE.match(
      /NOT supported:[^.]*\./,
    )?.[0]
    expect(notSupportedSentence).toBeDefined()
    expect(notSupportedSentence!.toLowerCase()).not.toContain('lyrics')
    // Positive: a separate sentence acknowledges lyric support.
    expect(MULTI_STAFF_REFERENCE).toMatch(/lyrics ARE supported/i)
  })
})
