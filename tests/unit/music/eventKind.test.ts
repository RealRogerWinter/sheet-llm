import { describe, it, expect } from 'vitest'
import { createNote, createRest, isPitched, isRest } from '@/lib/music/eventKind'
import { EventKindSchema, EventSchema } from '@/lib/music/types'
import { validateScore } from '@/lib/music/validateScore'

describe('isRest / isPitched', () => {
  it('returns true for explicit kind:"rest"', () => {
    expect(isRest({ kind: 'rest', pitches: [{ step: 'rest', octave: 4 }] })).toBe(true)
    expect(isPitched({ kind: 'rest', pitches: [{ step: 'rest', octave: 4 }] })).toBe(false)
  })

  it('returns false for explicit kind:"note"', () => {
    expect(isRest({ kind: 'note', pitches: [{ step: 'C', octave: 4 }] })).toBe(false)
    expect(isPitched({ kind: 'note', pitches: [{ step: 'C', octave: 4 }] })).toBe(true)
  })

  it('infers rest from legacy step:"rest" when kind is absent', () => {
    expect(isRest({ pitches: [{ step: 'rest', octave: 4 }] })).toBe(true)
    expect(isPitched({ pitches: [{ step: 'rest', octave: 4 }] })).toBe(false)
  })

  it('infers note from non-rest pitch when kind is absent', () => {
    expect(isRest({ pitches: [{ step: 'C', octave: 4 }] })).toBe(false)
    expect(isPitched({ pitches: [{ step: 'C', octave: 4 }] })).toBe(true)
  })

  it('lets kind take precedence over pitch sentinel (intentionally permissive)', () => {
    // An explicit kind:'note' wins even if the pitch is the rest sentinel.
    // This state is invalid musically; validateScore will eventually catch
    // it. The helper stays permissive so it can be called everywhere.
    expect(isRest({ kind: 'note', pitches: [{ step: 'rest', octave: 4 }] })).toBe(false)
    // Same in the other direction.
    expect(isRest({ kind: 'rest', pitches: [{ step: 'C', octave: 4 }] })).toBe(true)
  })

  it('treats a chord (multiple non-rest pitches) as pitched', () => {
    const chord = { pitches: [{ step: 'C' as const, octave: 4 }, { step: 'E' as const, octave: 4 }] }
    expect(isRest(chord)).toBe(false)
    expect(isPitched(chord)).toBe(true)
  })
})

describe('createRest', () => {
  it('returns a valid Event with kind:"rest" and a fresh id', () => {
    const r = createRest('whole')
    expect(r.kind).toBe('rest')
    expect(r.duration).toBe('whole')
    expect(typeof r.id).toBe('string')
    expect(r.id?.length).toBeGreaterThanOrEqual(8)
    expect(r.pitches[0].step).toBe('rest')
    expect(() => EventSchema.parse(r)).not.toThrow()
  })

  it('every createRest call yields a different id', () => {
    const a = createRest('quarter')
    const b = createRest('quarter')
    expect(a.id).not.toBe(b.id)
  })

  it('isRest recognizes a created rest', () => {
    expect(isRest(createRest('eighth'))).toBe(true)
  })
})

describe('createNote', () => {
  const C4: { step: 'C'; octave: 4 } = { step: 'C', octave: 4 }
  const E4: { step: 'E'; octave: 4 } = { step: 'E', octave: 4 }

  it('returns a valid Event with kind:"note" and a fresh id', () => {
    const n = createNote([C4], 'quarter')
    expect(n.kind).toBe('note')
    expect(n.duration).toBe('quarter')
    expect(typeof n.id).toBe('string')
    expect(n.pitches).toEqual([C4])
    expect(() => EventSchema.parse(n)).not.toThrow()
  })

  it('supports chord stacking (multiple pitches)', () => {
    const chord = createNote([C4, E4], 'half')
    expect(chord.pitches).toHaveLength(2)
    expect(isRest(chord)).toBe(false)
  })

  it('rejects an empty pitches array', () => {
    expect(() => createNote([], 'quarter')).toThrow(/at least one pitch/)
  })

  it('rejects a pitch with step:"rest" — caller should use createRest', () => {
    expect(() => createNote([{ step: 'rest', octave: 4 }], 'quarter')).toThrow(/cannot accept.*rest/i)
  })

  it('rejects a chord that mixes a rest sentinel with real pitches', () => {
    expect(() => createNote([C4, { step: 'rest', octave: 4 }], 'quarter')).toThrow(/cannot accept.*rest/i)
  })
})

describe('EventKindSchema', () => {
  it('accepts "note" and "rest"', () => {
    expect(EventKindSchema.parse('note')).toBe('note')
    expect(EventKindSchema.parse('rest')).toBe('rest')
  })

  it('rejects any other value', () => {
    expect(() => EventKindSchema.parse('chord')).toThrow()
    expect(() => EventKindSchema.parse('')).toThrow()
  })

  it('is exported as optional in the EventSchema (back-compat for unmigrated events)', () => {
    // Round-trips a legacy event (no kind) through schema validation.
    const legacy = {
      pitches: [{ step: 'C' as const, octave: 4 }],
      duration: 'quarter' as const,
    }
    expect(() => EventSchema.parse(legacy)).not.toThrow()
  })
})

describe('full-Score round-trip through validateScore', () => {
  it('accepts a score built with createNote/createRest helpers', () => {
    const score = {
      key: 'C' as const,
      meter: '4/4',
      measures: [
        {
          events: [
            createNote([{ step: 'C', octave: 4 }], 'quarter'),
            createNote([{ step: 'D', octave: 4 }], 'quarter'),
            createRest('quarter'),
            createNote([{ step: 'E', octave: 4 }], 'quarter'),
          ],
        },
      ],
    }
    const ok = validateScore(score)
    expect(ok.measures[0].events).toHaveLength(4)
    expect(ok.measures[0].events[2].kind).toBe('rest')
    expect(ok.measures[0].events[2].pitches[0].step).toBe('rest')
    expect(ok.measures[0].events[0].kind).toBe('note')
  })

  it('accepts a fully-legacy score (no kind anywhere) — back-compat pinned', () => {
    // PR-12 will tighten kind to required. Until then, every existing
    // stored score must continue to validate. This test pins the
    // loose-now contract so an accidental tightening (removing
    // .optional() on EventKindSchema in EventSchema) fails the suite.
    const legacy = {
      key: 'C' as const,
      meter: '4/4',
      measures: [
        {
          events: [
            { pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
            { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
            { pitches: [{ step: 'rest', octave: 4 }], duration: 'quarter' },
            { pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
          ],
        },
      ],
    }
    expect(() => validateScore(legacy)).not.toThrow()
  })

  it('accepts a mixed score (some events with kind, some without)', () => {
    // The Phase 1 rollout means callsites adopt kind incrementally.
    // A mid-rollout score may legitimately have a kind-tagged event
    // next to a legacy one. validateScore must accept this.
    const mixed = {
      key: 'C' as const,
      meter: '4/4',
      measures: [
        {
          events: [
            createNote([{ step: 'C', octave: 4 }], 'quarter'),  // new shape
            { pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' }, // legacy shape
            createRest('quarter'),
            { pitches: [{ step: 'rest', octave: 4 }], duration: 'quarter' }, // legacy rest
          ],
        },
      ],
    }
    expect(() => validateScore(mixed)).not.toThrow()
  })

  it("INTENTIONALLY accepts kind/pitches inconsistencies until PR-12 tightens (loose-contract pin)", () => {
    // The eventKind.ts doc explicitly says this state is invalid but
    // permitted to keep helpers permissive during rollout. This test
    // documents that loose-now contract so a future tightening surfaces
    // the change consciously rather than slipping in silently.
    const inconsistent = {
      key: 'C' as const,
      meter: '4/4',
      measures: [
        {
          events: [
            // kind says note, pitch says rest — accepted today.
            // Whole-note duration so the measure capacity check passes
            // and the test focuses on the kind/pitches consistency
            // (or lack thereof).
            { kind: 'note' as const, pitches: [{ step: 'rest' as const, octave: 4 }], duration: 'whole' as const },
          ],
        },
      ],
    }
    expect(() => validateScore(inconsistent)).not.toThrow()
  })
})
